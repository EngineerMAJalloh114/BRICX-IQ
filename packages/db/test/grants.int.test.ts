// P5-05 (ADR 0066; owner conditions 1 and 4): the four grants tables and
// app.mfa_state() against compose.yml's Postgres with the production
// journal, applied by the real migrator as bricx_owner.
// - bricx.roles (org.role), bricx.role_permissions (org.role),
//   bricx.memberships (org.member), bricx.project_memberships
//   (project.member): tenant tables (rls.int.test.ts proves the tenant
//   policies); here their columns, checks, partial uniques and the
//   composite (org_id, role_id) foreign keys, so a membership never names
//   another org's role.
// - app.mfa_state(p_user): SECURITY DEFINER, owned by bricx_owner, pinned
//   search_path, EXECUTE for bricx_relay only (condition 1): one row
//   (keycloak_sub, required) for a known user, none for an unknown one.
//   `required` is true when any open org or project membership, in any
//   org, holds a finance.* key: a role with system_key 'owner' (the code's
//   ROLES.owner bundle, which holds finance keys), an open role_permissions
//   row, or a project override's `add` not taken back by its `remove`.
// - bricx_app cannot call it (42501) and gets no benefit from the owner
//   policies it reads through (condition 4); bricx_relay has no grant on
//   the tables themselves.
import { randomUUID } from "node:crypto";
import {
  type BootstrappedPostgres,
  type Role,
  appDatabase,
  exampleValue,
  rolePasswordKeys,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { ROLES, ROLE_IDS } from "@bricx/permissions/roles";
import { PgDialect } from "drizzle-orm/pg-core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type Database,
  type RelayDatabase,
  openDatabase,
  openRelayDatabase,
  sqlstateOf,
} from "../src/database.js";
import { MfaStateError, mfaState } from "../src/mfa.js";
import { migrate } from "../src/migrate.js";
import { OWNER_READ_TABLES } from "../src/rls.js";
import {
  type TxContext,
  contextStatement,
  validateTxContext,
} from "../src/tx.js";

const ORG_A = "0199e1a0-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1a0-0000-7000-8000-0000000000b1";
const PROJECT = "0199e1a0-0000-7000-8000-0000000000a3";
const T0 = "2026-10-21T09:00:00.000Z";
const T1 = "2026-10-21T09:05:00.000Z";
const DENIED = "42501";
const FK = "23503";
const CHECK = "23514";
const UNIQUE = "23505";
const dialect = new PgDialect();

let pg18: BootstrappedPostgres;
let relay: RelayDatabase;
let app: Database;
let n = 0;
/** A UUIDv7-shaped id (version 7, variant 10), unique per call. */
const nextId = (): string => {
  n += 1;
  return `0199e1a0-${n.toString(16).padStart(4, "0")}-7000-8000-${randomUUID().slice(-12)}`;
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

/** "ok:<rowCount>" or the SQLSTATE, as the test superuser, rolled back. */
async function adminOutcome(text: string, params: unknown[] = []) {
  const admin = await pg18.admin();
  try {
    await admin.query("BEGIN");
    try {
      const r = await admin.query(text, params);
      return `ok:${String(r.rowCount)}`;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        return String(error.code);
      }
      throw error;
    } finally {
      await admin.query("ROLLBACK");
    }
  } finally {
    await admin.end();
  }
}

