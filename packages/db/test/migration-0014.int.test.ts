// P6-06b (ADR 0084; Done-when 18; owner conditions C1, C3, C7, C8 and
// additions A2, A5): migration 0014 against a real Postgres 18.
// - expand only: from a database at 0013 with members, a project member
//   and invitations, every old row is still there and reads as an active,
//   internal, permanent membership; a second migrate is a no-op.
// - the lifecycle columns' CHECKs (23514): the three suspension columns
//   are set together, the reason is 1..200 characters, expires_at is
//   after created_at, expired_at needs expires_at and is not before it.
// - bricx_app may UPDATE exactly the listed columns of both tables
//   (42501 on user_id, is_external, created_at) (sabotage S24).
// - the guards (SQLSTATE P606B), for every role, the superuser included:
//   is_external never changes (S26); a membership with the system owner
//   role is never temporary and never external, on INSERT, on an UPDATE
//   of expires_at and on an UPDATE of role_id (A2, S25); the same on a
//   project membership. bricx.invitations: is_external and
//   membership_expires_at never change (P6006, S27); an external
//   invitation needs a project; revoke_reason accepts inviter_suspended.
// - sites_assigned_select v2, at raw RLS level: an assigned site is
//   readable only through an ACTIVE org membership and an ACTIVE project
//   membership (S10): suspended or expired, either one, hides it.
// - the views are security_invoker, readable by bricx_app and
//   bricx_readonly only; app.external_org_keys() is EXTERNAL_ORG_KEYS.
// - app.memberships_due() and app.memberships_expiring(): bricx_relay
//   only (42501 for bricx_app), every org, the right rows, the limit.
// - app.mfa_state() is unchanged on purpose: a suspended or expired
//   member who holds a finance.* key (org or project level) or the owner
//   role keeps "MFA required"; removal still clears it.
// - the two audit_events indexes exist as declared (C7).
import { randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type BootstrappedPostgres,
  type Role,
  appDatabase,
  exampleValue,
  rolePasswordKeys,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { seedProject } from "@bricx/db-bootstrap/fixtures";
import { EXTERNAL_ORG_KEYS } from "@bricx/permissions/external";
import { sql } from "drizzle-orm";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type Database,
  type RelayDatabase,
  openDatabase,
  openRelayDatabase,
} from "../src/database.js";
import { MIGRATIONS_DIR, migrate } from "../src/migrate.js";
import { mfaState } from "../src/mfa.js";
import {
  MEMBERSHIP_APP_COLUMNS,
  PROJECT_MEMBERSHIP_APP_COLUMNS,
} from "../src/rls.js";

const NOW = "2026-11-11T12:00:00.000Z";
const CHECK = "23514";
const DENIED = "42501";
const GUARD = "P606B";

let pg18: BootstrappedPostgres;
let app: Database;
let relay: RelayDatabase;
let n = 0;
const nextId = (): string => {
  n += 1;
  return `0199e1d8-${n.toString(16).padStart(4, "0")}-7000-8000-${randomUUID().slice(-12)}`;
};

const urlFor = (role: Role) => ({
  reveal: () =>
    `postgres://${role}:${exampleValue(rolePasswordKeys[role])}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`,
});

async function asAdmin<R extends pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const admin = await pg18.admin();
  try {
    return (await admin.query<R>(text, params)).rows;
  } finally {
    await admin.end();
  }
}

/** The SQLSTATE a statement fails with ("none" when it succeeds). */
async function sqlStateOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (error) {
    let at: unknown = error;
    for (let depth = 0; depth < 5 && at !== undefined; depth += 1) {
      const code = (at as { code?: unknown }).code;
      if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
      at = (at as { cause?: unknown }).cause;
    }
    return "unknown";
  }
  return "none";
}
const adminState = (text: string, params: unknown[] = []) =>
  sqlStateOf(() => asAdmin(text, params));

/** The production migrations up to and including 0013, in a temp folder. */
async function migrationsThrough0013(): Promise<string> {
  const journal = JSON.parse(
    await readFile(path.join(MIGRATIONS_DIR, "meta/_journal.json"), "utf8"),
  ) as { entries: { idx: number; tag: string }[] };
  const entries = journal.entries.filter((e) => e.idx <= 13);
  expect(entries.at(-1)?.idx).toBe(13);
  const dir = await mkdtemp(path.join(os.tmpdir(), "bricx-0013-"));
  await mkdir(path.join(dir, "meta"));
  await writeFile(
    path.join(dir, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries }, null, 2),
  );
  for (const e of entries) {
    await copyFile(
      path.join(MIGRATIONS_DIR, `${e.tag}.sql`),
      path.join(dir, `${e.tag}.sql`),
    );
  }
  return dir;
}

const org = { a: "", b: "" };
const project = { a: "", a2: "", b: "" };
const role = { ownerA: "", crewA: "", ownerB: "", crewB: "" };
const user = {
  owner: "",
  old: "",
  oldProject: "",
  site: "",
  temp: "",
  other: "",
};
/** Rows written at 0013, before 0014 ran. */
const before = { member: "", projectMember: "", invitation: "" };

