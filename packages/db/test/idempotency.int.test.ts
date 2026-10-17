// P4-07 (ADR 0057): bricx.idempotency_keys against compose.yml's Postgres
// with the real init folder and the production journal (applied as
// bricx_owner).
// - The table: ENABLE + FORCE, three policies TO bricx_app only, each
//   org_id = app.current_org() AND user_id = app.current_user_id() (owner
//   condition 2); SELECT, INSERT, UPDATE for bricx_app, no DELETE; nothing
//   for bricx_owner, bricx_readonly or bricx_relay; the CHECKs.
// - Cross-user, same org: read, insert and update denied.
// - The statements: a first claim claims; a second claim with the same
//   (route, key) replays the committed response; an expired row is reused
//   in place; a claim in a rolled-back transaction leaves no row; a second
//   claim waits on the unique index while the first is open, then replays.
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
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Database, openDatabase } from "../src/database.js";
import {
  IdempotencyError,
  claimIdempotencyKey,
  storeIdempotencyResponse,
} from "../src/idempotency.js";
import { migrate } from "../src/migrate.js";

const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const ORG_B = "0199e1a0-0000-7000-8000-00000000000b";
const USER_1 = "0199e1a0-0000-7000-8000-000000000001";
const USER_2 = "0199e1a0-0000-7000-8000-000000000002";
const DENIED = "42501";
const CHECK_VIOLATION = "23514";
const ctx = (orgId: string, userId = USER_1) => ({
  orgId,
  userId,
  projectIds: [],
});
const hashA = Buffer.alloc(32, 0xa1);
const hashB = Buffer.alloc(32, 0xb2);
const TABLE = "bricx.idempotency_keys";

