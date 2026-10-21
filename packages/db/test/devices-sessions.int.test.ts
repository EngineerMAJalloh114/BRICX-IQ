// P5-03 (ADR 0063; owner conditions 1 and 3): bricx.devices and
// bricx.sessions against compose.yml's Postgres with the production
// journal, applied by the real migrator as bricx_owner.
// - devices (user table, USER_TABLES): one row per physical device, no
//   org_id, user_id -> users. ENABLE + FORCE; bricx_app sees, inserts and
//   updates its own rows only, and may UPDATE name, last_seen_at and
//   revoked_at only (condition 1): never user_id, trusted (P5-07) or id;
//   revoked_at goes from NULL to a value once and never back; no DELETE,
//   no TRUNCATE.
// - sessions (tenant table, TENANT_TABLES, resource org.session): one row
//   per (org, Keycloak session), user_id -> users, device_id -> devices.
//   The tenant policies plus own-row policies on user_id alone, so a user
//   reads and revokes their own sessions in every org (condition 3; the
//   API's ability keeps another user's sessions behind
//   org.session.read.org). revoked_at never goes back; id, org_id,
//   user_id, keycloak_sid and created_at never change.
// - Foreign keys: a session for an unknown user or device is refused.
import { randomUUID } from "node:crypto";
import {
  type BootstrappedPostgres,
  type Role,
  appDatabase,
  exampleValue,
  rolePasswordKeys,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { migrate } from "../src/migrate.js";
import {
  DEVICE_APP_COLUMNS,
  OWN_ROW_TABLES,
  TENANT_TABLES,
  USER_TABLES,
} from "../src/rls.js";
import {
  type TxContext,
  contextStatement,
  validateTxContext,
} from "../src/tx.js";
import { PgDialect } from "drizzle-orm/pg-core";

const ORG_A = "0199e1a0-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1a0-0000-7000-8000-0000000000b1";
const ORG_C = "0199e1a0-0000-7000-8000-0000000000c1";
const U1 = "0199e1a0-0000-7000-8000-000000000101";
const U2 = "0199e1a0-0000-7000-8000-000000000102";
const T0 = "2026-10-21T09:00:00.000Z";
const T1 = "2026-10-21T09:05:00.000Z";
const T2 = "2026-10-21T09:10:00.000Z";
const DENIED = "42501";
const FK = "23503";
const CHECK = "23514";
const dialect = new PgDialect();

let pg18: BootstrappedPostgres;
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

const ctx = (orgId: string, userId: string): TxContext => ({
  orgId,
  userId,
  projectIds: [],
});

/** Runs `run` as `who` in a transaction with `context`, then commits (or rolls back on `rollback`). */
async function asRole<T>(
  who: Role,
  context: TxContext | undefined,
  run: (client: pg.Client) => Promise<T>,
  rollback = false,
): Promise<T> {
  const client = await pg18.connectAs(who);
  try {
    await client.query("BEGIN");
    try {
      if (context !== undefined) {
        const q = dialect.sqlToQuery(
          contextStatement(validateTxContext(context), 30_000),
        );
        await client.query(q.sql, q.params);
      }
      const out = await run(client);
      await client.query(rollback ? "ROLLBACK" : "COMMIT");
      return out;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    await client.end();
  }
}

/** "ok:<rowCount>" or the SQLSTATE, as `who` in `context`, rolled back. */
async function outcome(
  who: Role,
  context: TxContext | undefined,
  text: string,
  params: unknown[] = [],
): Promise<string> {
  return asRole(
    who,
    context,
    async (client) => {
      try {
        const result = await client.query(text, params);
        return `ok:${String(result.rowCount)}`;
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error) {
          return String(error.code);
        }
        throw error;
      }
    },
    true,
  );
}

async function adminOutcome(text: string, params: unknown[] = []) {
  return asAdmin(text, params).then(
    () => "ok",
    (error: unknown) =>
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "unknown",
  );
}

/** A device row of `userId`, inserted by the superuser. */
async function seedDevice(userId: string, id = nextId()): Promise<string> {
  await asAdmin(
    `INSERT INTO bricx.devices (id, user_id, platform, name, created_at, last_seen_at)
     VALUES ($1, $2, 'ios', 'seed', $3, $3)`,
    [id, userId, T0],
  );
  return id;
}

/** A session row of `userId` in `orgId`, inserted by the superuser. */
async function seedSession(
  orgId: string,
  userId: string,
  deviceId: string | null = null,
  id = nextId(),
): Promise<string> {
  await asAdmin(
    `INSERT INTO bricx.sessions (id, org_id, user_id, device_id, keycloak_sid, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $6)`,
    [id, orgId, userId, deviceId, randomUUID(), T0],
  );
  return id;
}

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"));
  for (const user of [U1, U2]) {
    await asAdmin(
      "INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at) VALUES ($1, $2, $3, $3)",
      [user, `sub-${user}`, T0],
    );
  }
});
afterAll(async () => {
  await pg18.container.stop();
});