async function seedOrg(id: string, slug: string): Promise<void> {
  await asAdmin(
    `INSERT INTO bricx.organizations
       (id, slug, legal_name, country, default_currency, default_language,
        timezone, units, data_region, created_at, updated_at)
     VALUES ($1, $2, $2, 'SL', 'SLE', 'en', 'Africa/Freetown', 'metric',
        'af-south-1', $3, $3)`,
    [id, slug, NOW],
  );
}

async function seedRole(
  orgId: string,
  key: string,
  systemKey: string | null,
): Promise<string> {
  const id = nextId();
  await asAdmin(
    `INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at)
     VALUES ($1, $2, $3, $3, $4, $5, $5)`,
    [id, orgId, key, systemKey, NOW],
  );
  return id;
}

async function seedUser(label: string): Promise<string> {
  const id = nextId();
  await asAdmin(
    `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
     VALUES ($1, $2, $3, $3)`,
    [id, `m14-${label}-${id.slice(-6)}`, NOW],
  );
  return id;
}

/** One org membership as the superuser; extra columns by name. */
async function member(
  orgId: string,
  userId: string,
  roleId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = nextId();
  const names = Object.keys(extra);
  await asAdmin(
    `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at${names.map((c) => `, ${c}`).join("")})
     VALUES ($1, $2, $3, $4, $5${names.map((_, i) => `, $${String(i + 6)}`).join("")})`,
    [id, orgId, userId, roleId, NOW, ...Object.values(extra)],
  );
  return id;
}

async function projectMember(
  orgId: string,
  projectId: string,
  userId: string,
  roleId: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const id = nextId();
  const names = Object.keys(extra);
  await asAdmin(
    `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at${names.map((c) => `, ${c}`).join("")})
     VALUES ($1, $2, $3, $4, $5, $6${names.map((_, i) => `, $${String(i + 7)}`).join("")})`,
    [id, orgId, projectId, userId, roleId, NOW, ...Object.values(extra)],
  );
  return id;
}

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"), await migrationsThrough0013());
  org.a = nextId();
  org.b = nextId();
  await seedOrg(org.a, "m14-a");
  await seedOrg(org.b, "m14-b");
  role.ownerA = await seedRole(org.a, "owner", "owner");
  role.crewA = await seedRole(org.a, "crew", null);
  role.ownerB = await seedRole(org.b, "owner", "owner");
  role.crewB = await seedRole(org.b, "crew", null);
  for (const key of Object.keys(user) as (keyof typeof user)[]) {
    user[key] = await seedUser(key);
  }
  project.a = nextId();
  project.a2 = nextId();
  project.b = nextId();
  await seedProject(asAdmin, org.a, project.a);
  await seedProject(asAdmin, org.a, project.a2);
  await seedProject(asAdmin, org.b, project.b);
  // Rows of the 0013 shape: no lifecycle column exists yet.
  await member(org.a, user.owner, role.ownerA);
  before.member = await member(org.a, user.old, role.crewA);
  await member(org.a, user.oldProject, role.crewA);
  before.projectMember = await projectMember(
    org.a,
    project.a,
    user.oldProject,
    role.crewA,
  );
  before.invitation = nextId();
  await asAdmin(
    `INSERT INTO bricx.invitations
       (id, org_id, email_normalised, role_id, status, expires_at, invited_by,
        revoked_at, revoked_by, revoke_reason, created_at, updated_at)
     VALUES ($1, $2, 'old@site.example', $3, 'revoked',
        $4::timestamptz + interval '72 hours', $5, $4, $5, 'inviter_removed', $4, $4)`,
    [before.invitation, org.a, role.crewA, NOW, user.owner],
  );
  await migrate(urlFor("bricx_owner"));
  app = openDatabase(urlFor("bricx_app"));
  relay = openRelayDatabase(urlFor("bricx_relay"));
}, 300_000);
afterAll(async () => {
  await app.close().catch(() => undefined);
  await relay.close().catch(() => undefined);
  await pg18.container.stop();
});