/** Runs `run` as `who`, in a rolled-back transaction, with withTx()'s context. */
async function inTx<T>(
  who: Role,
  ctx: TxContext | undefined,
  run: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = await pg18.connectAs(who);
  try {
    await client.query("BEGIN");
    try {
      if (ctx !== undefined) {
        const q = dialect.sqlToQuery(
          contextStatement(validateTxContext(ctx), 30_000),
        );
        await client.query(q.sql, q.params);
      }
      return await run(client);
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}

// The fixture: users U*, roles in org A (and one in org B), memberships.
const users = {
  owner: nextId(),
  viewer: nextId(),
  finance: nextId(),
  none: nextId(),
  projectAdd: nextId(),
  projectRemoved: nextId(),
  revoked: nextId(),
  removedOwner: nextId(),
  ownerInB: nextId(),
  archivedRole: nextId(),
} as const;
const roles = {
  owner: nextId(),
  viewer: nextId(),
  finance: nextId(),
  financeRevoked: nextId(),
  ownerB: nextId(),
  financeArchived: nextId(),
} as const;

async function insertUser(id: string) {
  await asAdmin(
    "INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at) VALUES ($1, $2, $3, $3)",
    [id, `sub-${id}`, T0],
  );
}
async function insertRole(
  id: string,
  org: string,
  key: string,
  systemKey: string | null,
  archivedAt: string | null = null,
) {
  await asAdmin(
    "INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at, archived_at) VALUES ($1, $2, $3, $3, $4, $5, $5, $6)",
    [id, org, key, systemKey, T0, archivedAt],
  );
}
async function insertPermission(
  roleId: string,
  org: string,
  permission: string,
  revokedAt: string | null = null,
) {
  await asAdmin(
    "INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [nextId(), org, roleId, permission, T0, revokedAt],
  );
}
async function insertMembership(
  userId: string,
  org: string,
  roleId: string,
  removedAt: string | null = null,
) {
  await asAdmin(
    "INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at, removed_at) VALUES ($1, $2, $3, $4, $5, $6)",
    [nextId(), org, userId, roleId, T0, removedAt],
  );
}
async function insertProjectMembership(
  userId: string,
  org: string,
  roleId: string,
  overrides: unknown,
) {
  await asAdmin(
    "INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, overrides, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)",
    [nextId(), org, PROJECT, userId, roleId, JSON.stringify(overrides), T0],
  );
}

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"));
  relay = openRelayDatabase(urlFor("bricx_relay"));
  app = openDatabase(urlFor("bricx_app"));
  for (const id of Object.values(users)) await insertUser(id);
  await insertRole(roles.owner, ORG_A, "owner", "owner");
  await insertRole(roles.viewer, ORG_A, "viewer", null);
  await insertRole(roles.finance, ORG_A, "finance", null);
  await insertRole(roles.financeRevoked, ORG_A, "finance_revoked", null);
  await insertRole(roles.ownerB, ORG_B, "owner", "owner");
  await insertRole(roles.financeArchived, ORG_A, "finance_old", null, T1);
  await insertPermission(roles.viewer, ORG_A, "project.task.read.org");
  await insertPermission(roles.finance, ORG_A, "project.task.read.org");
  await insertPermission(roles.finance, ORG_A, "finance.budget.read.org");
  await insertPermission(
    roles.financeRevoked,
    ORG_A,
    "finance.budget.read.org",
    T1,
  );
  await insertPermission(
    roles.financeArchived,
    ORG_A,
    "finance.budget.read.org",
  );
  await insertMembership(users.owner, ORG_A, roles.owner);
  await insertMembership(users.viewer, ORG_A, roles.viewer);
  await insertMembership(users.finance, ORG_A, roles.finance);
  await insertMembership(users.revoked, ORG_A, roles.financeRevoked);
  await insertMembership(users.removedOwner, ORG_A, roles.owner, T1);
  await insertMembership(users.ownerInB, ORG_A, roles.viewer);
  await insertMembership(users.ownerInB, ORG_B, roles.ownerB);
  await insertMembership(users.archivedRole, ORG_A, roles.financeArchived);
  await insertMembership(users.projectAdd, ORG_A, roles.viewer);
  await insertProjectMembership(users.projectAdd, ORG_A, roles.viewer, {
    add: ["finance.budget.read.project"],
  });
  await insertMembership(users.projectRemoved, ORG_A, roles.viewer);
  await insertProjectMembership(users.projectRemoved, ORG_A, roles.finance, {
    remove: ["finance.budget.read.org"],
  });
});
afterAll(async () => {
  await relay.close();
  await app.close();
  await pg18.container.stop();
});