describe("the registries (ADR 0063)", () => {
  test("devices is a user table; sessions is the tenant table of org.session with own-row policies on user_id", () => {
    expect(USER_TABLES["bricx.devices"]).toBe("devices");
    expect(TENANT_TABLES["bricx.sessions"]).toBe("org.session");
    expect(OWN_ROW_TABLES).toEqual({ "bricx.sessions": "user_id" });
    expect(DEVICE_APP_COLUMNS).toEqual(["name", "last_seen_at", "revoked_at"]);
  });
});

describe("bricx.devices: the table", () => {
  test("columns: id, user_id, platform, name, created_at, last_seen_at, trusted (default false), revoked_at (nullable)", async () => {
    expect(
      await asAdmin(
        `SELECT column_name AS c, data_type AS t, is_nullable AS n
         FROM information_schema.columns
         WHERE table_schema = 'bricx' AND table_name = 'devices'
         ORDER BY ordinal_position`,
      ),
    ).toEqual([
      { c: "id", t: "uuid", n: "NO" },
      { c: "user_id", t: "uuid", n: "NO" },
      { c: "platform", t: "text", n: "NO" },
      { c: "name", t: "text", n: "NO" },
      { c: "created_at", t: "timestamp with time zone", n: "NO" },
      { c: "last_seen_at", t: "timestamp with time zone", n: "NO" },
      { c: "trusted", t: "boolean", n: "NO" },
      { c: "revoked_at", t: "timestamp with time zone", n: "YES" },
    ]);
    expect(
      await asAdmin(
        `SELECT column_default AS d FROM information_schema.columns
         WHERE table_schema = 'bricx' AND table_name = 'devices' AND column_name = 'trusted'`,
      ),
    ).toEqual([{ d: "false" }]);
  });

  test("no org_id; user_id -> bricx.users", async () => {
    expect(
      await asAdmin(
        `SELECT c.confrelid::regclass::text AS parent FROM pg_constraint c
         WHERE c.conrelid = 'bricx.devices'::regclass AND c.contype = 'f'`,
      ),
    ).toEqual([{ parent: "bricx.users" }]);
    expect(
      await adminOutcome(
        `INSERT INTO bricx.devices (id, user_id, platform, name, created_at, last_seen_at)
         VALUES ($1, $2, 'ios', 'orphan', $3, $3)`,
        [nextId(), nextId(), T0],
      ),
    ).toBe(FK);
  });

  test("ENABLE + FORCE RLS, exactly the three own-row policies", async () => {
    expect(
      await asAdmin(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class WHERE oid = 'bricx.devices'::regclass`,
      ),
    ).toEqual([{ enabled: true, forced: true }]);
    expect(
      await asAdmin(
        `SELECT policyname AS name, cmd, roles::text[] AS roles, qual, with_check AS check
         FROM pg_policies WHERE schemaname = 'bricx' AND tablename = 'devices'
         ORDER BY policyname`,
      ),
    ).toEqual([
      {
        name: "devices_self_insert",
        cmd: "INSERT",
        roles: ["bricx_app"],
        qual: null,
        check: "(user_id = app.current_user_id())",
      },
      {
        name: "devices_self_select",
        cmd: "SELECT",
        roles: ["bricx_app", "bricx_readonly"],
        qual: "(user_id = app.current_user_id())",
        check: null,
      },
      {
        name: "devices_self_update",
        cmd: "UPDATE",
        roles: ["bricx_app"],
        qual: "(user_id = app.current_user_id())",
        check: "(user_id = app.current_user_id())",
      },
    ]);
  });

  test("grants (condition 1): bricx_app SELECT, INSERT and UPDATE on name, last_seen_at, revoked_at only; readonly SELECT; powersync_repl nothing; no DELETE or TRUNCATE for anyone but the owner", async () => {
    expect(
      await asAdmin(
        `SELECT r.rolname AS role,
                string_agg(p.privilege, ',' ORDER BY p.privilege) AS privileges
         FROM pg_roles r
         CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p(privilege)
         WHERE r.rolname IN ('bricx_app', 'bricx_readonly', 'powersync_repl', 'bricx_relay')
           AND has_table_privilege(r.rolname, 'bricx.devices', p.privilege)
         GROUP BY r.rolname ORDER BY r.rolname`,
      ),
    ).toEqual([
      { role: "bricx_app", privileges: "INSERT,SELECT" },
      { role: "bricx_readonly", privileges: "SELECT" },
    ]);
    expect(
      await asAdmin(
        `SELECT c.column_name AS c
         FROM information_schema.columns c
         WHERE c.table_schema = 'bricx' AND c.table_name = 'devices'
           AND has_column_privilege('bricx_app', 'bricx.devices', c.column_name, 'UPDATE')
           AND NOT has_table_privilege('bricx_app', 'bricx.devices', 'UPDATE')
         ORDER BY c.ordinal_position`,
      ),
    ).toEqual([...DEVICE_APP_COLUMNS].map((c) => ({ c })));
    expect(
      await asAdmin(
        `SELECT count(*)::int AS n FROM information_schema.columns c
         WHERE c.table_schema = 'bricx' AND c.table_name = 'devices'
           AND has_column_privilege('bricx_readonly', 'bricx.devices', c.column_name, 'UPDATE')`,
      ),
    ).toEqual([{ n: 0 }]);
  });

  test("not in publication powersync (no sync of devices before P8)", async () => {
    expect(
      await asAdmin(
        `SELECT count(*)::int AS n FROM pg_publication_tables
         WHERE pubname = 'powersync' AND schemaname = 'bricx' AND tablename IN ('devices', 'sessions')`,
      ),
    ).toEqual([{ n: 0 }]);
  });

  test("CHECKs: id is a UUIDv7, platform is ios, android or web, name 1-100 characters, last_seen_at and revoked_at never before created_at", async () => {
    const insert = (
      id: string,
      platform: string,
      name: string,
      created: string,
      seen: string,
      revoked: string | null = null,
    ) =>
      adminOutcome(
        `INSERT INTO bricx.devices (id, user_id, platform, name, created_at, last_seen_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, U1, platform, name, created, seen, revoked],
      );
    expect(
      await insert("0199e1a0-0000-4000-8000-000000000001", "ios", "v4", T0, T0),
    ).toBe(CHECK);
    expect(await insert(nextId(), "windows", "x", T0, T0)).toBe(CHECK);
    expect(await insert(nextId(), "IOS", "x", T0, T0)).toBe(CHECK);
    expect(await insert(nextId(), "ios", "", T0, T0)).toBe(CHECK);
    expect(await insert(nextId(), "ios", "x".repeat(101), T0, T0)).toBe(CHECK);
    expect(await insert(nextId(), "ios", "early", T1, T0)).toBe(CHECK);
    expect(await insert(nextId(), "ios", "revoked early", T1, T1, T0)).toBe(
      CHECK,
    );
    expect(await insert(nextId(), "android", "x".repeat(100), T0, T1, T1)).toBe(
      "ok",
    );
  });
});

describe("bricx.devices: bricx_app on its own rows (condition 1)", () => {
  const INSERT = `INSERT INTO bricx.devices (id, user_id, platform, name, created_at, last_seen_at)
                  VALUES ($1, $2, 'web', 'mine', $3, $3)`;

  test("inserts a device of the context's user; another user's device is refused", async () => {
    expect(
      await outcome("bricx_app", ctx(ORG_A, U1), INSERT, [nextId(), U1, T0]),
    ).toBe("ok:1");
    expect(
      await outcome("bricx_app", ctx(ORG_A, U1), INSERT, [nextId(), U2, T0]),
    ).toBe(DENIED);
    expect(
      await outcome("bricx_app", undefined, INSERT, [nextId(), U1, T0]),
    ).toBe(DENIED);
  });

  test("sees its own devices in any org, never another user's; readonly the same", async () => {
    const mine = await seedDevice(U1);
    const theirs = await seedDevice(U2);
    const visible = (who: Role, context: TxContext | undefined) =>
      asRole(
        who,
        context,
        async (client) =>
          (
            await client.query<{ id: string }>(
              "SELECT id::text AS id FROM bricx.devices ORDER BY id",
            )
          ).rows.map((r) => r.id),
        true,
      );
    expect(await visible("bricx_app", undefined)).toEqual([]);
    expect((await visible("bricx_app", ctx(ORG_A, U1))).includes(mine)).toBe(
      true,
    );
    expect((await visible("bricx_app", ctx(ORG_B, U1))).includes(mine)).toBe(
      true,
    );
    expect((await visible("bricx_app", ctx(ORG_A, U1))).includes(theirs)).toBe(
      false,
    );
    expect(
      (await visible("bricx_readonly", ctx(ORG_A, U2))).includes(theirs),
    ).toBe(true);
    expect(
      (await visible("bricx_readonly", ctx(ORG_A, U2))).includes(mine),
    ).toBe(false);
  });

  test("updates name, last_seen_at and revoked_at of its own device; another user's device: no row", async () => {
    const mine = await seedDevice(U1);
    const theirs = await seedDevice(U2);
    expect(
      await outcome(
        "bricx_app",
        ctx(ORG_A, U1),
        "UPDATE bricx.devices SET name = 'renamed', last_seen_at = $2 WHERE id = $1",
        [mine, T1],
      ),
    ).toBe("ok:1");
    expect(
      await outcome(
        "bricx_app",
        ctx(ORG_A, U1),
        "UPDATE bricx.devices SET name = 'renamed' WHERE id = $1",
        [theirs],
      ),
    ).toBe("ok:0");
    expect(
      await outcome(
        "bricx_app",
        ctx(ORG_A, U1),
        "UPDATE bricx.devices SET revoked_at = $2 WHERE id = $1",
        [mine, T1],
      ),
    ).toBe("ok:1");
  });

  test("cannot change user_id, trusted or id (column privilege: 42501)", async () => {
    const mine = await seedDevice(U1);
    for (const set of ["user_id = $2", "trusted = true", "id = $2"]) {
      expect(
        await outcome(
          "bricx_app",
          ctx(ORG_A, U1),
          `UPDATE bricx.devices SET ${set} WHERE id = $1`,
          set.includes("$2") ? [mine, nextId()] : [mine],
        ),
        set,
      ).toBe(DENIED);
    }
    // The owner, bound by FORCE and without a policy, changes nothing either.
    expect(
      await outcome(
        "bricx_owner",
        ctx(ORG_A, U1),
        "UPDATE bricx.devices SET trusted = true WHERE id = $1",
        [mine],
      ),
    ).toBe("ok:0");
  });

  test("revoked_at goes from NULL to a value once, never back and never to another value (42501), for the owner too", async () => {
    const mine = await seedDevice(U1);
    await asRole("bricx_app", ctx(ORG_A, U1), (client) =>
      client.query("UPDATE bricx.devices SET revoked_at = $2 WHERE id = $1", [
        mine,
        T1,
      ]),
    );
    expect(
      await outcome(
        "bricx_app",
        ctx(ORG_A, U1),
        "UPDATE bricx.devices SET revoked_at = NULL WHERE id = $1",
        [mine],
      ),
    ).toBe(DENIED);
    expect(
      await outcome(
        "bricx_app",
        ctx(ORG_A, U1),
        "UPDATE bricx.devices SET revoked_at = $2 WHERE id = $1",
        [mine, T2],
      ),
    ).toBe(DENIED);
    // The same value again is a no-op, not a change.
    expect(
      await outcome(
        "bricx_app",
        ctx(ORG_A, U1),
        "UPDATE bricx.devices SET revoked_at = $2 WHERE id = $1",
        [mine, T1],
      ),
    ).toBe("ok:1");
    expect(
      await adminOutcome(
        "UPDATE bricx.devices SET revoked_at = NULL WHERE id = $1",
        [mine],
      ),
    ).toBe(DENIED);
    expect(
      await asAdmin(
        "SELECT revoked_at IS NOT NULL AS revoked FROM bricx.devices WHERE id = $1",
        [mine],
      ),
    ).toEqual([{ revoked: true }]);
  });

  test("no DELETE and no TRUNCATE for bricx_app or bricx_readonly (42501)", async () => {
    const mine = await seedDevice(U1);
    for (const who of ["bricx_app", "bricx_readonly"] as const) {
      expect(
        await outcome(
          who,
          ctx(ORG_A, U1),
          "DELETE FROM bricx.devices WHERE id = $1",
          [mine],
        ),
        who,
      ).toBe(DENIED);
      expect(
        await outcome(who, ctx(ORG_A, U1), "TRUNCATE bricx.devices"),
        who,
      ).toBe(DENIED);
    }
    expect(
      await outcome("bricx_readonly", ctx(ORG_A, U1), INSERT, [
        nextId(),
        U1,
        T0,
      ]),
    ).toBe(DENIED);
    expect(
      await outcome(
        "bricx_readonly",
        ctx(ORG_A, U1),
        "UPDATE bricx.devices SET name = 'x' WHERE id = $1",
        [mine],
      ),
    ).toBe(DENIED);
  });
});

describe("bricx.sessions: the table", () => {
  test("columns: id, org_id, user_id, device_id (nullable), keycloak_sid, created_at, last_seen_at, revoked_at (nullable)", async () => {
    expect(
      await asAdmin(
        `SELECT column_name AS c, data_type AS t, is_nullable AS n
         FROM information_schema.columns
         WHERE table_schema = 'bricx' AND table_name = 'sessions'
         ORDER BY ordinal_position`,
      ),
    ).toEqual([
      { c: "id", t: "uuid", n: "NO" },
      { c: "org_id", t: "uuid", n: "NO" },
      { c: "user_id", t: "uuid", n: "NO" },
      { c: "device_id", t: "uuid", n: "YES" },
      { c: "keycloak_sid", t: "text", n: "NO" },
      { c: "created_at", t: "timestamp with time zone", n: "NO" },
      { c: "last_seen_at", t: "timestamp with time zone", n: "NO" },
      { c: "revoked_at", t: "timestamp with time zone", n: "YES" },
    ]);
  });

  test("user_id -> users and device_id -> devices; (org_id, keycloak_sid) is unique", async () => {
    expect(
      await asAdmin(
        `SELECT c.confrelid::regclass::text AS parent FROM pg_constraint c
         WHERE c.conrelid = 'bricx.sessions'::regclass AND c.contype = 'f' ORDER BY 1`,
      ),
    ).toEqual([{ parent: "bricx.devices" }, { parent: "bricx.users" }]);
    expect(
      await adminOutcome(
        `INSERT INTO bricx.sessions (id, org_id, user_id, keycloak_sid, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $5)`,
        [nextId(), ORG_A, nextId(), randomUUID(), T0],
      ),
    ).toBe(FK);
    expect(
      await adminOutcome(
        `INSERT INTO bricx.sessions (id, org_id, user_id, device_id, keycloak_sid, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [nextId(), ORG_A, U1, nextId(), randomUUID(), T0],
      ),
    ).toBe(FK);
    const sid = randomUUID();
    const insert = (org: string) =>
      adminOutcome(
        `INSERT INTO bricx.sessions (id, org_id, user_id, keycloak_sid, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $5)`,
        [nextId(), org, U1, sid, T0],
      );
    expect(await insert(ORG_A)).toBe("ok");
    expect(await insert(ORG_A)).toBe("23505");
    // The same Keycloak session signed into another org is another row.
    expect(await insert(ORG_B)).toBe("ok");
  });

  test("CHECKs: id is a UUIDv7, keycloak_sid 1-255 characters, last_seen_at and revoked_at never before created_at", async () => {
    const insert = (
      id: string,
      sid: string,
      created: string,
      seen: string,
      revoked: string | null = null,
    ) =>
      adminOutcome(
        `INSERT INTO bricx.sessions (id, org_id, user_id, keycloak_sid, created_at, last_seen_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, ORG_A, U1, sid, created, seen, revoked],
      );
    expect(
      await insert(
        "0199e1a0-0000-4000-8000-000000000002",
        randomUUID(),
        T0,
        T0,
      ),
    ).toBe(CHECK);
    expect(await insert(nextId(), "", T0, T0)).toBe(CHECK);
    expect(await insert(nextId(), "s".repeat(256), T0, T0)).toBe(CHECK);
    expect(await insert(nextId(), randomUUID(), T1, T0)).toBe(CHECK);
    expect(await insert(nextId(), randomUUID(), T1, T1, T0)).toBe(CHECK);
    expect(await insert(nextId(), "s".repeat(255), T0, T1, T1)).toBe("ok");
  });

  test("ENABLE + FORCE; the tenant policies of org.session plus the two own-row policies; the tenant grants", async () => {
    expect(
      await asAdmin(
        `SELECT policyname AS name, cmd, qual, with_check AS check,
                (SELECT array_agg(r ORDER BY r) FROM unnest(roles::text[]) AS r) AS roles
         FROM pg_policies WHERE schemaname = 'bricx' AND tablename = 'sessions'
         ORDER BY policyname`,
      ),
    ).toEqual([
      {
        name: "sessions_insert",
        cmd: "INSERT",
        roles: ["bricx_app", "bricx_owner"],
        qual: null,
        check: "(org_id = app.current_org())",
      },
      {
        name: "sessions_own_select",
        cmd: "SELECT",
        roles: ["bricx_app", "bricx_readonly"],
        qual: "(user_id = app.current_user_id())",
        check: null,
      },
      {
        name: "sessions_own_update",
        cmd: "UPDATE",
        roles: ["bricx_app"],
        qual: "(user_id = app.current_user_id())",
        check: "(user_id = app.current_user_id())",
      },
      {
        name: "sessions_select",
        cmd: "SELECT",
        roles: ["bricx_app", "bricx_owner", "bricx_readonly"],
        qual: "(org_id = app.current_org())",
        check: null,
      },
      {
        name: "sessions_update",
        cmd: "UPDATE",
        roles: ["bricx_app", "bricx_owner"],
        qual: "(org_id = app.current_org())",
        check: "(org_id = app.current_org())",
      },
    ]);
  });
});

describe("bricx.sessions: own rows in every org (condition 3) and the tenant boundary", () => {
  test("a user sees and revokes their own sessions in every org; another user's session in another org is invisible", async () => {
    const inA = await seedSession(ORG_A, U1);
    const inB = await seedSession(ORG_B, U1);
    const other = await seedSession(ORG_C, U2);
    const visible = (who: Role, context: TxContext) =>
      asRole(
        who,
        context,
        async (client) =>
          (
            await client.query<{ id: string }>(
              "SELECT id::text AS id FROM bricx.sessions ORDER BY id",
            )
          ).rows.map((r) => r.id),
        true,
      );
    const seen = await visible("bricx_app", ctx(ORG_A, U1));
    expect(seen).toContain(inA);
    expect(seen).toContain(inB);
    expect(seen).not.toContain(other);
    expect(await visible("bricx_readonly", ctx(ORG_A, U1))).toContain(inB);
    // Revoke the session in org B from a request in org A: the own-row UPDATE policy.
    expect(
      await outcome(
        "bricx_app",
        ctx(ORG_A, U1),
        "UPDATE bricx.sessions SET revoked_at = $2 WHERE id = $1",
        [inB, T1],
      ),
    ).toBe("ok:1");
    expect(
      await outcome(
        "bricx_app",
        ctx(ORG_A, U1),
        "UPDATE bricx.sessions SET revoked_at = $2 WHERE id = $1",
        [other, T1],
      ),
    ).toBe("ok:0");
  });

  test("the tenant policy: a request in org A sees every session of org A (the API's ability decides who may), none of org C", async () => {
    const theirsInA = await seedSession(ORG_A, U2);
    const theirsInC = await seedSession(ORG_C, U2);
    const seen = await asRole(
      "bricx_app",
      ctx(ORG_A, U1),
      async (client) =>
        (
          await client.query<{ id: string }>(
            "SELECT id::text AS id FROM bricx.sessions",
          )
        ).rows.map((r) => r.id),
      true,
    );
    expect(seen).toContain(theirsInA);
    expect(seen).not.toContain(theirsInC);
    expect(
      await outcome("bricx_app", undefined, "SELECT 1 FROM bricx.sessions"),
    ).toBe("ok:0");
  });

  test("inserts: the context's org only (the user may differ: the guard inserts for the request's user)", async () => {
    const insert = `INSERT INTO bricx.sessions (id, org_id, user_id, keycloak_sid, created_at, last_seen_at) VALUES ($1, $2, $3, $4, $5, $5)`;
    expect(
      await outcome("bricx_app", ctx(ORG_A, U1), insert, [
        nextId(),
        ORG_A,
        U1,
        randomUUID(),
        T0,
      ]),
    ).toBe("ok:1");
    expect(
      await outcome("bricx_app", ctx(ORG_A, U1), insert, [
        nextId(),
        ORG_B,
        U1,
        randomUUID(),
        T0,
      ]),
    ).toBe(DENIED);
    expect(
      await outcome("bricx_readonly", ctx(ORG_A, U1), insert, [
        nextId(),
        ORG_A,
        U1,
        randomUUID(),
        T0,
      ]),
    ).toBe(DENIED);
  });

  test("revoked_at never goes back (42501); id, org_id, user_id, keycloak_sid and created_at never change (42501); no row is ever deleted", async () => {
    const mine = await seedSession(ORG_A, U1);
    await asRole("bricx_app", ctx(ORG_A, U1), (client) =>
      client.query("UPDATE bricx.sessions SET revoked_at = $2 WHERE id = $1", [
        mine,
        T1,
      ]),
    );
    expect(
      await outcome(
        "bricx_app",
        ctx(ORG_A, U1),
        "UPDATE bricx.sessions SET revoked_at = NULL WHERE id = $1",
        [mine],
      ),
    ).toBe(DENIED);
    expect(
      await outcome(
        "bricx_app",
        ctx(ORG_A, U1),
        "UPDATE bricx.sessions SET revoked_at = $2 WHERE id = $1",
        [mine, T2],
      ),
    ).toBe(DENIED);
    expect(
      await adminOutcome(
        "UPDATE bricx.sessions SET revoked_at = NULL WHERE id = $1",
        [mine],
      ),
    ).toBe(DENIED);
    const live = await seedSession(ORG_A, U1);
    for (const [set, params] of [
      ["id = $2", [live, nextId()]],
      ["org_id = $2", [live, ORG_B]],
      ["user_id = $2", [live, U2]],
      ["keycloak_sid = 'other'", [live]],
      ["created_at = $2", [live, T1]],
    ] as const) {
      expect(
        await outcome(
          "bricx_app",
          ctx(ORG_A, U1),
          `UPDATE bricx.sessions SET ${set} WHERE id = $1`,
          [...params],
        ),
        set,
      ).toBe(DENIED);
    }
    expect(
      await outcome(
        "bricx_app",
        ctx(ORG_A, U1),
        "UPDATE bricx.sessions SET last_seen_at = $2 WHERE id = $1",
        [live, T1],
      ),
    ).toBe("ok:1");
    expect(
      await outcome(
        "bricx_app",
        ctx(ORG_A, U1),
        "DELETE FROM bricx.sessions WHERE id = $1",
        [live],
      ),
    ).toBe("ok:0");
    expect(
      await outcome("bricx_app", ctx(ORG_A, U1), "TRUNCATE bricx.sessions"),
    ).toBe(DENIED);
    expect(
      await outcome(
        "bricx_readonly",
        ctx(ORG_A, U1),
        "DELETE FROM bricx.sessions",
      ),
    ).toBe(DENIED);
  });
});
