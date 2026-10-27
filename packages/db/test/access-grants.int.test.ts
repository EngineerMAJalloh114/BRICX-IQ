// P5-06 (ADR 0067; Done-when DW1, owner conditions 2 and 4): the
// temporary elevations table bricx.access_grants, the owner-side readers
// app.mfa_state() v2 and app.access_grants_due(), and the outbox's
// not_before column, against compose.yml's Postgres with the production
// journal, applied by the real migrator as bricx_owner.
// - bricx.access_grants (org.access_grant): one catalogue key for one user
//   for a bounded window; granted by someone else; ended once, by a
//   revoke (revoked_at + revoked_by) or by the expiry job (expired_at),
//   never both. Tenant table (rls.int.test.ts proves the tenant policies);
//   own-row SELECT on user_id in any org (a user reads their own grants);
//   owner-side SELECT for the two definers (OWNER_POLICY_TABLES, SELECT
//   only). Not synced: nothing for powersync_repl, no publication.
// - app.mfa_state(p_user) v2 counts a finance.* grant that is not revoked
//   and not expired, a future starts_at included (condition 2).
// - app.access_grants_due(p_limit): SECURITY DEFINER, EXECUTE bricx_relay
//   only, the sweep's cross-org read of open, due grants.
// - bricx_app cannot execute either definer (42501), in or out of a
//   context, and gets no benefit from the owner policy.
import { randomUUID } from "node:crypto";
import {
  type BootstrappedPostgres,
  type Role,
  appDatabase,
  exampleValue,
  rolePasswordKeys,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { MFA_KEY_PREFIX } from "@bricx/permissions/mfa";
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
import {
  AccessGrantError,
  accessGrantsDue,
  endAccessGrantsOf,
  expireAccessGrant,
} from "../src/access-grants.js";
import { mfaState } from "../src/mfa.js";
import {
  OUTBOX_TOPICS,
  claimOutboxBatch,
  insertOutbox,
} from "../src/outbox.js";
import { migrate } from "../src/migrate.js";
import { OWNER_POLICY_TABLES } from "../src/rls-guard.js";
import {
  OWNER_READ_TABLES,
  OWN_ROW_TABLES,
  TENANT_TABLES,
  TENANT_UPDATE_COLUMNS,
} from "../src/rls.js";
import {
  type TxContext,
  contextStatement,
  validateTxContext,
} from "../src/tx.js";

const ORG_A = "0199e1b0-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1b0-0000-7000-8000-0000000000b1";
const PROJECT = "0199e1b0-0000-7000-8000-0000000000a3";
// Instants around the suite's start, on the wall clock the database shares,
// so the seeds stay in their window (open), ahead of it (pending) or behind
// it (expired) whenever the suite runs: app.access_grants_due() and the
// sweep read now(), and a fixed calendar instant would drift into the past.
const HOUR = 3_600_000;
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const at = (ms: number) => new Date(ms).toISOString();
const T0 = at(NOW - HOUR); // created and started an hour ago
const T1 = at(NOW + HOUR); // expires in an hour
const T2 = at(NOW + 2 * HOUR);
const DENIED = "42501";
const FK = "23503";
const CHECK = "23514";
const TABLE = "bricx.access_grants";
const FINANCE = "finance.payment.approve.project";
const READ = "project.task.read.org";
const dialect = new PgDialect();

let pg18: BootstrappedPostgres;
let relay: RelayDatabase;
let app: Database;
let n = 0;
/** A UUIDv7-shaped id (version 7, variant 10), unique per call. */
const nextId = (): string => {
  n += 1;
  return `0199e1b0-${n.toString(16).padStart(4, "0")}-7000-8000-${randomUUID().slice(-12)}`;
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
      return sqlstateOf(error) ?? "?";
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

/** "ok:<rowCount>" or the SQLSTATE of one statement as `who`. */
const outcome = (
  who: Role,
  ctx: TxContext | undefined,
  text: string,
  params: unknown[] = [],
) =>
  inTx(who, ctx, (client) =>
    client.query(text, params).then(
      (r) => `ok:${String(r.rowCount)}`,
      (error: unknown) => sqlstateOf(error) ?? "?",
    ),
  );

const users = {
  granter: nextId(),
  subject: nextId(),
  other: nextId(),
  pending: nextId(),
  revoked: nextId(),
  expired: nextId(),
  readOnly: nextId(),
  inB: nextId(),
  none: nextId(),
} as const;

interface GrantRow {
  readonly id?: string;
  readonly org?: string;
  readonly user: string;
  readonly permission?: string;
  readonly scope?: string | null;
  readonly reason?: string;
  readonly grantedBy?: string;
  readonly startsAt?: string;
  readonly expiresAt?: string;
  readonly revokedAt?: string | null;
  readonly revokedBy?: string | null;
  readonly expiredAt?: string | null;
  readonly createdAt?: string;
}

const INSERT = `INSERT INTO bricx.access_grants
  (id, org_id, user_id, permission, scope_id, reason, granted_by, starts_at, expires_at, revoked_at, revoked_by, expired_at, created_at)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`;

const paramsOf = (g: GrantRow): unknown[] => [
  g.id ?? nextId(),
  g.org ?? ORG_A,
  g.user,
  g.permission ?? FINANCE,
  g.scope === undefined ? PROJECT : g.scope,
  g.reason ?? "month-end close cover",
  g.grantedBy ?? users.granter,
  g.startsAt ?? T0,
  g.expiresAt ?? T1,
  g.revokedAt ?? null,
  g.revokedBy ?? null,
  g.expiredAt ?? null,
  g.createdAt ?? T0,
];

async function insertUser(id: string) {
  await asAdmin(
    "INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at) VALUES ($1, $2, $3, $3)",
    [id, `sub-${id}`, T0],
  );
}
async function insertGrant(g: GrantRow): Promise<string> {
  const params = paramsOf(g);
  await asAdmin(INSERT, params);
  return String(params[0]);
}

/** ISO instants around the database's now(), for the due tests. */
async function dbNow(): Promise<number> {
  const [row] = await asAdmin<{ ms: string }>(
    "SELECT (extract(epoch FROM now()) * 1000)::bigint::text AS ms",
  );
  return Number(row?.ms);
}

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"));
  relay = openRelayDatabase(urlFor("bricx_relay"));
  app = openDatabase(urlFor("bricx_app"));
  for (const id of Object.values(users)) await insertUser(id);
  // A finance grant in its window; a pending one (starts later); a revoked
  // one; one the job expired; a read-only one; one in org B.
  await insertGrant({ user: users.subject });
  await insertGrant({ user: users.pending, startsAt: T1, expiresAt: T2 });
  await insertGrant({
    user: users.revoked,
    revokedAt: T0,
    revokedBy: users.granter,
  });
  await insertGrant({
    user: users.expired,
    startsAt: at(NOW - 3 * HOUR),
    expiresAt: at(NOW - 2 * HOUR),
    expiredAt: at(NOW - 2 * HOUR),
    createdAt: at(NOW - 3 * HOUR),
  });
  await insertGrant({ user: users.readOnly, permission: READ, scope: null });
  await insertGrant({ user: users.inB, org: ORG_B });
});
afterAll(async () => {
  await relay.close();
  await app.close();
  await pg18.container.stop();
});

