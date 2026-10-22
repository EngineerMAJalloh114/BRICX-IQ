// P4-06 (ADR 0056): bricx.outbox against compose.yml's Postgres with the
// real init folder and the production journal (applied as bricx_owner).
// - bricx_app may only INSERT (id, org_id, topic, payload) for its own org:
//   no SELECT, UPDATE or DELETE, so insertOutbox() uses no RETURNING and no
//   ON CONFLICT (condition 7). The org comes from the transaction.
// - bricx_relay (D12) reads every org's rows (policies TO bricx_relay, the
//   role stays NOBYPASSRLS) and may UPDATE only the delivery columns; it
//   can read or write no other table in bricx, app or bricx_migrations.
// - withRelayTx() runs only as bricx_relay, with a 30 s statement_timeout
//   and no tenant context; the role carries an
//   idle_in_transaction_session_timeout (condition 6).
// - The CHECKs (topic, attempts, never published and dead) and FORCE: the
//   owner sees nothing and a plain owner DELETE deletes 0 rows.
import { randomUUID } from "node:crypto";
import {
  type BootstrappedPostgres,
  type Role,
  appDatabase,
  exampleValue,
  rolePasswordKeys,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type Database,
  NestedTransactionError,
  type RelayDatabase,
  RelayRoleError,
  openDatabase,
  openRelayDatabase,
} from "../src/database.js";
import { migrate } from "../src/migrate.js";
import {
  OutboxError,
  claimOutboxBatch,
  insertOutbox,
  markOutboxFailed,
  markOutboxPublished,
} from "../src/outbox.js";
import { OUTBOX_RELAY_COLUMNS, SYSTEM_TENANT_TABLES } from "../src/rls.js";

const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const ORG_B = "0199e1a0-0000-7000-8000-00000000000b";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const DENIED = "42501";
const CHECK_VIOLATION = "23514";
const ctx = (orgId: string) => ({ orgId, userId: USER, projectIds: [] });

let pg18: BootstrappedPostgres;
let app: Database;
let relay: RelayDatabase;
let n = 0;
/** A fresh UUIDv7 (time-ordered within this run). */
const id7 = (): string => {
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

/** "ok:<rowCount>" or the SQLSTATE, as `who`, in a rolled-back transaction. */
async function outcome(
  who: Role,
  text: string,
  params: unknown[] = [],
  orgId?: string,
): Promise<string> {
  const client = await pg18.connectAs(who);
  try {
    await client.query("BEGIN");
    try {
      if (orgId !== undefined) {
        await client.query("SELECT set_config('app.org_id', $1, true)", [
          orgId,
        ]);
      }
      const result = await client.query(text, params);
      return `ok:${String(result.rowCount)}`;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        return String(error.code);
      }
      throw error;
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}

/** Seeds one pending row as the test superuser (RLS does not apply). */
async function seed(
  orgId: string,
  values: Record<string, unknown> = {},
): Promise<string> {
  const id = id7();
  const row: Record<string, unknown> = {
    id,
    org_id: orgId,
    topic: "system.ping",
    payload: "{}",
    ...values,
  };
  const names = Object.keys(row);
  await asAdmin(
    `INSERT INTO bricx.outbox (${names.join(", ")}) VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(", ")})`,
    Object.values(row),
  );
  return id;
}

async function rowOf(id: string) {
  const rows = await asAdmin<{
    org_id: string;
    topic: string;
    payload: unknown;
    attempts: number;
    published: boolean;
    dead: boolean;
    last_error: string | null;
    backoff_s: string | null;
  }>(
    `SELECT org_id::text, topic, payload, attempts, published_at IS NOT NULL AS published,
            dead_at IS NOT NULL AS dead, last_error,
            round(extract(epoch FROM next_attempt_at - now()))::text AS backoff_s
     FROM bricx.outbox WHERE id = $1`,
    [id],
  );
  return rows[0];
}

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"));
  app = openDatabase(urlFor("bricx_app"));
  relay = openRelayDatabase(urlFor("bricx_relay"));
});
afterAll(async () => {
  await app.close();
  await relay.close();
  await pg18.container.stop();
});