describe("the four tables (P5-05, ADR 0066)", () => {
  test("columns, as the schema declares them", async () => {
    const columns = await asAdmin<{
      t: string;
      c: string;
      ty: string;
      nn: boolean;
    }>(`
      SELECT table_name AS t, column_name AS c, data_type AS ty, is_nullable = 'NO' AS nn
      FROM information_schema.columns
      WHERE table_schema = 'bricx'
        AND table_name IN ('roles', 'role_permissions', 'memberships', 'project_memberships')
      ORDER BY table_name, ordinal_position`);
    const tz = "timestamp with time zone";
    expect(columns).toEqual([
      { t: "memberships", c: "id", ty: "uuid", nn: true },
      { t: "memberships", c: "org_id", ty: "uuid", nn: true },
      { t: "memberships", c: "user_id", ty: "uuid", nn: true },
      { t: "memberships", c: "role_id", ty: "uuid", nn: true },
      { t: "memberships", c: "created_at", ty: tz, nn: true },
      { t: "memberships", c: "removed_at", ty: tz, nn: false },
      { t: "project_memberships", c: "id", ty: "uuid", nn: true },
      { t: "project_memberships", c: "org_id", ty: "uuid", nn: true },
      { t: "project_memberships", c: "project_id", ty: "uuid", nn: true },
      { t: "project_memberships", c: "user_id", ty: "uuid", nn: true },
      { t: "project_memberships", c: "role_id", ty: "uuid", nn: true },
      { t: "project_memberships", c: "overrides", ty: "jsonb", nn: true },
      { t: "project_memberships", c: "created_at", ty: tz, nn: true },
      { t: "project_memberships", c: "removed_at", ty: tz, nn: false },
      { t: "role_permissions", c: "id", ty: "uuid", nn: true },
      { t: "role_permissions", c: "org_id", ty: "uuid", nn: true },
      { t: "role_permissions", c: "role_id", ty: "uuid", nn: true },
      { t: "role_permissions", c: "permission", ty: "text", nn: true },
      { t: "role_permissions", c: "granted_at", ty: tz, nn: true },
      { t: "role_permissions", c: "revoked_at", ty: tz, nn: false },
      { t: "roles", c: "id", ty: "uuid", nn: true },
      { t: "roles", c: "org_id", ty: "uuid", nn: true },
      { t: "roles", c: "key", ty: "text", nn: true },
      { t: "roles", c: "name", ty: "text", nn: true },
      { t: "roles", c: "system_key", ty: "text", nn: false },
      { t: "roles", c: "created_at", ty: tz, nn: true },
      { t: "roles", c: "updated_at", ty: tz, nn: true },
      { t: "roles", c: "archived_at", ty: tz, nn: false },
    ]);
  });

  test("the foreign keys are composite on (org_id, role_id) -> roles (org_id, id), plus user_id -> users; no project FK (P6-05)", async () => {
    const fks = await asAdmin<{ child: string; def: string }>(`
      SELECT c.conrelid::regclass::text AS child, pg_get_constraintdef(c.oid) AS def
      FROM pg_constraint c
      WHERE c.contype = 'f' AND c.conrelid::regclass::text IN
        ('bricx.role_permissions', 'bricx.memberships', 'bricx.project_memberships')
      ORDER BY 1, 2`);
    expect(fks).toEqual([
      {
        child: "bricx.memberships",
        def: "FOREIGN KEY (org_id, role_id) REFERENCES bricx.roles(org_id, id)",
      },
      {
        child: "bricx.memberships",
        def: "FOREIGN KEY (user_id) REFERENCES bricx.users(id)",
      },
      {
        child: "bricx.project_memberships",
        def: "FOREIGN KEY (org_id, role_id) REFERENCES bricx.roles(org_id, id)",
      },
      {
        child: "bricx.project_memberships",
        def: "FOREIGN KEY (user_id) REFERENCES bricx.users(id)",
      },
      {
        child: "bricx.role_permissions",
        def: "FOREIGN KEY (org_id, role_id) REFERENCES bricx.roles(org_id, id)",
      },
    ]);
  });

  test("a membership naming another org's role is refused by the FK (23503)", async () => {
    expect(
      await adminOutcome(
        "INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at) VALUES ($1, $2, $3, $4, $5)",
        [nextId(), ORG_B, users.none, roles.owner, T0],
      ),
    ).toBe(FK);
    expect(
      await adminOutcome(
        "INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [nextId(), ORG_B, PROJECT, users.none, roles.owner, T0],
      ),
    ).toBe(FK);
    expect(
      await adminOutcome(
        "INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at) VALUES ($1, $2, $3, $4, $5)",
        [nextId(), ORG_B, roles.owner, "project.task.read.org", T0],
      ),
    ).toBe(FK);
  });

  test("the partial unique indexes cover open rows only", async () => {
    const indexes = await asAdmin<{ def: string }>(`
      SELECT pg_get_indexdef(i.indexrelid) AS def
      FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
      WHERE i.indisunique AND NOT i.indisprimary
        AND c.relnamespace = 'bricx'::regnamespace
        AND c.relname IN ('roles', 'role_permissions', 'memberships', 'project_memberships')
      ORDER BY 1`);
    expect(indexes.map((r) => r.def)).toEqual([
      "CREATE UNIQUE INDEX memberships_open ON bricx.memberships USING btree (org_id, user_id) WHERE (removed_at IS NULL)",
      "CREATE UNIQUE INDEX project_memberships_open ON bricx.project_memberships USING btree (org_id, project_id, user_id) WHERE (removed_at IS NULL)",
      "CREATE UNIQUE INDEX role_permissions_open ON bricx.role_permissions USING btree (role_id, permission) WHERE (revoked_at IS NULL)",
      "CREATE UNIQUE INDEX roles_open_key ON bricx.roles USING btree (org_id, key) WHERE (archived_at IS NULL)",
      "CREATE UNIQUE INDEX roles_org_id ON bricx.roles USING btree (org_id, id)",
    ]);
    // A second open role with the same key: refused; archived, allowed.
    const insertRoleSql =
      "INSERT INTO bricx.roles (id, org_id, key, name, created_at, updated_at, archived_at) VALUES ($1, $2, $3, $3, $4, $4, $5)";
    expect(
      await adminOutcome(insertRoleSql, [nextId(), ORG_A, "viewer", T0, null]),
    ).toBe(UNIQUE);
    expect(
      await adminOutcome(insertRoleSql, [nextId(), ORG_A, "viewer", T0, T1]),
    ).toBe("ok:1");
    // The same key in another org is fine.
    expect(
      await adminOutcome(insertRoleSql, [nextId(), ORG_B, "viewer", T0, null]),
    ).toBe("ok:1");
    expect(
      await adminOutcome(
        "INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at) VALUES ($1, $2, $3, $4, $5)",
        [nextId(), ORG_A, users.viewer, roles.finance, T0],
      ),
    ).toBe(UNIQUE);
    expect(
      await adminOutcome(
        "INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at) VALUES ($1, $2, $3, $4, $5)",
        [nextId(), ORG_A, users.removedOwner, roles.viewer, T0],
      ),
    ).toBe("ok:1");
    expect(
      await adminOutcome(
        "INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at) VALUES ($1, $2, $3, $4, $5)",
        [nextId(), ORG_A, roles.viewer, "project.task.read.org", T0],
      ),
    ).toBe(UNIQUE);
    expect(
      await adminOutcome(
        "INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at) VALUES ($1, $2, $3, $4, $5)",
        [nextId(), ORG_A, roles.financeRevoked, "finance.budget.read.org", T0],
      ),
    ).toBe("ok:1");
  });

  test.each([
    ["a key with a capital", "Viewer", "viewer", null],
    ["a key with a space", "my role", "name", null],
    ["a key starting with a digit", "1role", "name", null],
    ["a key of 65 characters", "k".repeat(65), "name", null],
    ["an empty name", "k", "", null],
    ["a name of 101 characters", "k", "n".repeat(101), null],
    ["an unknown system_key", "k", "name", "superuser"],
    ["a system_key with a capital", "k", "name", "Owner"],
  ])("roles: refuses %s (23514)", async (_what, key, name, systemKey) => {
    expect(
      await adminOutcome(
        "INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $6)",
        [nextId(), ORG_A, key, name, systemKey, T0],
      ),
    ).toBe(CHECK);
  });

  test("roles: every ROLE_IDS value is an accepted system_key; a key of 64 characters and a name of 100 are accepted; updated_at and archived_at never precede created_at; ids are UUIDv7", async () => {
    for (const id of ROLE_IDS) {
      expect(
        await adminOutcome(
          "INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at) VALUES ($1, $2, $3, $3, $4, $5, $5)",
          [nextId(), ORG_B, `sys_${id}`, id, T0],
        ),
        id,
      ).toBe("ok:1");
    }
    expect(
      await adminOutcome(
        "INSERT INTO bricx.roles (id, org_id, key, name, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $5)",
        [nextId(), ORG_B, "k".repeat(64), "n".repeat(100), T0],
      ),
    ).toBe("ok:1");
    expect(
      await adminOutcome(
        "INSERT INTO bricx.roles (id, org_id, key, name, created_at, updated_at) VALUES ($1, $2, $3, $3, $4, $5)",
        [nextId(), ORG_B, "k", T1, T0],
      ),
    ).toBe(CHECK);
    expect(
      await adminOutcome(
        "INSERT INTO bricx.roles (id, org_id, key, name, created_at, updated_at, archived_at) VALUES ($1, $2, $3, $3, $4, $4, $5)",
        [nextId(), ORG_B, "k", T1, T0],
      ),
    ).toBe(CHECK);
    expect(
      await adminOutcome(
        "INSERT INTO bricx.roles (id, org_id, key, name, created_at, updated_at) VALUES ($1, $2, $3, $3, $4, $4)",
        [randomUUID(), ORG_B, "k", T0],
      ),
    ).toBe(CHECK);
  });

  test.each([
    ["no scope", "finance.budget.read"],
    ["an unknown scope", "finance.budget.read.world"],
    ["a capital", "Finance.budget.read.org"],
    ["a space", "finance.budget read.org"],
    ["a wildcard", "finance.*.read.org"],
    ["an empty key", ""],
    [
      "73 characters",
      `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(27)}.org`,
    ],
  ])(
    "role_permissions: refuses a permission with %s (23514)",
    async (_what, permission) => {
      expect(
        await adminOutcome(
          "INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at) VALUES ($1, $2, $3, $4, $5)",
          [nextId(), ORG_A, roles.viewer, permission, T0],
        ),
      ).toBe(CHECK);
    },
  );

  test("role_permissions: revoked_at never precedes granted_at", async () => {
    expect(
      await adminOutcome(
        "INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at, revoked_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [nextId(), ORG_A, roles.viewer, "finance.budget.read.org", T1, T0],
      ),
    ).toBe(CHECK);
  });

  test.each([
    ["an array", "[]"],
    ["a string", '"finance.budget.read.org"'],
    ["null", "null"],
    ["an unknown key", '{"grant": []}'],
    ["add not an array", '{"add": "finance.budget.read.org"}'],
    ["remove not an array", '{"remove": {}}'],
    [
      "more than 4 KiB",
      JSON.stringify({
        add: Array.from(
          { length: 80 },
          (_, i) => `a.b.c${String(i).padStart(50, "0")}.org`,
        ),
      }),
    ],
  ])(
    "project_memberships: refuses overrides that are %s (23514)",
    async (_what, overrides) => {
      expect(
        await adminOutcome(
          "INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, overrides, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)",
          [nextId(), ORG_A, PROJECT, users.none, roles.viewer, overrides, T0],
        ),
      ).toBe(CHECK);
    },
  );

  test("project_memberships: overrides default to {}; add and remove as arrays are accepted; removed_at never precedes created_at", async () => {
    expect(
      await adminOutcome(
        "INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [nextId(), ORG_A, PROJECT, users.none, roles.viewer, T0],
      ),
    ).toBe("ok:1");
    expect(
      await adminOutcome(
        "INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, overrides, created_at) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)",
        [
          nextId(),
          ORG_A,
          PROJECT,
          users.none,
          roles.viewer,
          '{"add": [], "remove": ["a.b.c.org"]}',
          T0,
        ],
      ),
    ).toBe("ok:1");
    expect(
      await adminOutcome(
        "INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at, removed_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [nextId(), ORG_A, PROJECT, users.none, roles.viewer, T1, T0],
      ),
    ).toBe(CHECK);
    expect(
      await adminOutcome(
        "INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at, removed_at) VALUES ($1, $2, $3, $4, $5, $6)",
        [nextId(), ORG_A, users.none, roles.viewer, T1, T0],
      ),
    ).toBe(CHECK);
  });

  test("bricx_relay may use schema app (for app.mfa_state() alone): it still cannot execute the other app functions", async () => {
    const rows = await asAdmin<{ sig: string; ok: boolean }>(`
      SELECT p.oid::regprocedure::text AS sig,
             has_function_privilege('bricx_relay', p.oid, 'EXECUTE') AS ok
      FROM pg_proc p WHERE p.pronamespace = 'app'::regnamespace ORDER BY 1`);
    expect(rows).toEqual([
      { sig: "app.current_org()", ok: false },
      { sig: "app.current_user_id()", ok: false },
      { sig: "app.has_project(uuid)", ok: false },
      { sig: "app.mfa_state(uuid)", ok: true },
      {
        sig: "app.provision_user(text,timestamp with time zone,integer)",
        ok: false,
      },
    ]);
    expect(
      await asAdmin(
        "SELECT has_schema_privilege('bricx_relay', 'app', 'USAGE') AS ok",
      ),
    ).toEqual([{ ok: true }]);
  });

  test("bricx_relay has no grant on any of the four tables: it reads only through app.mfa_state()", async () => {
    for (const table of OWNER_READ_TABLES) {
      const [row] = await asAdmin<{ any: boolean }>(
        `SELECT has_any_column_privilege('bricx_relay', $1::regclass, 'SELECT') OR
                has_table_privilege('bricx_relay', $1::regclass, 'INSERT') OR
                has_table_privilege('bricx_relay', $1::regclass, 'UPDATE') OR
                has_table_privilege('bricx_relay', $1::regclass, 'DELETE') AS any`,
        [table],
      );
      expect(row, table).toEqual({ any: false });
    }
    expect(
      await inTx("bricx_relay", undefined, (client) =>
        client.query("SELECT 1 FROM bricx.memberships").then(
          () => "ok",
          (error: unknown) => sqlstateOf(error) ?? "?",
        ),
      ),
    ).toBe(DENIED);
  });
});