describe("bricx.access_grants: the table (DW1)", () => {
  test("columns, as the schema declares them", async () => {
    const columns = await asAdmin<{ c: string; ty: string; nn: boolean }>(`
      SELECT column_name AS c, data_type AS ty, is_nullable = 'NO' AS nn
      FROM information_schema.columns
      WHERE table_schema = 'bricx' AND table_name = 'access_grants'
      ORDER BY ordinal_position`);
    const tz = "timestamp with time zone";
    expect(columns).toEqual([
      { c: "id", ty: "uuid", nn: true },
      { c: "org_id", ty: "uuid", nn: true },
      { c: "user_id", ty: "uuid", nn: true },
      { c: "permission", ty: "text", nn: true },
      { c: "scope_id", ty: "uuid", nn: false },
      { c: "reason", ty: "text", nn: true },
      { c: "granted_by", ty: "uuid", nn: true },
      { c: "starts_at", ty: tz, nn: true },
      { c: "expires_at", ty: tz, nn: true },
      { c: "revoked_at", ty: tz, nn: false },
      { c: "revoked_by", ty: "uuid", nn: false },
      { c: "expired_at", ty: tz, nn: false },
      { c: "created_at", ty: tz, nn: true },
    ]);
  });

  test("user_id, granted_by and revoked_by reference bricx.users (23503 for an unknown user); scope_id has no FK until P6-05", async () => {
    const fks = await asAdmin<{ name: string; def: string }>(`
      SELECT conname AS name, pg_get_constraintdef(oid) AS def
      FROM pg_constraint WHERE conrelid = 'bricx.access_grants'::regclass AND contype = 'f'
      ORDER BY 1`);
    expect(fks).toEqual([
      {
        name: "access_grants_granted_by_users_id_fk",
        def: "FOREIGN KEY (granted_by) REFERENCES bricx.users(id)",
      },
      {
        name: "access_grants_revoked_by_users_id_fk",
        def: "FOREIGN KEY (revoked_by) REFERENCES bricx.users(id)",
      },
      {
        name: "access_grants_user_id_users_id_fk",
        def: "FOREIGN KEY (user_id) REFERENCES bricx.users(id)",
      },
    ]);
    expect(await adminOutcome(INSERT, paramsOf({ user: nextId() }))).toBe(FK);
    expect(
      await adminOutcome(
        INSERT,
        paramsOf({ user: users.other, grantedBy: nextId() }),
      ),
    ).toBe(FK);
    expect(
      await adminOutcome(
        INSERT,
        paramsOf({ user: users.other, revokedAt: T0, revokedBy: nextId() }),
      ),
    ).toBe(FK);
  });

  test.each<[string, GrantRow, string]>([
    ["a valid grant", { user: users.other }, "ok:1"],
    [
      "an org-scoped grant (scope_id NULL)",
      { user: users.other, scope: null },
      "ok:1",
    ],
    [
      "a revoked grant",
      { user: users.other, revokedAt: T0, revokedBy: users.granter },
      "ok:1",
    ],
    [
      "an expired grant (expired_at at expires_at)",
      { user: users.other, expiredAt: T1 },
      "ok:1",
    ],
    [
      "a 60 s window",
      { user: users.other, expiresAt: at(NOW - HOUR + 60_000) },
      "ok:1",
    ],
    [
      "a 30 d window",
      { user: users.other, expiresAt: at(NOW - HOUR + 30 * 24 * HOUR) },
      "ok:1",
    ],
    [
      "a 500-character reason",
      { user: users.other, reason: "r".repeat(500) },
      "ok:1",
    ],
    [
      "the subject as the granter (self-grant)",
      { user: users.other, grantedBy: users.other },
      CHECK,
    ],
    [
      "starts_at equal to expires_at",
      { user: users.other, expiresAt: T0 },
      CHECK,
    ],
    [
      "starts_at after expires_at",
      { user: users.other, startsAt: T1, expiresAt: T0 },
      CHECK,
    ],
    [
      "a 59 s window",
      { user: users.other, expiresAt: at(NOW - HOUR + 59_000) },
      CHECK,
    ],
    [
      "a window over 30 d",
      { user: users.other, expiresAt: at(NOW - HOUR + 30 * 24 * HOUR + 1_000) },
      CHECK,
    ],
    ["an empty reason", { user: users.other, reason: "" }, CHECK],
    [
      "a 501-character reason",
      { user: users.other, reason: "r".repeat(501) },
      CHECK,
    ],
    [
      "a permission that is not a catalogue key",
      { user: users.other, permission: "finance.payment.approve" },
      CHECK,
    ],
    [
      "a permission with a wildcard",
      { user: users.other, permission: "finance.*.approve.project" },
      CHECK,
    ],
    [
      "revoked_at without revoked_by",
      { user: users.other, revokedAt: T0 },
      CHECK,
    ],
    [
      "revoked_by without revoked_at",
      { user: users.other, revokedBy: users.granter },
      CHECK,
    ],
    [
      "revoked_at before created_at",
      {
        user: users.other,
        revokedAt: at(NOW - HOUR - 1_000),
        revokedBy: users.granter,
      },
      CHECK,
    ],
    [
      "expired_at before expires_at",
      { user: users.other, expiredAt: at(NOW + HOUR - 1_000) },
      CHECK,
    ],
    [
      "both revoked and expired",
      {
        user: users.other,
        revokedAt: T0,
        revokedBy: users.granter,
        expiredAt: T1,
      },
      CHECK,
    ],
    [
      "an id that is not a UUIDv7",
      { user: users.other, id: "0199e1b0-0000-4000-8000-000000000001" },
      CHECK,
    ],
  ])("%s: %s", async (_what, row, wanted) => {
    expect(await adminOutcome(INSERT, paramsOf(row))).toBe(wanted);
  });

  test("the partial indexes cover open rows only: (org_id, user_id) for the per-user cap and the ability read, (expires_at) for the sweep", async () => {
    const indexes = await asAdmin<{ name: string; def: string }>(`
      SELECT indexname AS name, indexdef AS def FROM pg_indexes
      WHERE schemaname = 'bricx' AND tablename = 'access_grants' ORDER BY 1`);
    expect(indexes).toEqual([
      {
        name: "access_grants_due",
        def: "CREATE INDEX access_grants_due ON bricx.access_grants USING btree (expires_at) WHERE ((revoked_at IS NULL) AND (expired_at IS NULL))",
      },
      {
        name: "access_grants_pkey",
        def: "CREATE UNIQUE INDEX access_grants_pkey ON bricx.access_grants USING btree (id)",
      },
      {
        name: "access_grants_user_open",
        def: "CREATE INDEX access_grants_user_open ON bricx.access_grants USING btree (org_id, user_id) WHERE ((revoked_at IS NULL) AND (expired_at IS NULL))",
      },
    ]);
  });

  test("registered: a tenant table of org.access_grant, own-row SELECT on user_id (no UPDATE), an owner-read table, on the guard's allowlist with SELECT only", () => {
    expect(TENANT_TABLES[TABLE]).toBe("org.access_grant");
    expect(OWN_ROW_TABLES[TABLE]).toEqual({ column: "user_id", update: false });
    expect(OWNER_READ_TABLES).toContain(TABLE);
    expect(OWNER_POLICY_TABLES[TABLE]).toEqual(["SELECT"]);
    // PR #71 review, amendment 1: bricx_app updates the three end columns only.
    expect(TENANT_UPDATE_COLUMNS[TABLE]).toEqual([
      "revoked_at",
      "revoked_by",
      "expired_at",
    ]);
  });

  test("ENABLE + FORCE; the tenant policies, the own-row SELECT and the owner SELECT, nothing else; not synced (nothing for powersync_repl, no publication)", async () => {
    expect(
      await asAdmin(
        "SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = $1::regclass",
        [TABLE],
      ),
    ).toEqual([{ enabled: true, forced: true }]);
    const policies = await asAdmin<{
      name: string;
      cmd: string;
      roles: string[];
      qual: string | null;
      check: string | null;
    }>(`
      SELECT policyname AS name, cmd, roles::text[] AS roles, qual, with_check AS check
      FROM pg_policies WHERE schemaname = 'bricx' AND tablename = 'access_grants'
      ORDER BY policyname`);
    for (const p of policies) p.roles.sort();
    const org = "(org_id = app.current_org())";
    const self = "(user_id = app.current_user_id())";
    expect(policies).toEqual([
      {
        name: "access_grants_insert",
        cmd: "INSERT",
        roles: ["bricx_app", "bricx_owner"],
        qual: null,
        check: org,
      },
      {
        name: "access_grants_own_select",
        cmd: "SELECT",
        roles: ["bricx_app", "bricx_readonly"],
        qual: self,
        check: null,
      },
      {
        name: "access_grants_owner_select",
        cmd: "SELECT",
        roles: ["bricx_owner"],
        qual: "true",
        check: null,
      },
      {
        name: "access_grants_select",
        cmd: "SELECT",
        roles: ["bricx_app", "bricx_owner", "bricx_readonly"],
        qual: org,
        check: null,
      },
      {
        name: "access_grants_update",
        cmd: "UPDATE",
        roles: ["bricx_app", "bricx_owner"],
        qual: org,
        check: org,
      },
    ]);
    expect(
      await asAdmin(
        `SELECT has_table_privilege('powersync_repl', $1::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
             OR has_any_column_privilege('powersync_repl', $1::regclass, 'SELECT, INSERT, UPDATE, REFERENCES') AS any`,
        [TABLE],
      ),
    ).toEqual([{ any: false }]);
    expect(
      await asAdmin(
        "SELECT 1 FROM pg_publication_tables WHERE schemaname = 'bricx' AND tablename = 'access_grants'",
      ),
    ).toEqual([]);
    expect(
      await asAdmin(
        `SELECT has_any_column_privilege('bricx_relay', $1::regclass, 'SELECT') OR
                has_table_privilege('bricx_relay', $1::regclass, 'INSERT, UPDATE, DELETE') AS any`,
        [TABLE],
      ),
    ).toEqual([{ any: false }]);
  });
});