describe("bricx.outbox: the table", () => {
  test("is a system tenant table (with bricx.idempotency_keys from P4-07), with ENABLE + FORCE and exactly three policies", async () => {
    expect(SYSTEM_TENANT_TABLES).toEqual({
      "bricx.outbox": "outbox",
      "bricx.idempotency_keys": "idempotency",
    });
    expect(
      await asAdmin(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class WHERE oid = 'bricx.outbox'::regclass`,
      ),
    ).toEqual([{ enabled: true, forced: true }]);
    expect(
      await asAdmin(
        `SELECT policyname, cmd, roles::text[] AS roles, permissive, qual, with_check
         FROM pg_policies WHERE schemaname = 'bricx' AND tablename = 'outbox'
         ORDER BY policyname`,
      ),
    ).toEqual([
      {
        policyname: "outbox_app_insert",
        cmd: "INSERT",
        roles: ["bricx_app"],
        permissive: "PERMISSIVE",
        qual: null,
        with_check: "(org_id = app.current_org())",
      },
      {
        policyname: "outbox_relay_select",
        cmd: "SELECT",
        roles: ["bricx_relay"],
        permissive: "PERMISSIVE",
        qual: "true",
        with_check: null,
      },
      {
        policyname: "outbox_relay_update",
        cmd: "UPDATE",
        roles: ["bricx_relay"],
        permissive: "PERMISSIVE",
        qual: "true",
        with_check: "true",
      },
    ]);
  });

  test("the role bricx_relay is not BYPASSRLS: the policies are what let it read", async () => {
    expect(
      await asAdmin(
        "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'bricx_relay'",
      ),
    ).toEqual([{ rolbypassrls: false, rolsuper: false }]);
  });

  test("table privileges per role: app INSERT, relay SELECT + UPDATE, nobody else anything", async () => {
    const rows = await asAdmin<{ role: string; privileges: string }>(
      `SELECT r.rolname AS role,
              concat_ws(',',
                CASE WHEN has_table_privilege(r.oid, 'bricx.outbox', 'SELECT') THEN 'SELECT' END,
                CASE WHEN has_table_privilege(r.oid, 'bricx.outbox', 'INSERT') THEN 'INSERT' END,
                CASE WHEN has_any_column_privilege(r.oid, 'bricx.outbox', 'INSERT') THEN 'INSERT(col)' END,
                CASE WHEN has_table_privilege(r.oid, 'bricx.outbox', 'UPDATE') THEN 'UPDATE' END,
                CASE WHEN has_any_column_privilege(r.oid, 'bricx.outbox', 'UPDATE') THEN 'UPDATE(col)' END,
                CASE WHEN has_table_privilege(r.oid, 'bricx.outbox', 'DELETE') THEN 'DELETE' END,
                CASE WHEN has_table_privilege(r.oid, 'bricx.outbox', 'TRUNCATE') THEN 'TRUNCATE' END,
                CASE WHEN has_table_privilege(r.oid, 'bricx.outbox', 'REFERENCES') THEN 'REFERENCES' END,
                CASE WHEN has_table_privilege(r.oid, 'bricx.outbox', 'TRIGGER') THEN 'TRIGGER' END) AS privileges
       FROM pg_roles r
       WHERE r.rolname IN ('bricx_app', 'bricx_readonly', 'bricx_relay', 'powersync_repl')
       ORDER BY 1`,
    );
    expect(rows).toEqual([
      { role: "bricx_app", privileges: "INSERT(col)" },
      { role: "bricx_readonly", privileges: "" },
      { role: "bricx_relay", privileges: "SELECT,UPDATE(col)" },
      { role: "powersync_repl", privileges: "" },
    ]);
  });

  test("column privileges: app inserts id, org_id, topic, payload and not_before (P5-06); relay updates the delivery columns only", async () => {
    const rows = await asAdmin<{
      grantee: string;
      privilege: string;
      columns: string[];
    }>(
      `SELECT grantee, privilege_type AS privilege,
              array_agg(column_name::text ORDER BY column_name) AS columns
       FROM information_schema.column_privileges
       WHERE table_schema = 'bricx' AND table_name = 'outbox'
         AND grantee IN ('bricx_app', 'bricx_readonly', 'bricx_relay', 'powersync_repl')
       GROUP BY grantee, privilege_type ORDER BY 1, 2`,
    );
    const all = [
      "attempts",
      "created_at",
      "dead_at",
      "id",
      "last_error",
      "next_attempt_at",
      "not_before",
      "org_id",
      "payload",
      "published_at",
      "topic",
    ];
    expect(OUTBOX_RELAY_COLUMNS).toEqual([
      "published_at",
      "attempts",
      "next_attempt_at",
      "last_error",
      "dead_at",
    ]);
    expect(rows).toEqual([
      {
        grantee: "bricx_app",
        privilege: "INSERT",
        columns: ["id", "not_before", "org_id", "payload", "topic"],
      },
      { grantee: "bricx_relay", privilege: "SELECT", columns: all },
      {
        grantee: "bricx_relay",
        privilege: "UPDATE",
        columns: [...OUTBOX_RELAY_COLUMNS].sort(),
      },
    ]);
  });

  test("the CHECKs: topic, attempts >= 0, never both published and dead, last_error a code", async () => {
    for (const [values, wanted] of [
      [{ topic: "System.ping" }, CHECK_VIOLATION],
      [{ topic: "1system" }, CHECK_VIOLATION],
      [{ topic: "system ping" }, CHECK_VIOLATION],
      [{ topic: `s${"x".repeat(63)}` }, CHECK_VIOLATION],
      [{ topic: `s${"x".repeat(62)}` }, "ok"],
      [{ attempts: -1 }, CHECK_VIOLATION],
      [
        { published_at: "2026-01-01Z", dead_at: "2026-01-01Z" },
        CHECK_VIOLATION,
      ],
      [{ published_at: "2026-01-01Z" }, "ok"],
      [{ dead_at: "2026-01-01Z" }, "ok"],
      [{ last_error: "unknown_topic" }, "ok"],
      [{ last_error: "connect ECONNREFUSED 10.0.0.1:6379" }, CHECK_VIOLATION],
      [{ last_error: "Unknown_topic" }, CHECK_VIOLATION],
    ] as const) {
      let got = "ok";
      try {
        await seed(ORG_A, values);
      } catch (error) {
        got = String((error as { code?: string }).code);
      }
      expect(got, JSON.stringify(values)).toBe(wanted);
    }
  });

  test("a pending row: attempts 0, next_attempt_at now, not published, not dead", async () => {
    const id = await seed(ORG_A);
    expect(await rowOf(id)).toEqual({
      org_id: ORG_A,
      topic: "system.ping",
      payload: {},
      attempts: 0,
      published: false,
      dead: false,
      last_error: null,
      backoff_s: "0",
    });
  });
});

describe("bricx_app: INSERT for its own org only (condition 7)", () => {
  test("insertOutbox() in withTx(): the org comes from the transaction; works with INSERT only", async () => {
    const id = id7();
    await app.withTx(ctx(ORG_A), (tx) =>
      insertOutbox(tx, "system.ping", {}, id),
    );
    expect(await rowOf(id)).toMatchObject({
      org_id: ORG_A,
      topic: "system.ping",
      payload: {},
      attempts: 0,
      published: false,
    });
  });

  test("insertOutbox() rolls back with its transaction", async () => {
    const id = id7();
    await expect(
      app.withTx(ctx(ORG_A), async (tx) => {
        await insertOutbox(tx, "system.ping", {}, id);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await rowOf(id)).toBeUndefined();
  });

  test("RETURNING and ON CONFLICT would fail as bricx_app (so insertOutbox() uses neither)", async () => {
    const insert = `INSERT INTO bricx.outbox (id, org_id, topic, payload) VALUES ($1, $2, 'system.ping', '{}')`;
    expect(await outcome("bricx_app", insert, [id7(), ORG_A], ORG_A)).toBe(
      "ok:1",
    );
    expect(
      await outcome(
        "bricx_app",
        `${insert} RETURNING id`,
        [id7(), ORG_A],
        ORG_A,
      ),
    ).toBe(DENIED);
    expect(
      await outcome(
        "bricx_app",
        `${insert} ON CONFLICT (id) DO NOTHING`,
        [id7(), ORG_A],
        ORG_A,
      ),
    ).toBe(DENIED);
  });

  test("another org's row, no context, a delivery column, SELECT, UPDATE and DELETE: 42501", async () => {
    const insert = `INSERT INTO bricx.outbox (id, org_id, topic, payload) VALUES ($1, $2, 'system.ping', '{}')`;
    expect(await outcome("bricx_app", insert, [id7(), ORG_B], ORG_A)).toBe(
      DENIED,
    );
    expect(await outcome("bricx_app", insert, [id7(), ORG_A])).toBe(DENIED);
    for (const column of [
      "attempts",
      "published_at",
      "dead_at",
      "next_attempt_at",
      "last_error",
      "created_at",
    ]) {
      expect(
        await outcome(
          "bricx_app",
          `INSERT INTO bricx.outbox (id, org_id, topic, payload, ${column}) VALUES ($1, $2, 'system.ping', '{}', DEFAULT)`,
          [id7(), ORG_A],
          ORG_A,
        ),
        column,
      ).toBe(DENIED);
    }
    for (const statement of [
      "SELECT 1 FROM bricx.outbox",
      "UPDATE bricx.outbox SET attempts = 0",
      "DELETE FROM bricx.outbox",
      "TRUNCATE bricx.outbox",
    ]) {
      expect(await outcome("bricx_app", statement, [], ORG_A), statement).toBe(
        DENIED,
      );
    }
  });

  test("bricx_readonly and powersync_repl: nothing", async () => {
    for (const who of ["bricx_readonly", "powersync_repl"] as const) {
      expect(await outcome(who, "SELECT 1 FROM bricx.outbox", [], ORG_A)).toBe(
        DENIED,
      );
      expect(
        await outcome(
          who,
          "INSERT INTO bricx.outbox (id, org_id, topic, payload) VALUES ($1, $2, 'system.ping', '{}')",
          [id7(), ORG_A],
          ORG_A,
        ),
      ).toBe(DENIED);
    }
  });

  test("insertOutbox() refuses before any SQL: unknown topic, bad payload, bad id", async () => {
    const before = await asAdmin<{ n: string }>(
      "SELECT count(*)::text AS n FROM bricx.outbox",
    );
    for (const [topic, payload, id, code] of [
      ["system.pong", {}, id7(), "unknown_topic"],
      ["system.ping", { a: 1 }, id7(), "invalid_payload"],
      ["system.ping", [], id7(), "invalid_payload"],
      ["system.ping", {}, "not-a-uuid", "invalid_id"],
    ] as const) {
      const error = await app
        .withTx(ctx(ORG_A), async (tx) => {
          await insertOutbox(tx, topic, payload, id);
          // The transaction is still usable: nothing was sent.
          await tx.execute(sql`SELECT 1`);
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(OutboxError);
      expect((error as OutboxError).code).toBe(code);
    }
    expect(
      await asAdmin<{ n: string }>(
        "SELECT count(*)::text AS n FROM bricx.outbox",
      ),
    ).toEqual(before);
  });

  test("insertOutbox() outside a tenant context: no_tenant_context", async () => {
    // A raw bricx_app transaction with no app.org_id (withTx() always sets one).
    const client = await pg18.connectAs("bricx_app");
    try {
      const raw = drizzle({ client });
      const error = await raw
        .transaction((tx) => insertOutbox(tx, "system.ping", {}, id7()))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(OutboxError);
      expect((error as OutboxError).code).toBe("no_tenant_context");
    } finally {
      await client.end();
    }
  });
});

describe("bricx_relay (D12)", () => {
  test("reads every org's rows through withRelayTx()", async () => {
    const a = await seed(ORG_A);
    const b = await seed(ORG_B);
    const seen = await relay.withRelayTx(async (tx) => {
      const r = await tx.execute<{ id: string; org: string }>(
        sql`SELECT id::text, org_id::text AS org FROM bricx.outbox WHERE id IN (${a}::uuid, ${b}::uuid) ORDER BY 2`,
      );
      return r.rows;
    });
    expect(seen).toEqual([
      { id: a, org: ORG_A },
      { id: b, org: ORG_B },
    ]);
  });

  test("UPDATEs the delivery columns; never id, org_id, topic, payload or created_at", async () => {
    const id = await seed(ORG_A);
    for (const column of OUTBOX_RELAY_COLUMNS) {
      expect(
        await outcome(
          "bricx_relay",
          `UPDATE bricx.outbox SET ${column} = ${column} WHERE id = $1`,
          [id],
        ),
        column,
      ).toBe("ok:1");
    }
    for (const assignment of [
      "id = id",
      `org_id = '${ORG_B}'`,
      "topic = 'system.other'",
      `payload = '{"x":1}'`,
      "created_at = now()",
    ]) {
      expect(
        await outcome(
          "bricx_relay",
          `UPDATE bricx.outbox SET ${assignment} WHERE id = $1`,
          [id],
        ),
        assignment,
      ).toBe(DENIED);
    }
  });

  test("cannot INSERT, DELETE or TRUNCATE outbox rows", async () => {
    for (const statement of [
      `INSERT INTO bricx.outbox (id, org_id, topic, payload) VALUES ('${id7()}', '${ORG_A}', 'system.ping', '{}')`,
      "DELETE FROM bricx.outbox",
      "TRUNCATE bricx.outbox",
    ]) {
      expect(await outcome("bricx_relay", statement), statement).toBe(DENIED);
    }
  });

  test("no privilege on any other table in bricx, app or bricx_migrations (catalogue walk)", async () => {
    const tables = await asAdmin<{ t: string }>(
      `SELECT n.nspname || '.' || c.relname AS t FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname IN ('bricx', 'app', 'bricx_migrations')
         AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       ORDER BY 1`,
    );
    const names = tables.map((r) => r.t);
    // The production journal's tables, so the walk is not vacuous.
    expect(names).toEqual(
      expect.arrayContaining([
        "bricx.audit_events",
        "bricx.outbox",
        "bricx_migrations.applied",
      ]),
    );
    for (const table of names.filter((t) => t !== "bricx.outbox")) {
      const [row] = await asAdmin<{ any: boolean }>(
        `SELECT has_table_privilege('bricx_relay', $1::regclass, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
             OR has_any_column_privilege('bricx_relay', $1::regclass, 'SELECT, INSERT, UPDATE, REFERENCES') AS any`,
        [table],
      );
      expect(row?.any, table).toBe(false);
    }
    // Real attempts, not only the catalogue.
    expect(
      await outcome("bricx_relay", "SELECT 1 FROM bricx.audit_events"),
    ).toBe(DENIED);
    expect(
      await outcome("bricx_relay", "SELECT 1 FROM bricx_migrations.applied"),
    ).toBe(DENIED);
    expect(await outcome("bricx_relay", "SELECT app.current_org()")).toBe(
      DENIED,
    );
  });

  // P5-05 (ADR 0066, amending D12): USAGE on schema app too, for the one
  // function it may execute there, app.mfa_state() (grants.int.test.ts
  // proves no other app function is executable by it).
  test("schemas: USAGE on bricx and app only; no CREATE anywhere; no default privileges", async () => {
    const rows = await asAdmin<{
      schema: string;
      usage: boolean;
      create: boolean;
    }>(
      `SELECT nspname AS schema,
              has_schema_privilege('bricx_relay', oid, 'USAGE') AS usage,
              has_schema_privilege('bricx_relay', oid, 'CREATE') AS create
       FROM pg_namespace
       WHERE nspname IN ('bricx', 'app', 'bricx_migrations', 'extensions', 'public')
       ORDER BY 1`,
    );
    expect(rows).toEqual([
      { schema: "app", usage: true, create: false },
      { schema: "bricx", usage: true, create: false },
      { schema: "bricx_migrations", usage: false, create: false },
      { schema: "extensions", usage: false, create: false },
      { schema: "public", usage: false, create: false },
    ]);
    expect(
      await asAdmin(
        `SELECT 1 FROM pg_default_acl d, aclexplode(d.defaclacl) a
         WHERE a.grantee = 'bricx_relay'::regrole`,
      ),
    ).toEqual([]);
  });
});

describe("withRelayTx()", () => {
  test("runs as bricx_relay with statement_timeout 30 s and no tenant context; the role sets idle_in_transaction_session_timeout", async () => {
    const seen = await relay.withRelayTx(async (tx) => {
      const r = await tx.execute<Record<string, string | null>>(
        sql`SELECT current_user AS who,
                   current_setting('statement_timeout') AS statement_timeout,
                   current_setting('idle_in_transaction_session_timeout') AS idle,
                   NULLIF(current_setting('app.org_id', true), '') AS org,
                   NULLIF(current_setting('app.user_id', true), '') AS "user",
                   current_setting('transaction_isolation') AS isolation`,
      );
      return r.rows[0];
    });
    expect(seen).toEqual({
      who: "bricx_relay",
      statement_timeout: "30s",
      idle: "30s",
      org: null,
      user: null,
      isolation: "read committed",
    });
  });

  test("refuses any other role before the callback runs: RelayRoleError", async () => {
    const wrong = openRelayDatabase(urlFor("bricx_app"));
    try {
      let ran = false;
      const error = await wrong
        .withRelayTx(() => {
          ran = true;
          return Promise.resolve();
        })
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(RelayRoleError);
      expect(error).toMatchObject({
        message: "relay transaction: not bricx_relay",
      });
      expect(ran).toBe(false);
    } finally {
      await wrong.close();
    }
  });

  test("refuses nesting, inside itself and inside withTx()", async () => {
    await expect(
      relay.withRelayTx(() => relay.withRelayTx(() => Promise.resolve(1))),
    ).rejects.toBeInstanceOf(NestedTransactionError);
    await expect(
      app.withTx(ctx(ORG_A), () => relay.withRelayTx(() => Promise.resolve(1))),
    ).rejects.toBeInstanceOf(NestedTransactionError);
    await expect(
      relay.withRelayTx(() => app.withTx(ctx(ORG_A), () => Promise.resolve(1))),
    ).rejects.toBeInstanceOf(NestedTransactionError);
  });

  test("an unreachable database is DatabaseUnavailableError; ping too", async () => {
    const dead = openRelayDatabase(
      {
        reveal: () =>
          urlFor("bricx_relay")
            .reveal()
            .replace(/:\d+\//, ":1/"),
      },
      { timeoutMs: 500 },
    );
    try {
      await expect(dead.ping()).rejects.toMatchObject({
        name: "DatabaseUnavailableError",
      });
      await expect(
        dead.withRelayTx(() => Promise.resolve(1)),
      ).rejects.toMatchObject({
        name: "DatabaseUnavailableError",
      });
    } finally {
      await dead.close();
    }
    await expect(relay.ping()).resolves.toBeUndefined();
  });
});

describe("the relay's statements (claim, publish, fail)", () => {
  async function clearPending() {
    // The superuser marks every earlier row published, so each test starts clean.
    await asAdmin(
      "UPDATE bricx.outbox SET published_at = now() WHERE published_at IS NULL AND dead_at IS NULL",
    );
  }

  test("claimOutboxBatch(): pending, due rows only, oldest first, at most `limit`", async () => {
    await clearPending();
    const first = await seed(ORG_A, { created_at: "2026-01-01T00:00:00Z" });
    const second = await seed(ORG_B, { created_at: "2026-01-01T00:00:01Z" });
    const third = await seed(ORG_A, { created_at: "2026-01-01T00:00:02Z" });
    await seed(ORG_A, { published_at: "2026-01-01Z" });
    await seed(ORG_A, { dead_at: "2026-01-01Z" });
    await seed(ORG_A, { next_attempt_at: "2999-01-01Z" });
    const claimed = await relay.withRelayTx((tx) => claimOutboxBatch(tx, 2));
    expect(claimed).toEqual([
      {
        id: first,
        orgId: ORG_A,
        topic: "system.ping",
        payload: {},
        attempts: 0,
      },
      {
        id: second,
        orgId: ORG_B,
        topic: "system.ping",
        payload: {},
        attempts: 0,
      },
    ]);
    const all = await relay.withRelayTx((tx) => claimOutboxBatch(tx, 100));
    expect(all.map((r) => r.id)).toEqual([first, second, third]);
  });

  test("claimOutboxBatch() skips rows another transaction holds (SKIP LOCKED)", async () => {
    await clearPending();
    const a = await seed(ORG_A, { created_at: "2026-01-01T00:00:00Z" });
    const b = await seed(ORG_A, { created_at: "2026-01-01T00:00:01Z" });
    const other = openRelayDatabase(urlFor("bricx_relay"));
    try {
      const { promise: held, resolve: release } =
        Promise.withResolvers<undefined>();
      let claimedFirst: string[] = [];
      const holder = relay.withRelayTx(async (tx) => {
        claimedFirst = (await claimOutboxBatch(tx, 1)).map((r) => r.id);
        await held;
      });
      while (claimedFirst.length === 0) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const second = await other.withRelayTx((tx) => claimOutboxBatch(tx, 100));
      release(undefined);
      await holder;
      expect(claimedFirst).toEqual([a]);
      expect(second.map((r) => r.id)).toEqual([b]);
    } finally {
      await other.close();
    }
  });

  test("markOutboxPublished() sets published_at on the given rows only", async () => {
    await clearPending();
    const a = await seed(ORG_A);
    const b = await seed(ORG_B);
    await relay.withRelayTx((tx) => markOutboxPublished(tx, [a]));
    expect((await rowOf(a))?.published).toBe(true);
    expect((await rowOf(b))?.published).toBe(false);
    await relay.withRelayTx((tx) => markOutboxPublished(tx, []));
  });

  test("markOutboxFailed(): attempts + 1, backoff min(2^attempts s, 300 s), the code; dead at N", async () => {
    const id = await seed(ORG_A);
    const backoffs: string[] = [];
    for (let attempt = 1; attempt <= 9; attempt += 1) {
      const result = await relay.withRelayTx((tx) =>
        markOutboxFailed(tx, id, "unknown_topic", 10),
      );
      expect(result).toEqual({ attempts: attempt, dead: false });
      const row = await rowOf(id);
      expect(row).toMatchObject({
        attempts: attempt,
        dead: false,
        published: false,
        last_error: "unknown_topic",
      });
      backoffs.push(row?.backoff_s ?? "");
    }
    expect(backoffs).toEqual([
      "2",
      "4",
      "8",
      "16",
      "32",
      "64",
      "128",
      "256",
      "300",
    ]);
    expect(
      await relay.withRelayTx((tx) =>
        markOutboxFailed(tx, id, "unknown_topic", 10),
      ),
    ).toEqual({ attempts: 10, dead: true });
    expect(await rowOf(id)).toMatchObject({ attempts: 10, dead: true });
    // A dead row is never claimed again.
    const claimed = await relay.withRelayTx((tx) => claimOutboxBatch(tx, 100));
    expect(claimed.map((r) => r.id)).not.toContain(id);
  });

  test("markOutboxFailed() refuses a code that is not a plain code, before any SQL", async () => {
    const id = await seed(ORG_A);
    for (const code of ["Connection refused", "", "x".repeat(65), "a-b"]) {
      const error = await relay
        .withRelayTx((tx) => markOutboxFailed(tx, id, code, 10))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error, code).toBeInstanceOf(OutboxError);
    }
    expect((await rowOf(id))?.attempts).toBe(0);
  });
});

describe("FORCE binds bricx_owner (condition 2)", () => {
  test("the owner sees no rows, and a plain owner DELETE deletes 0 rows", async () => {
    await seed(ORG_A);
    expect(await outcome("bricx_owner", "SELECT 1 FROM bricx.outbox")).toBe(
      "ok:0",
    );
    expect(
      await outcome("bricx_owner", "SELECT 1 FROM bricx.outbox", [], ORG_A),
    ).toBe("ok:0");
    expect(await outcome("bricx_owner", "DELETE FROM bricx.outbox")).toBe(
      "ok:0",
    );
  });
});