describe("app.mfa_state(uuid) (P5-05, owner condition 1, ADR 0066)", () => {
  const state = async (userId: string) =>
    relay.withRelayTx((tx) => mfaState(tx, userId));

  test("the code's owner bundle holds finance keys, so an owner-role membership requires MFA (the function's oracle)", () => {
    expect(ROLES.owner.some((key) => key.startsWith("finance."))).toBe(true);
  });

  test.each([
    ["an open owner-role membership", users.owner, true],
    ["a role without finance keys", users.viewer, false],
    ["a role with an open finance key", users.finance, true],
    ["no membership at all", users.none, false],
    ["a project override adding a finance key", users.projectAdd, true],
    [
      "a project override removing the role's only finance key, with a viewer org membership",
      users.projectRemoved,
      false,
    ],
    ["a role whose finance key was revoked", users.revoked, false],
    ["a removed owner-role membership", users.removedOwner, false],
    ["an owner role in another org (any org counts)", users.ownerInB, true],
    [
      "an archived role still held (the membership counts)",
      users.archivedRole,
      true,
    ],
  ])("%s: required %s", async (_what, userId, required) => {
    expect(await state(userId)).toEqual({
      keycloakSub: `sub-${userId}`,
      required,
    });
  });

  test("an unknown user: no row (undefined); an invalid id: MfaStateError invalid_user before any SQL", async () => {
    expect(await state(nextId())).toBeUndefined();
    let caught: unknown;
    try {
      await relay.withRelayTx((tx) => mfaState(tx, "not-a-uuid"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MfaStateError);
    expect(caught).toMatchObject({
      name: "MfaStateError",
      code: "invalid_user",
      message: "mfa state: invalid_user",
    });
  });

  test("the state follows the rows: revoking the finance key, then removing the membership, each flips required (convergence for the worker)", async () => {
    const user = nextId();
    const role = nextId();
    await insertUser(user);
    await insertRole(role, ORG_B, "finance_live", null);
    await insertPermission(role, ORG_B, "finance.payment.read.org");
    await insertMembership(user, ORG_B, role);
    expect((await state(user))?.required).toBe(true);
    await asAdmin(
      "UPDATE bricx.role_permissions SET revoked_at = $2 WHERE role_id = $1",
      [role, T1],
    );
    expect((await state(user))?.required).toBe(false);
    await insertPermission(role, ORG_B, "finance.payment.read.org");
    expect((await state(user))?.required).toBe(true);
    await asAdmin(
      "UPDATE bricx.memberships SET removed_at = $2 WHERE user_id = $1",
      [user, T1],
    );
    expect((await state(user))?.required).toBe(false);
  });

  test("SECURITY DEFINER, owned by bricx_owner, search_path pinned to pg_catalog, pg_temp, returns (keycloak_sub text, required boolean)", async () => {
    const [row] = await asAdmin<Record<string, unknown>>(`
      SELECT p.prosecdef AS definer, p.proowner::regrole::text AS owner,
             p.proconfig AS config, p.provolatile AS volatility,
             pg_get_function_result(p.oid) AS result
      FROM pg_proc p WHERE p.oid = 'app.mfa_state(uuid)'::regprocedure`);
    expect(row).toEqual({
      definer: true,
      owner: "bricx_owner",
      config: ["search_path=pg_catalog, pg_temp"],
      volatility: "s",
      result: "TABLE(keycloak_sub text, required boolean)",
    });
  });

  test("EXECUTE: bricx_relay only; never bricx_app, bricx_readonly, powersync_repl or PUBLIC (condition 1)", async () => {
    const rows = await asAdmin<{ role: string; ok: boolean }>(`
      SELECT r.rolname AS role,
             has_function_privilege(r.rolname, 'app.mfa_state(uuid)', 'EXECUTE') AS ok
      FROM pg_roles r
      WHERE r.rolname IN ('bricx_app', 'bricx_readonly', 'powersync_repl', 'bricx_relay')
      ORDER BY 1`);
    expect(rows).toEqual([
      { role: "bricx_app", ok: false },
      { role: "bricx_readonly", ok: false },
      { role: "bricx_relay", ok: true },
      { role: "powersync_repl", ok: false },
    ]);
    expect(
      await asAdmin(`
        SELECT 1 FROM pg_proc p
        WHERE p.oid = 'app.mfa_state(uuid)'::regprocedure
          AND (p.proacl IS NULL
               OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))`),
    ).toEqual([]);
  });

  test("bricx_app cannot call it, in or out of a context (42501), through withTx() and directly (condition 1)", async () => {
    const ctx = { orgId: ORG_A, userId: users.owner, projectIds: [] };
    let caught: unknown;
    try {
      await app.withTx(ctx, (tx) => mfaState(tx, users.owner));
    } catch (error) {
      caught = error;
    }
    expect(sqlstateOf(caught)).toBe(DENIED);
    for (const context of [ctx, undefined]) {
      expect(
        await inTx("bricx_app", context, (client) =>
          client
            .query("SELECT * FROM app.mfa_state($1::uuid)", [users.owner])
            .then(
              () => "ok",
              (error: unknown) => sqlstateOf(error) ?? "?",
            ),
        ),
      ).toBe(DENIED);
    }
    expect(
      await inTx("bricx_readonly", ctx, (client) =>
        client
          .query("SELECT * FROM app.mfa_state($1::uuid)", [users.owner])
          .then(
            () => "ok",
            (error: unknown) => sqlstateOf(error) ?? "?",
          ),
      ),
    ).toBe(DENIED);
  });

  // Condition 4: the owner-side SELECT policies serve the definer only.
  test("bricx_app gets no benefit from the owner policies: its org's rows only, and nothing without a context", async () => {
    for (const table of OWNER_READ_TABLES) {
      expect(
        await inTx("bricx_app", undefined, (client) =>
          client.query(`SELECT 1 FROM ${table}`).then((r) => r.rowCount),
        ),
        table,
      ).toBe(0);
      const orgs = await inTx(
        "bricx_app",
        { orgId: ORG_A, userId: users.none, projectIds: [] },
        (client) =>
          client
            .query<{ o: string }>(
              `SELECT DISTINCT org_id::text AS o FROM ${table} ORDER BY 1`,
            )
            .then((r) => r.rows.map((x) => x.o)),
      );
      expect(orgs, table).toEqual(
        table === "bricx.project_memberships" ? [] : [ORG_A],
      );
    }
    // In org B, the viewer (a member of org A only) sees org B's rows by
    // the tenant policy and their own org-A row by the own-row policy:
    // exactly those two, and nothing of org A's other members.
    const ctxB = { orgId: ORG_B, userId: users.viewer, projectIds: [] };
    expect(
      await inTx("bricx_app", ctxB, (client) =>
        client
          .query<{ u: string; o: string }>(
            "SELECT user_id::text AS u, org_id::text AS o FROM bricx.memberships WHERE removed_at IS NULL ORDER BY 1, 2",
          )
          .then((r) => r.rows),
      ),
    ).toEqual(
      [
        { u: users.ownerInB, o: ORG_B },
        { u: users.viewer, o: ORG_A },
      ].sort((x, y) => x.u.localeCompare(y.u)),
    );
    expect(
      await inTx("bricx_app", ctxB, (client) =>
        client
          .query(
            "UPDATE bricx.memberships SET removed_at = $1 WHERE user_id = $2",
            [T1, users.viewer],
          )
          .then((r) => `ok:${String(r.rowCount)}`),
      ),
    ).toBe("ok:0");
    // roles has no own-row policy: in org B, org B's roles only.
    expect(
      await inTx("bricx_app", ctxB, (client) =>
        client
          .query<{ o: string }>(
            "SELECT DISTINCT org_id::text AS o FROM bricx.roles ORDER BY 1",
          )
          .then((r) => r.rows.map((x) => x.o)),
      ),
    ).toEqual([ORG_B]);
  });
});