describe("bricx_app and bricx_readonly: the org's rows, plus their own rows in any org (own-row SELECT only)", () => {
  const ids = (rows: { u: string }[]) => rows.map((r) => r.u).sort();
  const visible = (who: Role, ctx: TxContext | undefined) =>
    inTx(who, ctx, (client) =>
      client
        .query<{ u: string }>(
          "SELECT user_id::text AS u FROM bricx.access_grants ORDER BY 1",
        )
        .then((r) => ids(r.rows)),
    );

  test("no context: no rows; org A's context: A's rows only; org B's context for a user of org A: B's rows plus their own A row", async () => {
    expect(await visible("bricx_app", undefined)).toEqual([]);
    const inA = {
      orgId: ORG_A,
      userId: users.none,
      projectIds: [],
    };
    expect(await visible("bricx_app", inA)).toEqual(
      [
        users.subject,
        users.pending,
        users.revoked,
        users.expired,
        users.readOnly,
      ].sort(),
    );
    const subjectInB = { orgId: ORG_B, userId: users.subject, projectIds: [] };
    expect(await visible("bricx_app", subjectInB)).toEqual(
      [users.inB, users.subject].sort(),
    );
    expect(await visible("bricx_readonly", subjectInB)).toEqual(
      [users.inB, users.subject].sort(),
    );
  });

  test("the own-row policy grants no UPDATE: a user in org B cannot revoke their org-A grant (0 rows); the tenant policy in org A can", async () => {
    const revoke =
      "UPDATE bricx.access_grants SET revoked_at = $2, revoked_by = $3 WHERE user_id = $1 AND revoked_at IS NULL";
    const params = [users.subject, T0, users.granter];
    expect(
      await outcome(
        "bricx_app",
        { orgId: ORG_B, userId: users.subject, projectIds: [] },
        revoke,
        params,
      ),
    ).toBe("ok:0");
    expect(
      await outcome(
        "bricx_app",
        { orgId: ORG_A, userId: users.granter, projectIds: [] },
        revoke,
        params,
      ),
    ).toBe("ok:1");
    expect(
      await outcome(
        "bricx_readonly",
        { orgId: ORG_A, userId: users.granter, projectIds: [] },
        revoke,
        params,
      ),
    ).toBe(DENIED);
  });

  test("INSERT: its own org only (42501 for another org); DELETE matches nothing under FORCE", async () => {
    const own = paramsOf({ user: users.other });
    expect(
      await outcome(
        "bricx_app",
        { orgId: ORG_A, userId: users.granter, projectIds: [] },
        INSERT,
        own,
      ),
    ).toBe("ok:1");
    expect(
      await outcome(
        "bricx_app",
        { orgId: ORG_B, userId: users.granter, projectIds: [] },
        INSERT,
        own,
      ),
    ).toBe(DENIED);
    expect(
      await outcome(
        "bricx_app",
        { orgId: ORG_A, userId: users.granter, projectIds: [] },
        "DELETE FROM bricx.access_grants",
      ),
    ).toBe("ok:0");
  });
});