describe("expand only: rows written before 0014", () => {
  test("an old membership, project membership and invitation are still there, active, internal and permanent; a second migrate changes nothing", async () => {
    expect(
      await asAdmin(
        `SELECT suspended_at, suspended_by, suspend_reason, expires_at, expired_at, expiry_notified_at, is_external
         FROM bricx.memberships WHERE id = $1`,
        [before.member],
      ),
    ).toEqual([
      {
        suspended_at: null,
        suspended_by: null,
        suspend_reason: null,
        expires_at: null,
        expired_at: null,
        expiry_notified_at: null,
        is_external: false,
      },
    ]);
    expect(
      await asAdmin(
        `SELECT suspended_at, suspended_by, suspend_reason, expires_at, expired_at, expiry_notified_at
         FROM bricx.project_memberships WHERE id = $1`,
        [before.projectMember],
      ),
    ).toEqual([
      {
        suspended_at: null,
        suspended_by: null,
        suspend_reason: null,
        expires_at: null,
        expired_at: null,
        expiry_notified_at: null,
      },
    ]);
    expect(
      await asAdmin(
        "SELECT revoke_reason, is_external, membership_expires_at FROM bricx.invitations WHERE id = $1",
        [before.invitation],
      ),
    ).toEqual([
      {
        revoke_reason: "inviter_removed",
        is_external: false,
        membership_expires_at: null,
      },
    ]);
    // Active in the views.
    expect(
      await asAdmin(
        "SELECT 1 FROM app.active_memberships WHERE id = $1 AND NOT is_external",
        [before.member],
      ),
    ).toHaveLength(1);
    expect(
      await asAdmin(
        "SELECT 1 FROM app.active_project_memberships WHERE id = $1",
        [before.projectMember],
      ),
    ).toHaveLength(1);
    const ledger = () =>
      asAdmin<{ r: string }>(
        "SELECT idx || ':' || tag AS r FROM bricx_migrations.applied ORDER BY idx",
      );
    const applied = await ledger();
    await migrate(urlFor("bricx_owner"));
    expect(await ledger()).toEqual(applied);
    // Applied, whatever later migrations exist (the new-module selftest
    // adds one in its worktree).
    expect(applied.map((a) => a.r)).toContain("14:0014_member_lifecycle");
  });

  test("the old revoke_reason CHECK is gone, v2 is valid and adds inviter_suspended only", async () => {
    const checks = await asAdmin<{ name: string; valid: boolean }>(
      `SELECT conname AS name, convalidated AS valid FROM pg_constraint
       WHERE conrelid = 'bricx.invitations'::regclass AND conname LIKE 'invitations_revoke_reason%'`,
    );
    expect(checks).toEqual([
      { name: "invitations_revoke_reason_v2", valid: true },
    ]);
    const id = nextId();
    const insert = (reason: string) =>
      adminState(
        `INSERT INTO bricx.invitations
           (id, org_id, email_normalised, role_id, status, expires_at, invited_by,
            revoked_at, revoked_by, revoke_reason, created_at, updated_at)
         VALUES ($1, $2, $6, $3, 'revoked', $4::timestamptz + interval '72 hours',
            $5, $4, $5, $7, $4, $4)`,
        [
          reason === "inviter_suspended" ? id : nextId(),
          org.a,
          role.crewA,
          NOW,
          user.owner,
          `${reason}@site.example`,
          reason,
        ],
      );
    expect(await insert("inviter_suspended")).toBe("none");
    expect(await insert("inviter_fired")).toBe(CHECK);
  });
});

describe("the lifecycle columns' CHECKs", () => {
  test.each(["memberships", "project_memberships"] as const)(
    "bricx.%s: suspension columns together, reason 1..200, expires_at after created_at, expired_at needs expires_at",
    async (table) => {
      const target =
        table === "memberships" ? before.member : before.projectMember;
      const set = (assignments: string, params: unknown[] = []) =>
        adminState(`UPDATE bricx.${table} SET ${assignments} WHERE id = $1`, [
          target,
          ...params,
        ]);
      // Rolled back by hand after each allowed case.
      const reset = () =>
        asAdmin(
          `UPDATE bricx.${table} SET suspended_at = NULL, suspended_by = NULL, suspend_reason = NULL, expires_at = NULL, expired_at = NULL WHERE id = $1`,
          [target],
        );
      expect(await set("suspended_at = now()")).toBe(CHECK);
      expect(await set("suspended_by = $2", [user.owner])).toBe(CHECK);
      expect(await set("suspend_reason = 'x'")).toBe(CHECK);
      expect(
        await set("suspended_at = now(), suspended_by = $2", [user.owner]),
      ).toBe(CHECK);
      expect(
        await set(
          "suspended_at = now(), suspended_by = $2, suspend_reason = ''",
          [user.owner],
        ),
      ).toBe(CHECK);
      expect(
        await set(
          "suspended_at = now(), suspended_by = $2, suspend_reason = $3",
          [user.owner, "x".repeat(201)],
        ),
      ).toBe(CHECK);
      expect(
        await set(
          "suspended_at = now(), suspended_by = $2, suspend_reason = $3",
          [user.owner, "x".repeat(200)],
        ),
      ).toBe("none");
      await reset();
      expect(await set("expires_at = created_at")).toBe(CHECK);
      expect(await set("expires_at = created_at - interval '1 second'")).toBe(
        CHECK,
      );
      expect(await set("expired_at = now()")).toBe(CHECK);
      expect(
        await set(
          "expires_at = created_at + interval '1 hour', expired_at = created_at + interval '59 minutes'",
        ),
      ).toBe(CHECK);
      expect(
        await set(
          "expires_at = created_at + interval '1 hour', expired_at = created_at + interval '1 hour'",
        ),
      ).toBe("none");
      await reset();
    },
  );

  test("bricx.invitations: an external invitation needs a project; membership_expires_at is after created_at", async () => {
    const insert = (columns: string, values: string, params: unknown[]) =>
      adminState(
        `INSERT INTO bricx.invitations
           (id, org_id, email_normalised, role_id, expires_at, invited_by, created_at, updated_at${columns})
         VALUES ($1, $2, $3, $4, $5::timestamptz + interval '72 hours', $6, $5, $5${values})`,
        [
          nextId(),
          org.a,
          `c-${String(n)}@site.example`,
          role.crewA,
          NOW,
          user.owner,
          ...params,
        ],
      );
    expect(await insert(", is_external", ", true", [])).toBe(CHECK);
    expect(
      await insert(
        ", is_external, project_id, project_role_id",
        ", true, $7, $8",
        [project.a, role.crewA],
      ),
    ).toBe("none");
    expect(await insert(", membership_expires_at", ", $5", [])).toBe(CHECK);
    expect(
      await insert(
        ", membership_expires_at",
        ", $5::timestamptz + interval '1 hour'",
        [],
      ),
    ).toBe("none");
  });
});

