// P6-06b (ADR 0084; Done-when DW7; owner condition C1): every reader of
// "an open membership" (removed_at IS NULL on bricx.memberships or
// bricx.project_memberships) in application code is listed here and
// classified, so a suspended or expired member cannot keep access through
// a reader nobody looked at:
// - ACTIVE readers decide access. Each must also require "not suspended
//   and not expired" within the same statement (the lifecycle marker
//   follows the removed_at test within a few lines);
// - OPEN readers manage the rows themselves (lists that show a suspended
//   member as suspended, the write paths that find the row to change, the
//   "role still in use" count): they must NOT filter on the lifecycle, or
//   an admin could not see or reactivate a suspended member.
// A new reader, or one that changes class, fails this test until the
// registry (and ADR 0084's reader table) is updated. The SQL side (RLS
// helpers, policies, the stream-source views, the due functions) is
// proven against the database in packages/db migration-0014.int.test.ts
// and apps/api stream-sources.int.test.ts.
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const ROOT = join(import.meta.dirname, "../../..");
/** Where application code may read memberships. */
const SCANNED = [
  "apps/api/src",
  "apps/worker/src",
  "packages/db/src",
  "tooling/db-bootstrap/src",
];
/** The table definitions themselves are not readers. */
const SKIPPED = ["packages/db/src/schema/"];
const READER =
  /\b(?:memberships|projectMemberships)\.removedAt\b|\b(?:m|pm)\.removed_at IS NULL\b/;
const LIFECYCLE =
  /suspended_at|suspendedAt|activeMembershipSql|expired_at IS NULL/;
/** Lines after a reader line in which its lifecycle test must appear. */
const WINDOW = 3;

interface Entry {
  /** Reader statements that decide access (lifecycle-filtered). */
  readonly active: number;
  /** Reader statements that manage open rows (not lifecycle-filtered). */
  readonly open: number;
  readonly why: string;
}

const REGISTRY: Readonly<Record<string, Entry>> = {
  "apps/api/src/common/auth/grants-source.ts": {
    active: 2,
    open: 0,
    why: "accessRowsFor: the org membership and the project memberships every request, the SoD approver search and the invitation inviter check are computed from",
  },
  "apps/api/src/modules/sod/sod.service.ts": {
    active: 1,
    open: 0,
    why: "approvalState: the approver candidates",
  },
  "packages/db/src/memberships.ts": {
    active: 1,
    open: 2,
    why: "expireMembership finds the open, not yet expired row (active: expired_at IS NULL); the two is_external sub-selects read the org row of a project membership being expired, whatever its state",
  },
  "apps/api/src/modules/roles/roles.repository.ts": {
    active: 0,
    open: 2,
    why: "the 'role still in use' count before a role is archived: a suspended member still holds the role",
  },
  "apps/api/src/modules/memberships/memberships.repository.ts": {
    active: 5,
    open: 26,
    why: "the module that owns the rows. OPEN: the lists (the status is shown), find-to-change, the renew, remove and insert writes, and accessRowsOf, which returns the lifecycle columns for its callers to judge at the Clock (assertMember, requiresMfa). ACTIVE: the suspend and reactivate writes (guarded on suspended_at) and the active-owner count",
  },
};

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

async function scan(): Promise<
  Record<string, { active: number; open: number }>
> {
  const found: Record<string, { active: number; open: number }> = {};
  for (const dir of SCANNED) {
    for (const file of await walk(join(ROOT, dir))) {
      const name = relative(ROOT, file).split("\\").join("/");
      if (SKIPPED.some((skip) => name.startsWith(skip))) continue;
      const lines = (await readFile(file, "utf8")).split("\n");
      lines.forEach((line, i) => {
        // A comment describing a reader is not one.
        if (/^\s*(\/\/|\*|\/\*)/.test(line) || !READER.test(line)) return;
        const window = lines.slice(i, i + 1 + WINDOW).join("\n");
        const entry = (found[name] ??= { active: 0, open: 0 });
        if (LIFECYCLE.test(window)) entry.active += 1;
        else entry.open += 1;
      });
    }
  }
  return found;
}

describe("the readers of an open membership (C1)", () => {
  test("every reader in application code is in the registry, with its class: ACTIVE readers carry the lifecycle test, OPEN readers do not", async () => {
    const found = await scan();
    expect(found).toEqual(
      Object.fromEntries(
        Object.entries(REGISTRY).map(([file, e]) => [
          file,
          { active: e.active, open: e.open },
        ]),
      ),
    );
  });

  test("the access path's readers are ACTIVE only: the grants source and the approver search have no unfiltered read", () => {
    for (const file of [
      "apps/api/src/common/auth/grants-source.ts",
      "apps/api/src/modules/sod/sod.service.ts",
    ]) {
      expect(REGISTRY[file]?.open, file).toBe(0);
      expect(REGISTRY[file]?.active, file).toBeGreaterThan(0);
    }
    for (const entry of Object.values(REGISTRY)) {
      expect(entry.why.length).toBeGreaterThan(20);
    }
  });
});