describe("app.mfa_state(uuid) v2: finance elevations count (D-F, owner condition 2)", () => {
  const state = async (userId: string) =>
    relay.withRelayTx((tx) => mfaState(tx, userId));

  test.each([
    [
      "a finance grant in its window, no membership at all",
      users.subject,
      true,
    ],
    ["a finance grant that starts later (pending)", users.pending, true],
    ["a revoked finance grant", users.revoked, false],
    ["a finance grant the job expired", users.expired, false],
    ["a non-finance grant", users.readOnly, false],
    ["a finance grant in another org (any org counts)", users.inB, true],
    ["no grant", users.none, false],
  ])("%s: required %s", async (_what, userId, required) => {
    expect(await state(userId)).toEqual({
      keycloakSub: `sub-${userId}`,
      required,
    });
  });

  test("the state follows the row: revoking the grant flips required to false (convergence for the worker)", async () => {
    const user = nextId();
    await insertUser(user);
    const id = await insertGrant({ user });
    expect((await state(user))?.required).toBe(true);
    await asAdmin(
      "UPDATE bricx.access_grants SET revoked_at = $2, revoked_by = $3 WHERE id = $1",
      [id, T1, users.granter],
    );
    expect((await state(user))?.required).toBe(false);
  });
});

describe("app.mfa_state(uuid) agrees with @bricx/permissions (P5-07, owner condition 3)", () => {
  test("every key pattern in the live function is MFA_KEY_PREFIX followed by %, the API's step-up rule", async () => {
    const [row] = await asAdmin<{ src: string }>(
      // A BEGIN ATOMIC body is kept parsed (prosqlbody, prosrc is empty):
      // the definition Postgres prints back is what runs. It prints LIKE
      // as its operator ~~.
      "SELECT pg_get_functiondef('app.mfa_state(uuid)'::regprocedure) AS src",
    );
    const src = row?.src ?? "";
    const patterns = [...src.matchAll(/(?:LIKE|~~)\s+'([^']*)'/g)].map(
      (m) => m[1],
    );
    // 0007's body: role keys, overrides and elevations (three patterns).
    expect(patterns).toHaveLength(3);
    expect(new Set(patterns)).toEqual(new Set([`${MFA_KEY_PREFIX}%`]));
    // No other way to name a finance key in the body.
    expect(src).not.toMatch(/finance\.(?!%)/);
  });
});