let pg18: BootstrappedPostgres;
let app: Database;
let n = 0;
const nextKey = (): string => {
  n += 1;
  return `key-${String(n)}-${randomUUID()}`;
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

/**
 * "ok:<rowCount>" or the SQLSTATE, as `who` (or the test superuser, which
 * RLS does not bind), in a rolled-back transaction.
 */
async function outcome(
  who: Role | "superuser",
  text: string,
  params: unknown[] = [],
  context?: { orgId: string; userId: string },
): Promise<string> {
  const client =
    who === "superuser" ? await pg18.admin() : await pg18.connectAs(who);
  try {
    await client.query("BEGIN");
    try {
      if (context !== undefined) {
        await client.query(
          "SELECT set_config('app.org_id', $1, true), set_config('app.user_id', $2, true)",
          [context.orgId, context.userId],
        );
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

/** Seeds one complete row as the test superuser (RLS does not apply). */
async function seed(values: Record<string, unknown> = {}): Promise<string> {
  const row: Record<string, unknown> = {
    org_id: ORG_A,
    user_id: USER_1,
    route: "POST /v1/seeded",
    key: nextKey(),
    request_hash: hashA,
    status: 201,
    response: '{"seeded":true}',
    headers: '{"content-type":"application/json; charset=utf-8"}',
    ...values,
  };
  const names = Object.keys(row);
  const rows = await asAdmin<{ id: string }>(
    `INSERT INTO ${TABLE} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(", ")}) RETURNING id::text`,
    Object.values(row),
  );
  return rows[0]?.id ?? "";
}

interface Row {
  id: string;
  org_id: string;
  user_id: string;
  route: string;
  key: string;
  request_hash: Buffer;
  status: number;
  response: string | null;
  headers: Record<string, string> | null;
  ttl_s: string;
}

async function rowsFor(route: string, key: string): Promise<Row[]> {
  return asAdmin<Row>(
    `SELECT id::text, org_id::text, user_id::text, route, key, request_hash, status, response, headers,
            round(extract(epoch FROM expires_at - created_at))::text AS ttl_s
     FROM ${TABLE} WHERE route = $1 AND key = $2 ORDER BY org_id, user_id`,
    [route, key],
  );
}

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"));
  app = openDatabase(urlFor("bricx_app"));
});
afterAll(async () => {
  await app.close();
  await pg18.container.stop();
});

describe("bricx.idempotency_keys: the table (owner condition 2)", () => {
  test("ENABLE + FORCE and exactly three policies, TO bricx_app, org AND user", async () => {
    expect(
      await asAdmin(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class WHERE oid = '${TABLE}'::regclass`,
      ),
    ).toEqual([{ enabled: true, forced: true }]);
    const scope =
      "((org_id = app.current_org()) AND (user_id = app.current_user_id()))";
    expect(
      await asAdmin(
        `SELECT policyname, cmd, roles::text[] AS roles, permissive, qual, with_check
         FROM pg_policies WHERE schemaname = 'bricx' AND tablename = 'idempotency_keys'
         ORDER BY policyname`,
      ),
    ).toEqual([
      {
        policyname: "idempotency_keys_app_insert",
        cmd: "INSERT",
        roles: ["bricx_app"],
        permissive: "PERMISSIVE",
        qual: null,
        with_check: scope,
      },
      {
        policyname: "idempotency_keys_app_select",
        cmd: "SELECT",
        roles: ["bricx_app"],
        permissive: "PERMISSIVE",
        qual: scope,
        with_check: null,
      },
      {
        policyname: "idempotency_keys_app_update",
        cmd: "UPDATE",
        roles: ["bricx_app"],
        permissive: "PERMISSIVE",
        qual: scope,
        with_check: scope,
      },
    ]);
  });

  test("table privileges: app SELECT, INSERT, UPDATE; owner through ownership only; nobody else anything", async () => {
    const rows = await asAdmin<{ role: string; privileges: string }>(`
      SELECT r.rolname AS role,
             concat_ws(',',
               CASE WHEN has_table_privilege(r.oid, '${TABLE}'::regclass, 'SELECT') THEN 'SELECT' END,
               CASE WHEN has_table_privilege(r.oid, '${TABLE}'::regclass, 'INSERT') THEN 'INSERT' END,
               CASE WHEN has_table_privilege(r.oid, '${TABLE}'::regclass, 'UPDATE') THEN 'UPDATE' END,
               CASE WHEN has_table_privilege(r.oid, '${TABLE}'::regclass, 'DELETE') THEN 'DELETE' END,
               CASE WHEN has_table_privilege(r.oid, '${TABLE}'::regclass, 'TRUNCATE') THEN 'TRUNCATE' END) AS privileges
      FROM pg_roles r
      WHERE r.rolname IN ('bricx_app', 'bricx_readonly', 'bricx_relay', 'powersync_repl')
      ORDER BY 1`);
    expect(rows).toEqual([
      { role: "bricx_app", privileges: "SELECT,INSERT,UPDATE" },
      { role: "bricx_readonly", privileges: "" },
      { role: "bricx_relay", privileges: "" },
      { role: "powersync_repl", privileges: "" },
    ]);
  });

  test("the CHECKs (as the superuser): key, route, hash length, status range, response size, complete pairs, expiry after creation", async () => {
    const base = {
      org_id: ORG_A,
      user_id: USER_1,
      route: "POST /v1/x",
      key: "k",
      request_hash: hashA,
      status: 201,
    };
    const insert = async (values: Record<string, unknown>) => {
      const row = { ...base, key: nextKey(), ...values };
      const names = Object.keys(row);
      return outcome(
        "superuser",
        `INSERT INTO ${TABLE} (${names.join(", ")}) VALUES (${names.map((_, i) => `$${String(i + 1)}`).join(", ")})`,
        Object.values(row),
      );
    };
    expect(await insert({})).toBe("ok:1");
    expect(await insert({ key: "" })).toBe(CHECK_VIOLATION);
    expect(await insert({ key: "a b" })).toBe(CHECK_VIOLATION);
    expect(await insert({ key: "k".repeat(256) })).toBe(CHECK_VIOLATION);
    expect(await insert({ route: "POST /v1/x?y=1" })).toBe(CHECK_VIOLATION);
    expect(await insert({ route: "post /v1/x" })).toBe(CHECK_VIOLATION);
    expect(await insert({ request_hash: Buffer.alloc(31) })).toBe(
      CHECK_VIOLATION,
    );
    expect(await insert({ status: 99 })).toBe(CHECK_VIOLATION);
    expect(await insert({ status: 600 })).toBe(CHECK_VIOLATION);
    expect(await insert({ response: "x".repeat(262_145), headers: "{}" })).toBe(
      CHECK_VIOLATION,
    );
    expect(await insert({ response: "x".repeat(262_144), headers: "{}" })).toBe(
      "ok:1",
    );
    expect(await insert({ response: "{}" })).toBe(CHECK_VIOLATION);
    expect(await insert({ headers: "{}" })).toBe(CHECK_VIOLATION);
    expect(await insert({ response: "{}", headers: "[]" })).toBe(
      CHECK_VIOLATION,
    );
    expect(await insert({ expires_at: "2020-01-01T00:00:00Z" })).toBe(
      CHECK_VIOLATION,
    );
  });

  test("the scope is unique per (org, user, route, key); the same key is free for another user or org", async () => {
    const key = nextKey();
    expect(await seed({ key })).not.toBe("");
    expect(
      await outcome(
        "superuser",
        `INSERT INTO ${TABLE} (org_id, user_id, route, key, request_hash, status) VALUES ($1, $2, $3, $4, $5, 201)`,
        [ORG_A, USER_1, "POST /v1/seeded", key, hashB],
      ),
    ).toBe("23505");
    for (const [org, user] of [
      [ORG_A, USER_2],
      [ORG_B, USER_1],
    ]) {
      expect(
        await outcome(
          "superuser",
          `INSERT INTO ${TABLE} (org_id, user_id, route, key, request_hash, status) VALUES ($1, $2, $3, $4, $5, 201)`,
          [org, user, "POST /v1/seeded", key, hashB],
        ),
      ).toBe("ok:1");
    }
  });
});

describe("cross-user and cross-org access (owner condition 2)", () => {
  test("another user of the same org can neither read, insert as, nor update the row", async () => {
    const key = nextKey();
    const id = await seed({ key });
    const asUser2 = { orgId: ORG_A, userId: USER_2 };
    expect(
      await outcome(
        "bricx_app",
        `SELECT count(*)::int AS n FROM ${TABLE} WHERE id = $1`,
        [id],
        asUser2,
      ),
    ).toBe("ok:1");
    const seen = await app.withTx(ctx(ORG_A, USER_2), async (tx) => {
      const r = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM bricx.idempotency_keys WHERE id = ${id}`,
      );
      return r.rows[0]?.n;
    });
    expect(seen).toBe(0);
    expect(
      await outcome(
        "bricx_app",
        `INSERT INTO ${TABLE} (org_id, user_id, route, key, request_hash, status) VALUES ($1, $2, 'POST /v1/seeded', $3, $4, 201)`,
        [ORG_A, USER_1, nextKey(), hashA],
        asUser2,
      ),
    ).toBe(DENIED);
    expect(
      await outcome(
        "bricx_app",
        `UPDATE ${TABLE} SET response = '{"stolen":true}', headers = '{}' WHERE id = $1`,
        [id],
        asUser2,
      ),
    ).toBe("ok:0");
    expect(
      await outcome(
        "bricx_app",
        `UPDATE ${TABLE} SET user_id = $2 WHERE id = $1`,
        [id, USER_2],
        { orgId: ORG_A, userId: USER_1 },
      ),
    ).toBe(DENIED);
  });

  test("another org, no context, DELETE, the owner, readonly and relay: nothing", async () => {
    const key = nextKey();
    const id = await seed({ key });
    expect(
      await outcome(
        "bricx_app",
        `SELECT count(*)::int FROM ${TABLE} WHERE id = $1`,
        [id],
        { orgId: ORG_B, userId: USER_1 },
      ),
    ).toBe("ok:1");
    const asB = await app.withTx(ctx(ORG_B), async (tx) => {
      const r = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM bricx.idempotency_keys WHERE id = ${id}`,
      );
      return r.rows[0]?.n;
    });
    expect(asB).toBe(0);
    const noContext = await outcome(
      "bricx_app",
      `INSERT INTO ${TABLE} (org_id, user_id, route, key, request_hash, status) VALUES ($1, $2, 'POST /v1/seeded', $3, $4, 201)`,
      [ORG_A, USER_1, nextKey(), hashA],
    );
    expect(noContext).toBe(DENIED);
    expect(
      await outcome("bricx_app", `DELETE FROM ${TABLE} WHERE id = $1`, [id], {
        orgId: ORG_A,
        userId: USER_1,
      }),
    ).toBe(DENIED);
    // FORCE binds the owner: no policy, so it sees and changes nothing.
    expect(
      await outcome("bricx_owner", `SELECT * FROM ${TABLE} WHERE id = $1`, [
        id,
      ]),
    ).toBe("ok:0");
    expect(
      await outcome("bricx_owner", `DELETE FROM ${TABLE} WHERE id = $1`, [id]),
    ).toBe("ok:0");
    for (const who of ["bricx_readonly", "bricx_relay"] as const) {
      expect(
        await outcome(who, `SELECT * FROM ${TABLE} WHERE id = $1`, [id], {
          orgId: ORG_A,
          userId: USER_1,
        }),
      ).toBe(DENIED);
    }
  });
});

describe("the statements (claim, store, replay)", () => {
  const claim = (route: string, key: string, requestHash = hashA) => ({
    route,
    key,
    requestHash,
    status: 201,
  });

  test("a first claim claims; the store completes the row in the same transaction; a second claim replays it", async () => {
    const key = nextKey();
    const route = "POST /v1/things";
    const first = await app.withTx(ctx(ORG_A), async (tx) => {
      const result = await claimIdempotencyKey(tx, claim(route, key));
      expect(result.claimed).toBe(true);
      if (!result.claimed) throw new Error("unreachable");
      await storeIdempotencyResponse(tx, result.id, '{"z":1,"a":2}', {
        "content-type": "application/json; charset=utf-8",
        location: "/v1/things/1",
      });
      return result.id;
    });
    const rows = await rowsFor(route, key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: first,
      org_id: ORG_A,
      user_id: USER_1,
      status: 201,
      response: '{"z":1,"a":2}',
      headers: {
        "content-type": "application/json; charset=utf-8",
        location: "/v1/things/1",
      },
      ttl_s: "86400",
    });
    expect(rows[0]?.request_hash.equals(hashA)).toBe(true);
    const second = await app.withTx(ctx(ORG_A), (tx) =>
      claimIdempotencyKey(tx, claim(route, key)),
    );
    expect(second).toEqual({
      claimed: false,
      stored: {
        requestHash: hashA,
        status: 201,
        body: '{"z":1,"a":2}',
        headers: {
          "content-type": "application/json; charset=utf-8",
          location: "/v1/things/1",
        },
      },
    });
    // The replay changed nothing.
    expect(await rowsFor(route, key)).toEqual(rows);
  });

  test("the replay carries the stored hash, so the caller can detect a reused key (the statement does not judge)", async () => {
    const key = nextKey();
    const route = "POST /v1/things";
    await app.withTx(ctx(ORG_A), async (tx) => {
      const result = await claimIdempotencyKey(tx, claim(route, key, hashA));
      if (!result.claimed) throw new Error("unreachable");
      await storeIdempotencyResponse(tx, result.id, "{}", {});
    });
    const replay = await app.withTx(ctx(ORG_A), (tx) =>
      claimIdempotencyKey(tx, claim(route, key, hashB)),
    );
    expect(replay.claimed).toBe(false);
    if (replay.claimed) throw new Error("unreachable");
    expect(replay.stored.requestHash.equals(hashA)).toBe(true);
    expect(replay.stored.requestHash.equals(hashB)).toBe(false);
  });

  test("a claim whose transaction rolls back leaves no row; the next claim claims", async () => {
    const key = nextKey();
    const route = "POST /v1/things";
    await expect(
      app.withTx(ctx(ORG_A), async (tx) => {
        const result = await claimIdempotencyKey(tx, claim(route, key));
        expect(result.claimed).toBe(true);
        throw new Error("the handler failed");
      }),
    ).rejects.toThrow("the handler failed");
    expect(await rowsFor(route, key)).toEqual([]);
    const again = await app.withTx(ctx(ORG_A), (tx) =>
      claimIdempotencyKey(tx, claim(route, key)),
    );
    expect(again.claimed).toBe(true);
  });

  test("the same key for another user, another org or another route claims", async () => {
    const key = nextKey();
    await app.withTx(ctx(ORG_A), async (tx) => {
      const r = await claimIdempotencyKey(tx, claim("POST /v1/a", key));
      if (!r.claimed) throw new Error("unreachable");
      await storeIdempotencyResponse(tx, r.id, "{}", {});
    });
    for (const [context, route] of [
      [ctx(ORG_A, USER_2), "POST /v1/a"],
      [ctx(ORG_B), "POST /v1/a"],
      [ctx(ORG_A), "POST /v1/b"],
      [ctx(ORG_A), "PATCH /v1/a"],
    ] as const) {
      const r = await app.withTx(context, (tx) =>
        claimIdempotencyKey(tx, claim(route, key)),
      );
      expect(r.claimed).toBe(true);
    }
  });

  test("an expired row is reused in place: a new id, hash and status, the old response gone", async () => {
    const key = nextKey();
    const route = "POST /v1/things";
    const oldId = await app.withTx(ctx(ORG_A), async (tx) => {
      const r = await claimIdempotencyKey(tx, claim(route, key, hashA));
      if (!r.claimed) throw new Error("unreachable");
      await storeIdempotencyResponse(tx, r.id, '{"old":true}', {});
      return r.id;
    });
    await asAdmin(
      `UPDATE ${TABLE} SET created_at = now() - interval '25 hours', expires_at = now() - interval '1 hour' WHERE id = $1`,
      [oldId],
    );
    const newId = await app.withTx(ctx(ORG_A), async (tx) => {
      const r = await claimIdempotencyKey(tx, {
        ...claim(route, key, hashB),
        status: 200,
      });
      expect(r.claimed).toBe(true);
      if (!r.claimed) throw new Error("unreachable");
      expect(r.id).not.toBe(oldId);
      await storeIdempotencyResponse(tx, r.id, '{"new":true}', {});
      return r.id;
    });
    const rows = await rowsFor(route, key);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: newId,
      status: 200,
      response: '{"new":true}',
      ttl_s: "86400",
    });
    expect(rows[0]?.request_hash.equals(hashB)).toBe(true);
  });

  test("a second claim waits on the unique index while the first transaction is open, then replays what it committed", async () => {
    const key = nextKey();
    const route = "POST /v1/things";
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pid = 0;
    const first = app.withTx(ctx(ORG_A), async (tx) => {
      const who = await tx.execute<{ pid: number }>(
        sql`SELECT pg_backend_pid() AS pid`,
      );
      pid = who.rows[0]?.pid ?? 0;
      const r = await claimIdempotencyKey(tx, claim(route, key));
      if (!r.claimed) throw new Error("unreachable");
      await gate;
      await storeIdempotencyResponse(tx, r.id, '{"first":true}', {});
      return "first";
    });
    await expect
      .poll(() => pid, { timeout: 5_000, interval: 20 })
      .toBeGreaterThan(0);
    const started = Date.now();
    const second = app.withTx(ctx(ORG_A), (tx) =>
      claimIdempotencyKey(tx, claim(route, key)),
    );
    // The second backend is blocked on the first's row lock (the unique
    // index), as pg_stat_activity shows, before anything is released.
    await expect
      .poll(
        async () => {
          const rows = await asAdmin<{ n: number }>(
            `SELECT count(*)::int AS n FROM pg_stat_activity
             WHERE usename = 'bricx_app' AND wait_event_type = 'Lock'
               AND state = 'active' AND query ILIKE '%idempotency_keys%' AND pid <> $1`,
            [pid],
          );
          return rows[0]?.n ?? 0;
        },
        { timeout: 5_000, interval: 50 },
      )
      .toBe(1);
    release();
    expect(await first).toBe("first");
    const replay = await second;
    expect(Date.now() - started).toBeGreaterThanOrEqual(0);
    expect(replay).toMatchObject({
      claimed: false,
      stored: { status: 201, body: '{"first":true}', headers: {} },
    });
    expect(await rowsFor(route, key)).toHaveLength(1);
  });

  test("storeIdempotencyResponse() refuses a body over 256 KiB before any SQL, so the transaction rolls back", async () => {
    const key = nextKey();
    const route = "POST /v1/things";
    const error: unknown = await app
      .withTx(ctx(ORG_A), async (tx) => {
        const r = await claimIdempotencyKey(tx, claim(route, key));
        if (!r.claimed) throw new Error("unreachable");
        await storeIdempotencyResponse(tx, r.id, "x".repeat(262_145), {});
      })
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(IdempotencyError);
    expect((error as IdempotencyError).code).toBe("response_too_large");
    expect(await rowsFor(route, key)).toEqual([]);
  });

  test("outside a tenant context the claim is no_tenant_context, before any write", async () => {
    // withTx() always sets a context; the statement is proved directly.
    const client = await pg18.connectAs("bricx_app");
    try {
      const { drizzle } = await import("drizzle-orm/node-postgres");
      const orm = drizzle({ client });
      const error: unknown = await orm
        .transaction((tx) =>
          claimIdempotencyKey(tx, claim("POST /v1/things", nextKey())),
        )
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(error).toBeInstanceOf(IdempotencyError);
      expect((error as IdempotencyError).code).toBe("no_tenant_context");
    } finally {
      await client.end();
    }
  });
});