describe("bricx_app's column grants (S24)", () => {
  const granted = async (table: string) =>
    (
      await asAdmin<{ column_name: string }>(
        `SELECT column_name FROM information_schema.column_privileges
         WHERE table_schema = 'bricx' AND table_name = $1 AND grantee = 'bricx_app' AND privilege_type = 'UPDATE' ORDER BY 1`,
        [table],
      )
    ).map((c) => c.column_name);

  test("exactly the listed columns of both tables, and no table-wide UPDATE", async () => {
    // Written out: a change to rls.ts is a review.
    const expected = [
      "expired_at",
      "expires_at",
      "expiry_notified_at",
      "removed_at",
      "role_id",
      "suspend_reason",
      "suspended_at",
      "suspended_by",
    ];
    expect(await granted("memberships")).toEqual(expected);
    expect([...MEMBERSHIP_APP_COLUMNS].sort()).toEqual(expected);
    expect(await granted("project_memberships")).toEqual(
      [...expected, "overrides"].sort(),
    );
    expect([...PROJECT_MEMBERSHIP_APP_COLUMNS].sort()).toEqual(
      [...expected, "overrides"].sort(),
    );
    expect(
      await asAdmin(
        `SELECT has_table_privilege('bricx_app', 'bricx.memberships', 'UPDATE') AS m,
                has_table_privilege('bricx_app', 'bricx.project_memberships', 'UPDATE') AS pm`,
      ),
    ).toEqual([{ m: false, pm: false }]);
  });

  test("as bricx_app: a lifecycle column is writable in its own org; user_id, is_external, created_at and org_id are 42501", async () => {
    const ctx = { orgId: org.a, userId: user.owner, projectIds: [] };
    const run = (statement: ReturnType<typeof sql>) =>
      sqlStateOf(() => app.withTx(ctx, (tx) => tx.execute(statement)));
    expect(
      await run(
        sql`UPDATE bricx.memberships SET suspended_at = now(), suspended_by = ${user.owner}::uuid, suspend_reason = 'grant test' WHERE id = ${before.member}::uuid`,
      ),
    ).toBe("none");
    expect(
      await run(
        sql`UPDATE bricx.memberships SET suspended_at = NULL, suspended_by = NULL, suspend_reason = NULL WHERE id = ${before.member}::uuid`,
      ),
    ).toBe("none");
    for (const assignment of [
      sql`user_id = ${user.other}::uuid`,
      sql`is_external = true`,
      sql`created_at = now()`,
      sql`org_id = ${org.b}::uuid`,
      sql`id = ${nextId()}::uuid`,
    ]) {
      expect(
        await run(
          sql`UPDATE bricx.memberships SET ${assignment} WHERE id = ${before.member}::uuid`,
        ),
      ).toBe(DENIED);
    }
    for (const assignment of [
      sql`user_id = ${user.other}::uuid`,
      sql`project_id = ${project.a2}::uuid`,
      sql`created_at = now()`,
    ]) {
      expect(
        await run(
          sql`UPDATE bricx.project_memberships SET ${assignment} WHERE id = ${before.projectMember}::uuid`,
        ),
      ).toBe(DENIED);
    }
  });
});