describe("app.access_grants_due(integer): the sweep's cross-org read", () => {
  test("SECURITY DEFINER, owned by bricx_owner, search_path pinned, STABLE, returns (id uuid, org_id uuid, user_id uuid)", async () => {
    const [row] = await asAdmin<Record<string, unknown>>(`
      SELECT p.prosecdef AS definer, p.proowner::regrole::text AS owner,
             p.proconfig AS config, p.provolatile AS volatility,
             pg_get_function_result(p.oid) AS result
      FROM pg_proc p WHERE p.oid = 'app.access_grants_due(integer)'::regprocedure`);
    expect(row).toEqual({
      definer: true,
      owner: "bricx_owner",
      config: ["search_path=pg_catalog, pg_temp"],
      volatility: "s",
      result: "TABLE(id uuid, org_id uuid, user_id uuid)",
    });
  });

  test("EXECUTE: bricx_relay only; never bricx_app, bricx_readonly, powersync_repl or PUBLIC; bricx_app gets 42501 in and out of a context", async () => {
    const rows = await asAdmin<{ role: string; ok: boolean }>(`
      SELECT r.rolname AS role,
             has_function_privilege(r.rolname, 'app.access_grants_due(integer)', 'EXECUTE') AS ok
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
        WHERE p.oid = 'app.access_grants_due(integer)'::regprocedure
          AND (p.proacl IS NULL
               OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))`),
    ).toEqual([]);
    const call = "SELECT * FROM app.access_grants_due(10)";
    const ctx = { orgId: ORG_A, userId: users.granter, projectIds: [] };
    expect(await outcome("bricx_app", ctx, call)).toBe(DENIED);
    expect(await outcome("bricx_app", undefined, call)).toBe(DENIED);
    expect(await outcome("bricx_readonly", ctx, call)).toBe(DENIED);
    let caught: unknown;
    try {
      await app.withTx(ctx, async (tx) => {
        await tx.execute(call);
      });
    } catch (error) {
      caught = error;
    }
    expect(sqlstateOf(caught)).toBe(DENIED);
  });

  test("returns open grants past expires_at, in every org, oldest expiry first, at most p_limit; never a pending, revoked or already expired one", async () => {
    const now = await dbNow();
    const hour = 3_600_000;
    const dueA = await insertGrant({
      user: users.other,
      startsAt: at(now - 3 * hour),
      expiresAt: at(now - 2 * hour),
      createdAt: at(now - 3 * hour),
    });
    const dueB = await insertGrant({
      user: users.other,
      org: ORG_B,
      startsAt: at(now - 2 * hour),
      expiresAt: at(now - hour),
      createdAt: at(now - 2 * hour),
    });
    const future = await insertGrant({
      user: users.other,
      startsAt: at(now - hour),
      expiresAt: at(now + hour),
      createdAt: at(now - hour),
    });
    const revoked = await insertGrant({
      user: users.other,
      startsAt: at(now - 3 * hour),
      expiresAt: at(now - 2 * hour),
      createdAt: at(now - 3 * hour),
      revokedAt: at(now - 2.5 * hour),
      revokedBy: users.granter,
    });
    const done = await insertGrant({
      user: users.other,
      startsAt: at(now - 3 * hour),
      expiresAt: at(now - 2 * hour),
      createdAt: at(now - 3 * hour),
      expiredAt: at(now - 2 * hour),
    });
    const due = await relay.withRelayTx(async (tx) => {
      const r = await tx.execute<{
        id: string;
        org_id: string;
        user_id: string;
      }>(
        "SELECT id::text, org_id::text, user_id::text FROM app.access_grants_due(100)",
      );
      return r.rows;
    });
    expect(due).toEqual([
      { id: dueA, org_id: ORG_A, user_id: users.other },
      { id: dueB, org_id: ORG_B, user_id: users.other },
    ]);
    for (const id of [future, revoked, done]) {
      expect(due.map((r) => r.id)).not.toContain(id);
    }
    const one = await relay.withRelayTx(async (tx) => {
      const r = await tx.execute<{ id: string }>(
        "SELECT id::text FROM app.access_grants_due(1)",
      );
      return r.rows;
    });
    expect(one).toEqual([{ id: dueA }]);
    const none = await relay.withRelayTx(async (tx) => {
      const r = await tx.execute("SELECT id FROM app.access_grants_due(0)");
      return r.rows;
    });
    expect(none).toEqual([]);
  });
});

