// P6-06c (ADR 0085; owner answer Q6; owner condition 3 of 2026-11-13): one
// owner-role check for every invitation. ownerRoleRefusal() in
// apps/api/src/modules/invitations/owner-role.ts is the only code that
// produces the refusal code owner_role, and exactly two places call it:
// the single invite's InvitationsService.checkRow and a bulk row's
// InvitationBatchesService. The integration half (the same rows refused
// by both routes) is in modules/invitation-batches.int.test.ts.
import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, test } from "vitest";
import { ownerRoleRefusal } from "../src/modules/invitations/owner-role.js";

const SRC = join(import.meta.dirname, "../src");

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out.sort();
}

async function filesMatching(pattern: RegExp): Promise<string[]> {
  const found: string[] = [];
  for (const file of await walk(SRC)) {
    if (pattern.test(await readFile(file, "utf8"))) {
      found.push(relative(SRC, file).split("\\").join("/"));
    }
  }
  return found;
}

/** A place that yields the code: a return, a conditional, a field or a call. */
const PRODUCES = /(?:\breturn\s+|\?\s*|\bcode:\s*|\bfailed\(\s*)"owner_role"/;
/** A call of the check, not its definition. */
const CALLS = /(?<!function\s)\bownerRoleRefusal\s*\(/;

describe("one owner-role check (Q6, owner condition 3)", () => {
  test("ownerRoleRefusal(): owner_role for the owner role as org role or project role, nothing otherwise", () => {
    expect(ownerRoleRefusal({ systemKey: "owner" })).toBe("owner_role");
    expect(ownerRoleRefusal({ systemKey: null }, { systemKey: "owner" })).toBe(
      "owner_role",
    );
    expect(ownerRoleRefusal({ systemKey: "member" }, undefined)).toBe(
      undefined,
    );
    expect(ownerRoleRefusal(undefined, { systemKey: null })).toBe(undefined);
    expect(ownerRoleRefusal()).toBe(undefined);
  });

  test("only owner-role.ts produces owner_role", async () => {
    expect(await filesMatching(PRODUCES)).toEqual([
      "modules/invitations/owner-role.ts",
    ]);
  });

  test("the single invite and the bulk row both call it, and nothing else does", async () => {
    expect(await filesMatching(CALLS)).toEqual([
      "modules/invitation-batches/invitation-batches.service.ts",
      "modules/invitations/invitations.service.ts",
    ]);
  });
});