describe("the guards (P606B, P6006), for the superuser too", () => {
  test("is_external never changes, either way (S26)", async () => {
    const internal = await member(org.a, await seedUser("g1"), role.crewA);
    const external = await member(org.a, await seedUser("g2"), role.crewA, {
      is_external: true,
    });
    expect(
      await adminState(
        "UPDATE bricx.memberships SET is_external = true WHERE id = $1",
        [internal],
      ),
    ).toBe(GUARD);
    expect(
      await adminState(
        "UPDATE bricx.memberships SET is_external = false WHERE id = $1",
        [external],
      ),
    ).toBe(GUARD);
    // Another column of the same row still moves.
    expect(
      await adminState(
        "UPDATE bricx.memberships SET removed_at = now() WHERE id = $1",
        [external],
      ),
    ).toBe("none");
  });

  test("an owner is never temporary and never external: on INSERT, on UPDATE of expires_at, and on a promotion (UPDATE of role_id) of a temporary or an external member (A2, S25)", async () => {
    const insertOwner = async (extra: Record<string, unknown>) =>
      sqlStateOf(async () =>
        member(org.a, await seedUser("g3"), role.ownerA, extra),
      );
    expect(await insertOwner({ is_external: true })).toBe(GUARD);
    expect(await insertOwner({ expires_at: "2027-01-01T00:00:00.000Z" })).toBe(
      GUARD,
    );
    expect(await insertOwner({})).toBe("none");
    const [owner] = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.memberships WHERE org_id = $1 AND user_id = $2",
      [org.a, user.owner],
    );
    expect(
      await adminState(
        "UPDATE bricx.memberships SET expires_at = now() + interval '1 day' WHERE id = $1",
        [owner?.id],
      ),
    ).toBe(GUARD);
    const temporary = await member(org.a, await seedUser("g4"), role.crewA, {
      expires_at: "2027-01-01T00:00:00.000Z",
    });
    const external = await member(org.a, await seedUser("g5"), role.crewA, {
      is_external: true,
    });
    const plainUser = await seedUser("g6");
    const plain = await member(org.a, plainUser, role.crewA);
    const promote = (id: string) =>
      adminState("UPDATE bricx.memberships SET role_id = $2 WHERE id = $1", [
        id,
        role.ownerA,
      ]);
    // The 0014 rules still answer first (P606B, not P606C) for a temporary
    // or an external member.
    expect(await promote(temporary)).toBe(GUARD);
    expect(await promote(external)).toBe(GUARD);
    // P6-06c (ADR 0085, owner answer Q6): a plain member is no longer
    // promoted to owner by a bare UPDATE, not even by the superuser ...
    expect(await promote(plain)).toBe("P606C");
    // ... only through the sanctioned path: the same transaction accepts an
    // ownership transfer to that member, as the recipient (the control).
    const transfer = nextId();
    await asAdmin(
      `INSERT INTO bricx.ownership_transfers
         (id, org_id, initiated_by, to_user_id, previous_owner_role_id, expires_at, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now() + interval '1 day', now(), now())`,
      [transfer, org.a, user.owner, plainUser, role.crewA],
    );
    expect(
      await sqlStateOf(() =>
        app.withTx(
          { orgId: org.a, userId: plainUser, projectIds: [] },
          async (tx) => {
            await tx.execute(
              sql`UPDATE bricx.ownership_transfers SET status = 'accepted', settled_by = ${plainUser}::uuid, settled_at = now(), updated_at = now() WHERE id = ${transfer}::uuid`,
            );
            await tx.execute(
              sql`UPDATE bricx.memberships SET role_id = ${role.ownerA}::uuid WHERE id = ${plain}::uuid`,
            );
          },
        ),
      ),
    ).toBe("none");
    const [promoted] = await asAdmin<{ owner: boolean }>(
      `SELECT r.system_key = 'owner' AS owner FROM bricx.memberships m
         JOIN bricx.roles r ON r.org_id = m.org_id AND r.id = m.role_id
        WHERE m.id = $1`,
      [plain],
    );
    expect(promoted?.owner).toBe(true);
    // As bricx_app the promotion is refused the same way.
    expect(
      await sqlStateOf(() =>
        app.withTx({ orgId: org.a, userId: user.owner, projectIds: [] }, (tx) =>
          tx.execute(
            sql`UPDATE bricx.memberships SET role_id = ${role.ownerA}::uuid WHERE id = ${temporary}::uuid`,
          ),
        ),
      ),
    ).toBe(GUARD);
    // A temporary or external member with any other role is fine, and a
    // role the statement names that does not exist in the org is refused.
    expect(
      await adminState(
        "UPDATE bricx.memberships SET role_id = $2 WHERE id = $1",
        [temporary, role.crewA],
      ),
    ).toBe("none");
  });

  test("a project membership with the owner role is never temporary, and never an external member's", async () => {
    const externalUser = await seedUser("g7");
    await member(org.a, externalUser, role.crewA, { is_external: true });
    const internalUser = await seedUser("g8");
    await member(org.a, internalUser, role.crewA);
    expect(
      await sqlStateOf(() =>
        projectMember(org.a, project.a, externalUser, role.ownerA),
      ),
    ).toBe(GUARD);
    expect(
      await sqlStateOf(() =>
        projectMember(org.a, project.a, internalUser, role.ownerA, {
          expires_at: "2027-01-01T00:00:00.000Z",
        }),
      ),
    ).toBe(GUARD);
    const row = await projectMember(
      org.a,
      project.a,
      internalUser,
      role.crewA,
      { expires_at: "2027-01-01T00:00:00.000Z" },
    );
    expect(
      await adminState(
        "UPDATE bricx.project_memberships SET role_id = $2 WHERE id = $1",
        [row, role.ownerA],
      ),
    ).toBe(GUARD);
    expect(
      await sqlStateOf(() =>
        projectMember(org.a, project.a2, externalUser, role.crewA),
      ),
    ).toBe("none");
  });

  test("bricx.invitations: is_external and membership_expires_at never change while pending (P6006, S27)", async () => {
    const id = nextId();
    await asAdmin(
      `INSERT INTO bricx.invitations
         (id, org_id, project_id, project_role_id, email_normalised, role_id, expires_at, invited_by, created_at, updated_at, is_external, membership_expires_at)
       VALUES ($1, $2, $3, $4, 'guard@site.example', $4, $5::timestamptz + interval '72 hours', $6, $5, $5, true, $5::timestamptz + interval '30 days')`,
      [id, org.a, project.a, role.crewA, NOW, user.owner],
    );
    for (const assignment of [
      "is_external = false",
      "membership_expires_at = membership_expires_at + interval '1 day'",
      "membership_expires_at = NULL",
    ]) {
      expect(
        await adminState(
          `UPDATE bricx.invitations SET ${assignment} WHERE id = $1`,
          [id],
        ),
      ).toBe("P6006");
    }
    // A mutable column still moves.
    expect(
      await adminState(
        "UPDATE bricx.invitations SET resend_count = resend_count + 1 WHERE id = $1",
        [id],
      ),
    ).toBe("none");
  });
});