describe("accessGrantsDue(tx, limit) and expireAccessGrant(tx, id) (@bricx/db/access-grants)", () => {
  test("accessGrantsDue: the function's rows as (id, orgId, userId); the limit is bounded (1..1000) before any SQL", async () => {
    const now = await dbNow();
    const hour = 3_600_000;
    const id = await insertGrant({
      user: users.other,
      org: ORG_B,
      startsAt: at(now - 5 * hour),
      expiresAt: at(now - 4 * hour),
      createdAt: at(now - 5 * hour),
    });
    const rows = await relay.withRelayTx((tx) => accessGrantsDue(tx, 1000));
    expect(rows[0]).toEqual({ id, orgId: ORG_B, userId: users.other });
    for (const limit of [0, 1001, 1.5, Number.NaN]) {
      let caught: unknown;
      try {
        await relay.withRelayTx((tx) => accessGrantsDue(tx, limit));
      } catch (error) {
        caught = error;
      }
      expect(caught, String(limit)).toBeInstanceOf(RangeError);
    }
  });

  test("expireAccessGrant as bricx_app in the grant's org: a due open grant is expired once (the row's before and after come back); a replay, a revoked, a pending and an unknown grant each answer their state and change nothing", async () => {
    const now = await dbNow();
    const hour = 3_600_000;
    const user = nextId();
    await insertUser(user);
    const due = await insertGrant({
      user,
      startsAt: at(now - 2 * hour),
      expiresAt: at(now - hour),
      createdAt: at(now - 2 * hour),
    });
    const open = await insertGrant({
      user,
      startsAt: at(now - hour),
      expiresAt: at(now + hour),
      createdAt: at(now - hour),
    });
    const pending = await insertGrant({
      user,
      startsAt: at(now + hour),
      expiresAt: at(now + 2 * hour),
      createdAt: at(now - hour),
    });
    const revoked = await insertGrant({
      user,
      startsAt: at(now - 2 * hour),
      expiresAt: at(now - hour),
      createdAt: at(now - 2 * hour),
      revokedAt: at(now - 1.5 * hour),
      revokedBy: users.granter,
    });
    const ctx = { orgId: ORG_A, userId: user, projectIds: [] };
    const first = await app.withTx(ctx, (tx) => expireAccessGrant(tx, due));
    expect(first).toMatchObject({
      state: "expired",
      changed: true,
      grant: {
        id: due,
        orgId: ORG_A,
        userId: user,
        permission: FINANCE,
        scopeId: PROJECT,
        grantedBy: users.granter,
        startsAt: at(now - 2 * hour),
        expiresAt: at(now - hour),
        revokedAt: null,
        revokedBy: null,
      },
    });
    expect(first?.grant.expiredAt).not.toBeNull();
    expect(first?.grant).not.toHaveProperty("reason");
    const [stored] = await asAdmin<{ e: string | null }>(
      "SELECT expired_at::text AS e FROM bricx.access_grants WHERE id = $1",
      [due],
    );
    expect(stored?.e).not.toBeNull();
    expect(
      await app.withTx(ctx, (tx) => expireAccessGrant(tx, due)),
    ).toMatchObject({ state: "expired", changed: false });
    expect(
      await app.withTx(ctx, (tx) => expireAccessGrant(tx, open)),
    ).toMatchObject({ state: "open", changed: false });
    expect(
      await app.withTx(ctx, (tx) => expireAccessGrant(tx, pending)),
    ).toMatchObject({ state: "pending", changed: false });
    expect(
      await app.withTx(ctx, (tx) => expireAccessGrant(tx, revoked)),
    ).toMatchObject({ state: "revoked", changed: false });
    expect(
      await app.withTx(ctx, (tx) => expireAccessGrant(tx, nextId())),
    ).toBeUndefined();
    // Another org's context sees nothing: the tenant policy, not the id
    // (the subject's own-row SELECT would show the row, so another user).
    expect(
      await app.withTx(
        { orgId: ORG_B, userId: users.none, projectIds: [] },
        (tx) => expireAccessGrant(tx, open),
      ),
    ).toBeUndefined();
    // The subject's own-row SELECT shows it in any org, but the UPDATE
    // policy is the org's: a due grant is not expired from another org.
    expect(
      await app.withTx({ orgId: ORG_B, userId: user, projectIds: [] }, (tx) =>
        expireAccessGrant(tx, open),
      ),
    ).toMatchObject({ state: "open", changed: false });
    let caught: unknown;
    try {
      await app.withTx(ctx, (tx) => expireAccessGrant(tx, "not-a-uuid"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AccessGrantError);
    expect(caught).toMatchObject({ code: "invalid_id" });
  });
});

describe("bricx.outbox.not_before (D-G): the relay's delayed publish", () => {
  test("insertOutbox() with notBefore stores it; claimOutboxBatch() returns delayMs from the database clock (0 when due or unset)", async () => {
    const now = await dbNow();
    const soon = at(now + 600_000);
    const past = at(now - 600_000);
    const later = nextId();
    const due = nextId();
    const plain = nextId();
    const ctx = { orgId: ORG_B, userId: users.granter, projectIds: [] };
    await app.withTx(ctx, async (tx) => {
      await insertOutbox(
        tx,
        "access_grants.expire",
        { grantId: later, userId: users.other },
        later,
        { notBefore: soon },
      );
      await insertOutbox(
        tx,
        "access_grants.expire",
        { grantId: due, userId: users.other },
        due,
        { notBefore: past },
      );
      await insertOutbox(tx, "system.ping", {}, plain);
    });
    expect(OUTBOX_TOPICS["access_grants.expire"]?.queue).toBe("access");
    const claimed = await relay.withRelayTx((tx) => claimOutboxBatch(tx, 1000));
    const mine = new Map(claimed.map((r) => [r.id, r]));
    expect(mine.get(plain)).toMatchObject({ topic: "system.ping", delayMs: 0 });
    expect(mine.get(due)).toMatchObject({
      topic: "access_grants.expire",
      delayMs: 0,
    });
    const delayed = mine.get(later);
    expect(delayed?.delayMs).toBeGreaterThan(540_000);
    expect(delayed?.delayMs).toBeLessThanOrEqual(600_000);
    expect(Number.isSafeInteger(delayed?.delayMs)).toBe(true);
    let caught: unknown;
    try {
      await app.withTx(ctx, (tx) =>
        insertOutbox(tx, "system.ping", {}, nextId(), { notBefore: "soon" }),
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      name: "OutboxError",
      code: "invalid_not_before",
    });
  });

  test("a nullable timestamptz bricx_app may INSERT; the relay reads it; nobody updates it", async () => {
    expect(
      await asAdmin(`
        SELECT data_type AS ty, is_nullable = 'YES' AS nullable, column_default AS def
        FROM information_schema.columns
        WHERE table_schema = 'bricx' AND table_name = 'outbox' AND column_name = 'not_before'`),
    ).toEqual([{ ty: "timestamp with time zone", nullable: true, def: null }]);
    expect(
      await asAdmin(`
        SELECT grantee, privilege_type AS privilege
        FROM information_schema.column_privileges
        WHERE table_schema = 'bricx' AND table_name = 'outbox' AND column_name = 'not_before'
          AND grantee IN ('bricx_app', 'bricx_readonly', 'bricx_relay', 'powersync_repl')
        ORDER BY 1, 2`),
    ).toEqual([
      { grantee: "bricx_app", privilege: "INSERT" },
      { grantee: "bricx_relay", privilege: "SELECT" },
    ]);
  });

  test("bricx_app writes a row with not_before in the same INSERT shape as insertOutbox(); without it the column stays NULL", async () => {
    const ctx = { orgId: ORG_A, userId: users.granter, projectIds: [] };
    expect(
      await outcome(
        "bricx_app",
        ctx,
        "INSERT INTO bricx.outbox (id, org_id, topic, payload, not_before) VALUES ($1::uuid, $2::uuid, 'system.ping', '{}'::jsonb, $3::timestamptz)",
        [nextId(), ORG_A, T2],
      ),
    ).toBe("ok:1");
    expect(
      await inTx("bricx_app", ctx, async (client) => {
        const id = nextId();
        await client.query(
          "INSERT INTO bricx.outbox (id, org_id, topic, payload) VALUES ($1::uuid, $2::uuid, 'system.ping', '{}'::jsonb)",
          [id, ORG_A],
        );
        return id;
      }).then((id) =>
        asAdmin<{ nb: string | null }>(
          "SELECT not_before::text AS nb FROM bricx.outbox WHERE id = $1",
          [id],
        ),
      ),
    ).toEqual([]);
  });
});

describe("immutability (PR #71 review, amendment 1, ADR 0067): bricx_app updates the end columns only; the trigger makes them set-once and every other column fixed", () => {
  const ctxA: TxContext = { orgId: ORG_A, userId: users.none, projectIds: [] };
  const ENDS = ["revoked_at", "revoked_by", "expired_at"];
  const IMMUTABLE: readonly (readonly [string, string])[] = [
    ["expires_at", "expires_at + interval '1 hour'"],
    ["permission", "'finance.payment.read.project'"],
    // The seeds belong to users.other: another user is a change.
    ["user_id", `'${users.subject}'::uuid`],
    ["starts_at", "starts_at - interval '1 minute'"],
    ["scope_id", "NULL"],
    ["reason", "'another reason'"],
    ["granted_by", `'${users.revoked}'::uuid`],
    ["id", "'0199e1b0-ffff-7000-8000-000000000001'::uuid"],
    ["org_id", `'${ORG_B}'::uuid`],
    ["created_at", "created_at - interval '1 minute'"],
  ];
  /** An open grant (in its window), a revoked one and an expired one, in org A. */
  async function seedEnds() {
    const open = await insertGrant({ user: users.other });
    const revoked = await insertGrant({
      user: users.other,
      revokedAt: T0,
      revokedBy: users.granter,
    });
    const expired = await insertGrant({
      user: users.other,
      startsAt: at(NOW - 3 * HOUR),
      expiresAt: at(NOW - 2 * HOUR),
      expiredAt: at(NOW - 2 * HOUR),
      createdAt: at(NOW - 3 * HOUR),
    });
    const due = await insertGrant({
      user: users.other,
      startsAt: at(NOW - 3 * HOUR),
      expiresAt: at(NOW - 2 * HOUR),
      createdAt: at(NOW - 3 * HOUR),
    });
    return { open, revoked, expired, due };
  }

  test("the catalog: no table-level UPDATE for bricx_app; column UPDATE on exactly revoked_at, revoked_by and expired_at; the trigger is BEFORE UPDATE on every row, enabled", async () => {
    expect(
      await asAdmin(
        "SELECT has_table_privilege('bricx_app', $1::regclass, 'UPDATE') AS u",
        [TABLE],
      ),
    ).toEqual([{ u: false }]);
    const columns = await asAdmin<{ name: string }>(
      `SELECT attname AS name FROM pg_attribute
       WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
         AND has_column_privilege('bricx_app', attrelid, attnum, 'UPDATE')
       ORDER BY attnum`,
      [TABLE],
    );
    expect(columns.map((c) => c.name)).toEqual(ENDS);
    const triggers = await asAdmin<{
      name: string;
      def: string;
      enabled: string;
    }>(
      `SELECT tgname AS name, pg_get_triggerdef(oid) AS def, tgenabled AS enabled
       FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal ORDER BY tgname`,
      [TABLE],
    );
    expect(triggers).toEqual([
      {
        name: "access_grants_immutable",
        def: "CREATE TRIGGER access_grants_immutable BEFORE UPDATE ON bricx.access_grants FOR EACH ROW EXECUTE FUNCTION bricx.access_grants_immutable()",
        enabled: "O",
      },
    ]);
  });

  test.each(IMMUTABLE.slice(0, 7))(
    "bricx_app in the grant's org cannot UPDATE %s (42501: no column privilege)",
    async (column, value) => {
      const { open } = await seedEnds();
      expect(
        await outcome(
          "bricx_app",
          ctxA,
          `UPDATE bricx.access_grants SET ${column} = ${value} WHERE id = $1`,
          [open],
        ),
      ).toBe(DENIED);
    },
  );

  test.each(IMMUTABLE)(
    "the trigger binds every role, the superuser included: %s never changes (42501)",
    async (column, value) => {
      const { open } = await seedEnds();
      expect(
        await adminOutcome(
          `UPDATE bricx.access_grants SET ${column} = ${value} WHERE id = $1`,
          [open],
        ),
      ).toBe(DENIED);
    },
  );

  test("no un-revoke: clearing revoked_at/revoked_by, moving revoked_at or changing revoked_by is 42501, as bricx_app and as the superuser", async () => {
    const { revoked } = await seedEnds();
    const attempts = [
      "SET revoked_at = NULL, revoked_by = NULL",
      "SET revoked_at = revoked_at + interval '1 minute'",
      `SET revoked_by = '${users.subject}'::uuid`,
    ];
    for (const set of attempts) {
      const text = `UPDATE bricx.access_grants ${set} WHERE id = $1`;
      expect(await outcome("bricx_app", ctxA, text, [revoked]), set).toBe(
        DENIED,
      );
      expect(await adminOutcome(text, [revoked]), set).toBe(DENIED);
    }
  });

  test("no un-expire: clearing or moving expired_at is 42501, as bricx_app and as the superuser", async () => {
    const { expired } = await seedEnds();
    for (const set of [
      "SET expired_at = NULL",
      "SET expired_at = expired_at + interval '1 minute'",
    ]) {
      const text = `UPDATE bricx.access_grants ${set} WHERE id = $1`;
      expect(await outcome("bricx_app", ctxA, text, [expired]), set).toBe(
        DENIED,
      );
      expect(await adminOutcome(text, [expired]), set).toBe(DENIED);
    }
  });

  test("no second end: revoking an expired grant, expiring a revoked one, or setting both at once is 42501", async () => {
    const { revoked, expired, due } = await seedEnds();
    const revoke = `UPDATE bricx.access_grants SET revoked_at = now(), revoked_by = '${users.granter}'::uuid WHERE id = $1`;
    const expire =
      "UPDATE bricx.access_grants SET expired_at = now() WHERE id = $1";
    const both = `UPDATE bricx.access_grants SET revoked_at = now(), revoked_by = '${users.granter}'::uuid, expired_at = now() WHERE id = $1`;
    expect(await outcome("bricx_app", ctxA, revoke, [expired])).toBe(DENIED);
    expect(await outcome("bricx_app", ctxA, expire, [revoked])).toBe(DENIED);
    expect(await outcome("bricx_app", ctxA, both, [due])).toBe(DENIED);
    expect(await adminOutcome(revoke, [expired])).toBe(DENIED);
    expect(await adminOutcome(expire, [revoked])).toBe(DENIED);
    expect(await adminOutcome(both, [due])).toBe(DENIED);
  });

  test("revoke and expire still work for bricx_app in the grant's org (one row each); a no-op UPDATE of an end column that keeps its value passes", async () => {
    const { open, revoked, due } = await seedEnds();
    expect(
      await outcome(
        "bricx_app",
        ctxA,
        `UPDATE bricx.access_grants SET revoked_at = now(), revoked_by = '${users.granter}'::uuid WHERE id = $1`,
        [open],
      ),
    ).toBe("ok:1");
    expect(
      await outcome(
        "bricx_app",
        ctxA,
        "UPDATE bricx.access_grants SET expired_at = now() WHERE id = $1 AND expires_at <= now()",
        [due],
      ),
    ).toBe("ok:1");
    expect(
      await outcome(
        "bricx_app",
        ctxA,
        "UPDATE bricx.access_grants SET revoked_at = revoked_at, revoked_by = revoked_by WHERE id = $1",
        [revoked],
      ),
    ).toBe("ok:1");
  });
});

describe("endAccessGrantsOf(tx, orgId, userId, by, now, projectId?) (@bricx/db/access-grants; P5-07, ROADMAP Also, rule 13)", () => {
  test("ends the user's open grants in the org (pending included), only those scoped to projectId when given, oldest id first; never an elapsed, revoked or expired one, another user's or another org's", async () => {
    const now = await dbNow();
    const user = nextId();
    const neighbour = nextId();
    await insertUser(user);
    await insertUser(neighbour);
    const elsewhere = nextId();
    const window = { startsAt: at(now - HOUR), expiresAt: at(now + HOUR) };
    const onProject = await insertGrant({ user, ...window });
    const onOther = await insertGrant({ user, ...window, scope: elsewhere });
    const orgWide = await insertGrant({
      user,
      ...window,
      permission: READ,
      scope: null,
    });
    const pending = await insertGrant({
      user,
      startsAt: at(now + HOUR),
      expiresAt: at(now + 2 * HOUR),
    });
    const elapsed = await insertGrant({
      user,
      startsAt: at(now - 2 * HOUR),
      expiresAt: at(now - HOUR),
      createdAt: at(now - 2 * HOUR),
    });
    const revoked = await insertGrant({
      user,
      ...window,
      revokedAt: at(now - HOUR / 2),
      revokedBy: users.granter,
    });
    const theirs = await insertGrant({ user: neighbour, ...window });
    const inB = await insertGrant({ user, ...window, org: ORG_B });
    const ctx = { orgId: ORG_A, userId: users.granter, projectIds: [] };
    const stamp = at(now);

    const project = await app.withTx(ctx, (tx) =>
      endAccessGrantsOf(tx, ORG_A, user, users.granter, stamp, PROJECT),
    );
    expect(project).toEqual(
      [onProject, pending]
        .sort()
        .map((id) => ({ id, revokedAt: stamp, revokedBy: users.granter })),
    );

    const rest = await app.withTx(ctx, (tx) =>
      endAccessGrantsOf(tx, ORG_A, user, users.granter, stamp),
    );
    expect(rest).toEqual(
      [onOther, orgWide]
        .sort()
        .map((id) => ({ id, revokedAt: stamp, revokedBy: users.granter })),
    );
    expect(
      await app.withTx(ctx, (tx) =>
        endAccessGrantsOf(tx, ORG_A, user, users.granter, stamp),
      ),
    ).toEqual([]);

    const untouched = await asAdmin<{ id: string; r: string | null }>(
      "SELECT id::text, revoked_at::text AS r FROM bricx.access_grants WHERE id = ANY($1::uuid[]) ORDER BY id",
      [[elapsed, theirs, inB]],
    );
    expect(untouched.map((row) => row.r)).toEqual([null, null, null]);
    const [kept] = await asAdmin<{ r: string }>(
      "SELECT to_char(revoked_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS r FROM bricx.access_grants WHERE id = $1",
      [revoked],
    );
    expect(kept?.r).toBe(at(now - HOUR / 2));
  });

  test("ids and the instant are checked before any SQL: a malformed org, user, by or project id is invalid_id, a non-ISO instant invalid_instant", async () => {
    const ctx = { orgId: ORG_A, userId: users.granter, projectIds: [] };
    const stamp = at(NOW);
    const calls: [string, string, string, string | undefined][] = [
      ["not-a-uuid", users.subject, users.granter, undefined],
      [ORG_A, "not-a-uuid", users.granter, undefined],
      [ORG_A, users.subject, "not-a-uuid", undefined],
      [ORG_A, users.subject, users.granter, "not-a-uuid"],
    ];
    for (const [org, user, by, project] of calls) {
      let caught: unknown;
      try {
        await app.withTx(ctx, (tx) =>
          endAccessGrantsOf(tx, org, user, by, stamp, project),
        );
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AccessGrantError);
      expect(caught).toMatchObject({ code: "invalid_id" });
    }
    let instant: unknown;
    try {
      await app.withTx(ctx, (tx) =>
        endAccessGrantsOf(tx, ORG_A, users.subject, users.granter, "now"),
      );
    } catch (error) {
      instant = error;
    }
    expect(instant).toBeInstanceOf(AccessGrantError);
    expect(instant).toMatchObject({ code: "invalid_instant" });
  });
});