describe("sites_assigned_select v2, at raw RLS level (C1, S10)", () => {
  test("an assigned site is read only through an ACTIVE org membership and an ACTIVE project membership: suspended or expired, either one, hides it", async () => {
    const site = nextId();
    await asAdmin(
      `INSERT INTO bricx.sites (id, org_id, project_id, name, created_by, created_at, updated_at)
       VALUES ($1, $2, $3, 'm14 site', $4, $5, $5)`,
      [site, org.a, project.a, user.owner, NOW],
    );
    const orgRow = await member(org.a, user.site, role.crewA);
    const projectRow = await projectMember(
      org.a,
      project.a,
      user.site,
      role.crewA,
    );
    await asAdmin(
      `INSERT INTO bricx.project_membership_sites
         (id, org_id, project_id, project_membership_id, user_id, site_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [nextId(), org.a, project.a, projectRow, user.site, site, NOW],
    );
    // No project in app.project_ids: only the assigned-site policy can
    // show the row.
    const seen = () =>
      app.withTx(
        { orgId: org.a, userId: user.site, projectIds: [] },
        async (tx) =>
          (
            await tx.execute<{ id: string }>(
              sql`SELECT id::text FROM bricx.sites WHERE id = ${site}::uuid`,
            )
          ).rows.map((r) => r.id),
      );
    const suspend = (table: string, id: string) =>
      asAdmin(
        `UPDATE bricx.${table} SET suspended_at = now(), suspended_by = $2, suspend_reason = 'rls' WHERE id = $1`,
        [id, user.owner],
      );
    const clear = (table: string, id: string) =>
      asAdmin(
        `UPDATE bricx.${table} SET suspended_at = NULL, suspended_by = NULL, suspend_reason = NULL, expires_at = NULL WHERE id = $1`,
        [id],
      );
    // created_at is NOW (in the past for the database clock), so an
    // expires_at a minute after it has passed.
    const expire = (table: string, id: string) =>
      asAdmin(
        `UPDATE bricx.${table} SET expires_at = created_at + interval '1 minute' WHERE id = $1`,
        [id],
      );
    expect(await seen()).toEqual([site]);
    await suspend("project_memberships", projectRow);
    expect(await seen()).toEqual([]);
    await clear("project_memberships", projectRow);
    expect(await seen()).toEqual([site]);
    await suspend("memberships", orgRow);
    expect(await seen()).toEqual([]);
    await clear("memberships", orgRow);
    expect(await seen()).toEqual([site]);
    await expire("project_memberships", projectRow);
    expect(await seen()).toEqual([]);
    await clear("project_memberships", projectRow);
    await expire("memberships", orgRow);
    expect(await seen()).toEqual([]);
    await clear("memberships", orgRow);
    // An end still ahead does not hide it.
    await asAdmin(
      "UPDATE bricx.project_memberships SET expires_at = now() + interval '1 hour' WHERE id = $1",
      [projectRow],
    );
    expect(await seen()).toEqual([site]);
  });
});

describe("the views and app.external_org_keys()", () => {
  test("four security_invoker views; SELECT for bricx_app and bricx_readonly only", async () => {
    const views = await asAdmin<{ name: string; options: string[] | null }>(
      `SELECT c.relname AS name, c.reloptions AS options FROM pg_class c
       WHERE c.relnamespace = 'app'::regnamespace AND c.relkind = 'v' ORDER BY 1`,
    );
    expect(views).toEqual(
      [
        "active_memberships",
        "active_project_memberships",
        "user_grants_source",
        "user_project_access",
      ].map((name) => ({ name, options: ["security_invoker=true"] })),
    );
    const grants = await asAdmin<{ v: string; role: string }>(
      `SELECT c.relname AS v, r.rolname AS role FROM pg_class c, pg_roles r
       WHERE c.relnamespace = 'app'::regnamespace AND c.relkind = 'v'
         AND r.rolname IN ('bricx_app', 'bricx_readonly', 'bricx_relay', 'powersync_repl', 'bricx_owner')
         AND r.rolname <> pg_get_userbyid(c.relowner)
         AND has_table_privilege(r.oid, c.oid, 'SELECT')
       ORDER BY 1, 2`,
    );
    expect([...new Set(grants.map((g) => g.role))].sort()).toEqual([
      "bricx_app",
      "bricx_readonly",
    ]);
    expect(grants).toHaveLength(8);
    expect(
      await asAdmin(
        `SELECT 1 FROM pg_class c
         WHERE c.relnamespace = 'app'::regnamespace AND c.relkind = 'v'
           AND (has_table_privilege('bricx_app', c.oid, 'INSERT') OR has_table_privilege('bricx_app', c.oid, 'UPDATE') OR has_table_privilege('bricx_app', c.oid, 'DELETE'))`,
      ),
    ).toEqual([]);
  });

  test("app.external_org_keys() is @bricx/permissions EXTERNAL_ORG_KEYS; EXECUTE for bricx_app and bricx_readonly", async () => {
    const [row] = await asAdmin<{ keys: string[] }>(
      "SELECT app.external_org_keys() AS keys",
    );
    expect([...(row?.keys ?? [])].sort()).toEqual(
      [...EXTERNAL_ORG_KEYS].sort(),
    );
    expect(row?.keys.some((key) => key.startsWith("finance."))).toBe(false);
    expect(
      await asAdmin(
        `SELECT r.rolname AS role FROM pg_roles r
         WHERE r.rolname IN ('bricx_app', 'bricx_readonly', 'bricx_relay', 'powersync_repl')
           AND has_function_privilege(r.oid, 'app.external_org_keys()', 'EXECUTE') ORDER BY 1`,
      ),
    ).toEqual([{ role: "bricx_app" }, { role: "bricx_readonly" }]);
    expect(
      await asAdmin(
        "SELECT has_function_privilege('public', 'app.external_org_keys()', 'EXECUTE') AS ok",
      ),
    ).toEqual([{ ok: false }]);
  });
});

describe("app.memberships_due() and app.memberships_expiring(): the relay's reads", () => {
  test("SECURITY DEFINER, pinned search_path, EXECUTE for bricx_relay only; bricx_app is 42501", async () => {
    const rows = await asAdmin<{
      sig: string;
      definer: boolean;
      config: string[] | null;
      volatility: string;
    }>(
      `SELECT p.oid::regprocedure::text AS sig, p.prosecdef AS definer, p.proconfig AS config, p.provolatile AS volatility
       FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace AND p.proname LIKE 'memberships_%' ORDER BY 1`,
    );
    expect(rows).toEqual([
      {
        sig: "app.memberships_due(integer)",
        definer: true,
        config: ["search_path=pg_catalog, pg_temp"],
        volatility: "s",
      },
      {
        sig: "app.memberships_expiring(integer,integer)",
        definer: true,
        config: ["search_path=pg_catalog, pg_temp"],
        volatility: "s",
      },
    ]);
    for (const sig of rows.map((r) => r.sig)) {
      expect(
        await asAdmin(
          `SELECT r.rolname AS role FROM pg_roles r
           WHERE r.rolname IN ('bricx_app', 'bricx_readonly', 'bricx_relay', 'powersync_repl')
             AND has_function_privilege(r.oid, $1, 'EXECUTE') ORDER BY 1`,
          [sig],
        ),
      ).toEqual([{ role: "bricx_relay" }]);
    }
    const ctx = { orgId: org.a, userId: user.owner, projectIds: [] };
    expect(
      await sqlStateOf(() =>
        app.withTx(ctx, (tx) =>
          tx.execute(sql`SELECT * FROM app.memberships_due(10)`),
        ),
      ),
    ).toBe(DENIED);
    expect(
      await sqlStateOf(() =>
        app.withTx(ctx, (tx) =>
          tx.execute(sql`SELECT * FROM app.memberships_expiring(7, 10)`),
        ),
      ),
    ).toBe(DENIED);
  });

  test("due: open rows past expires_at with no expired_at, both kinds, every org, oldest first, capped; expiring: within the window, no notice yet", async () => {
    const mk = async (
      orgId: string,
      roleId: string,
      extra: Record<string, unknown>,
    ) => member(orgId, await seedUser("d"), roleId, extra);
    const past = (minutes: number) =>
      new Date(Date.parse(NOW) + minutes * 60_000).toISOString();
    const ahead = (days: number) =>
      new Date(Date.now() + days * 86_400_000).toISOString();
    const dueA = await mk(org.a, role.crewA, { expires_at: past(1) });
    const dueB = await mk(org.b, role.crewB, { expires_at: past(2) });
    const projectUser = await seedUser("dp");
    await member(org.a, projectUser, role.crewA);
    const dueProject = await projectMember(
      org.a,
      project.a,
      projectUser,
      role.crewA,
      { expires_at: past(3) },
    );
    // Not due: recorded already, removed, permanent, still ahead.
    await mk(org.a, role.crewA, { expires_at: past(1), expired_at: past(1) });
    await mk(org.a, role.crewA, { expires_at: past(1), removed_at: past(5) });
    await mk(org.a, role.crewA, {});
    const soon = await mk(org.a, role.crewA, { expires_at: ahead(3) });
    const soonB = await mk(org.b, role.crewB, { expires_at: ahead(6) });
    const notified = await mk(org.a, role.crewA, {
      expires_at: ahead(2),
      expiry_notified_at: past(0),
    });
    const later = await mk(org.a, role.crewA, { expires_at: ahead(30) });
    // Rows of this test only (other tests leave temporary rows behind).
    const mine = new Set([
      dueA,
      dueB,
      dueProject,
      soon,
      soonB,
      notified,
      later,
    ]);
    const all = (statement: ReturnType<typeof sql>) =>
      relay.withRelayTx(
        async (tx) =>
          (
            await tx.execute<{ kind: string; id: string; org_id: string }>(
              statement,
            )
          ).rows,
      );
    const read = async (statement: ReturnType<typeof sql>) =>
      (await all(statement)).filter((row) => mine.has(row.id));
    const due = await read(
      sql`SELECT kind, id::text, org_id::text FROM app.memberships_due(100)`,
    );
    // Oldest expiry first (NOW + 1, 2 and 3 minutes).
    expect(due).toEqual([
      { kind: "org", id: dueA, org_id: org.a },
      { kind: "org", id: dueB, org_id: org.b },
      { kind: "project", id: dueProject, org_id: org.a },
    ]);
    // The limit: dueA is the oldest due row of the whole database.
    expect(
      await all(
        sql`SELECT kind, id::text, org_id::text FROM app.memberships_due(1)`,
      ),
    ).toEqual([{ kind: "org", id: dueA, org_id: org.a }]);
    for (const limit of [0, -5, null]) {
      expect(
        await all(
          sql`SELECT kind, id::text, org_id::text FROM app.memberships_due(${limit}::integer)`,
        ),
      ).toEqual([]);
    }
    const expiring = await read(
      sql`SELECT kind, id::text, org_id::text FROM app.memberships_expiring(7, 100)`,
    );
    expect(expiring.map((r) => r.id)).toEqual([soon, soonB]);
    expect(expiring.map((r) => r.id)).not.toContain(notified);
    expect(expiring.map((r) => r.id)).not.toContain(later);
    expect(
      (
        await read(
          sql`SELECT kind, id::text, org_id::text FROM app.memberships_expiring(45, 100)`,
        )
      ).map((r) => r.id),
    ).toEqual([soon, soonB, later]);
    // The window is clamped to 1..90 days.
    expect(
      (
        await read(
          sql`SELECT kind, id::text, org_id::text FROM app.memberships_expiring(0, 100)`,
        )
      ).map((r) => r.id),
    ).toEqual([]);
  });
});

describe("audit_events indexes for the member activity read (C7)", () => {
  test("two narrow indexes, org_id first and seq last, as declared", async () => {
    const indexes = await asAdmin<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'bricx' AND tablename = 'audit_events' AND indexname LIKE 'audit_events_by_%' ORDER BY 1`,
    );
    expect(indexes).toEqual([
      {
        indexname: "audit_events_by_actor",
        indexdef:
          "CREATE INDEX audit_events_by_actor ON bricx.audit_events USING btree (org_id, actor_id, seq DESC NULLS LAST)",
      },
      {
        indexname: "audit_events_by_entity",
        indexdef:
          "CREATE INDEX audit_events_by_entity ON bricx.audit_events USING btree (org_id, entity_type, entity_id, seq DESC NULLS LAST)",
      },
    ]);
    const [table] = await asAdmin<{ kind: string }>(
      "SELECT relkind AS kind FROM pg_class WHERE oid = 'bricx.audit_events'::regclass",
    );
    // Not partitioned today (ADR 0084 records the consequence).
    expect(table?.kind).toBe("r");
  });
});

describe("app.mfa_state() is unchanged: suspended and expired members keep MFA required (ADR 0084)", () => {
  test("suspended owner, suspended or expired finance member at org and project level: required; removed: not required", async () => {
    const financeA = await seedRole(org.a, "finance_m14", null);
    await asAdmin(
      "INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at) VALUES ($1, $2, $3, $4, $5)",
      [nextId(), org.a, financeA, "finance.budget.read.org", NOW],
    );
    const later = new Date(Date.parse(NOW) + 3_600_000).toISOString();
    const suspension = {
      suspended_at: later,
      suspended_by: user.owner,
      suspend_reason: "Site access review",
    };
    const temporary = {
      expires_at: later,
      expired_at: new Date(Date.parse(NOW) + 7_200_000).toISOString(),
    };
    const required = async (userId: string) =>
      (await relay.withRelayTx((tx) => mfaState(tx, userId)))?.required;

    // Owner suspended (owner is never temporary: P606B).
    const ownerB = await seedUser("mfa-owner");
    await member(org.b, ownerB, role.ownerB, suspension);
    expect(await required(ownerB)).toBe(true);

    // Finance key at org level, suspended; then expired.
    const suspendedOrg = await seedUser("mfa-so");
    await member(org.a, suspendedOrg, financeA, suspension);
    expect(await required(suspendedOrg)).toBe(true);
    const expiredOrg = await seedUser("mfa-eo");
    await member(org.a, expiredOrg, financeA, temporary);
    expect(await required(expiredOrg)).toBe(true);

    // Finance key at project level only, suspended; then expired.
    const suspendedProject = await seedUser("mfa-sp");
    await member(org.a, suspendedProject, role.crewA);
    await projectMember(
      org.a,
      project.a,
      suspendedProject,
      financeA,
      suspension,
    );
    expect(await required(suspendedProject)).toBe(true);
    const expiredProject = await seedUser("mfa-ep");
    await member(org.a, expiredProject, role.crewA);
    await projectMember(org.a, project.a, expiredProject, financeA, temporary);
    expect(await required(expiredProject)).toBe(true);

    // Control: removal clears it, as before 0014.
    const removed = await seedUser("mfa-r");
    await member(org.a, removed, financeA, { removed_at: later });
    expect(await required(removed)).toBe(false);
  });
});
