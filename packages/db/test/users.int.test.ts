// P5-02 (phase ruling D8, owner conditions 2 and 3, ADR 0062): bricx.users
// and app.provision_user() against compose.yml's Postgres with the
// production journal, applied by the real migrator as bricx_owner.
// - The table: id (UUIDv7), keycloak_sub UNIQUE, created_at, last_seen_at;
//   ENABLE + FORCE RLS; bricx_app and bricx_readonly read only their own
//   row (app.current_user_id()) and write nothing; not in publication
//   powersync; GLOBAL_TABLES stays empty.
// - The function: SECURITY DEFINER owned by bricx_owner, search_path
//   pinned to pg_catalog, pg_temp, EXECUTE for bricx_app only (never
//   PUBLIC). It runs inside withTx() with the context org = the token's
//   org hint and user = a fresh UUIDv7 candidate; it inserts the candidate
//   for a new sub, and for a known sub returns the existing id, touching
//   only last_seen_at, at most once per throttle interval.
// - Ten concurrent first logins of one sub make one row and one id.
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
import { serializeError } from "../src/log.js";
import { migrate } from "../src/migrate.js";
import { GLOBAL_TABLES } from "../src/rls-guard.js";
import { USER_TABLES } from "../src/rls.js";
import {
  MAX_SUB_LENGTH,
  UserProvisionError,
  provisionUser,
} from "../src/users.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const SENTINEL = "sentinel-3e8b77d0-personal-value";
const T0 = "2026-10-21T08:00:00.000Z";
const at = (seconds: number) =>
  new Date(Date.parse(T0) + seconds * 1000).toISOString();

let pg18: BootstrappedPostgres;
let app: Database;
let n = 0;
/** A UUIDv7-shaped id (version 7, variant 10), unique per call. */
const ids = {
  next(): string {
    n += 1;
    return `0199e1a0-${n.toString(16).padStart(4, "0")}-7000-8000-${randomUUID().slice(-12)}`;
  },
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

/** "ok:<rowCount>" or the SQLSTATE, as `who`, rolled back. */
async function outcome(
  who: Role,
  text: string,
  params: unknown[] = [],
  userId?: string,
): Promise<string> {
  const client = await pg18.connectAs(who);
  try {
    await client.query("BEGIN");
    try {
      if (userId !== undefined) {
        await client.query("SELECT set_config('app.user_id', $1, true)", [
          userId,
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

/** Provisions `sub` the way the API's guard does: in withTx(), org = hint. */
function provision(sub: string, now: string, throttleSeconds = 300) {
  const candidate = ids.next();
  return app.withTx({ orgId: ORG, userId: candidate, projectIds: [] }, (tx) =>
    provisionUser(tx, { sub, now, throttleSeconds }),
  );
}

async function rowOf(sub: string) {
  return asAdmin<{
    id: string;
    created_at: string;
    last_seen_at: string;
  }>(
    `SELECT id::text, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
            to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at
     FROM bricx.users WHERE keycloak_sub = $1`,
    [sub],
  );
}

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"));
  app = openDatabase(urlFor("bricx_app"), { maxConnections: 10 });
});
afterAll(async () => {
  await app.close();
  await pg18.container.stop();
});

describe("bricx.users: the table (D8)", () => {
  test("columns: id uuid, keycloak_sub text, created_at and last_seen_at timestamptz, all NOT NULL", async () => {
    expect(
      await asAdmin(
        `SELECT column_name AS c, data_type AS t, is_nullable AS n
         FROM information_schema.columns
         WHERE table_schema = 'bricx' AND table_name = 'users'
         ORDER BY ordinal_position`,
      ),
    ).toEqual([
      { c: "id", t: "uuid", n: "NO" },
      { c: "keycloak_sub", t: "text", n: "NO" },
      { c: "created_at", t: "timestamp with time zone", n: "NO" },
      { c: "last_seen_at", t: "timestamp with time zone", n: "NO" },
    ]);
  });

  test("registered as a user table (with bricx.devices since P5-03); GLOBAL_TABLES stays empty", () => {
    expect(USER_TABLES).toEqual({
      "bricx.users": "users",
      "bricx.devices": "devices",
    });
    expect(GLOBAL_TABLES).toEqual([]);
  });

  test("ENABLE + FORCE RLS, and exactly the own-row and owner-side policies", async () => {
    expect(
      await asAdmin(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class WHERE oid = 'bricx.users'::regclass`,
      ),
    ).toEqual([{ enabled: true, forced: true }]);
    expect(
      await asAdmin(
        `SELECT policyname AS name, cmd, roles::text[] AS roles, qual, with_check AS check
         FROM pg_policies WHERE schemaname = 'bricx' AND tablename = 'users'
         ORDER BY policyname`,
      ),
    ).toEqual([
      {
        name: "users_owner_insert",
        cmd: "INSERT",
        roles: ["bricx_owner"],
        qual: null,
        check: "true",
      },
      {
        name: "users_owner_select",
        cmd: "SELECT",
        roles: ["bricx_owner"],
        qual: "true",
        check: null,
      },
      {
        name: "users_owner_update",
        cmd: "UPDATE",
        roles: ["bricx_owner"],
        qual: "true",
        check: "true",
      },
      {
        name: "users_self_select",
        cmd: "SELECT",
        roles: ["bricx_app", "bricx_readonly"],
        qual: "(id = app.current_user_id())",
        check: null,
      },
    ]);
  });

  test("grants: bricx_app and bricx_readonly SELECT only; powersync_repl nothing", async () => {
    expect(
      await asAdmin(
        `SELECT r.rolname AS role,
                string_agg(p.privilege, ',' ORDER BY p.privilege) AS privileges
         FROM pg_roles r
         CROSS JOIN unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) AS p(privilege)
         WHERE r.rolname IN ('bricx_app', 'bricx_readonly', 'powersync_repl')
           AND has_table_privilege(r.rolname, 'bricx.users', p.privilege)
         GROUP BY r.rolname ORDER BY r.rolname`,
      ),
    ).toEqual([
      { role: "bricx_app", privileges: "SELECT" },
      { role: "bricx_readonly", privileges: "SELECT" },
    ]);
  });

  test("not in publication powersync (no sync of users)", async () => {
    expect(
      await asAdmin(
        `SELECT count(*)::int AS n FROM pg_publication_tables
         WHERE pubname = 'powersync' AND schemaname = 'bricx' AND tablename = 'users'`,
      ),
    ).toEqual([{ n: 0 }]);
  });

  test("CHECKs: id is a UUIDv7, the sub is 1-255 characters, last_seen_at >= created_at", async () => {
    const insert = (id: string, sub: string, created: string, seen: string) =>
      asAdmin(
        "INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at) VALUES ($1, $2, $3, $4)",
        [id, sub, created, seen],
      ).then(
        () => "ok",
        (error: unknown) =>
          typeof error === "object" && error !== null && "code" in error
            ? String(error.code)
            : "unknown",
      );
    expect(
      await insert("0199e1a0-0000-4000-8000-000000000001", "v4", T0, T0),
    ).toBe("23514");
    expect(await insert(ids.next(), "", T0, T0)).toBe("23514");
    expect(await insert(ids.next(), "x".repeat(256), T0, T0)).toBe("23514");
    expect(await insert(ids.next(), "early", at(10), T0)).toBe("23514");
  });
});

describe("app.provision_user(): the function (D8, conditions 2 and 3)", () => {
  test("SECURITY DEFINER, owned by bricx_owner, search_path pinned to pg_catalog, pg_temp", async () => {
    expect(
      await asAdmin(
        `SELECT p.prosecdef AS definer, pg_get_userbyid(p.proowner) AS owner,
                p.proconfig AS config, p.provolatile AS volatility
         FROM pg_proc p WHERE p.oid = 'app.provision_user(text, timestamptz, integer)'::regprocedure`,
      ),
    ).toEqual([
      {
        definer: true,
        owner: "bricx_owner",
        config: ["search_path=pg_catalog, pg_temp"],
        volatility: "v",
      },
    ]);
  });

  test("EXECUTE: bricx_app only; never PUBLIC, bricx_readonly or powersync_repl", async () => {
    expect(
      await asAdmin(
        `SELECT count(*)::int AS n
         FROM pg_proc p, aclexplode(p.proacl) a
         WHERE p.oid = 'app.provision_user(text, timestamptz, integer)'::regprocedure
           AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'`,
      ),
    ).toEqual([{ n: 0 }]);
    expect(
      await asAdmin(
        `SELECT p.proacl IS NULL AS default_acl FROM pg_proc p
         WHERE p.oid = 'app.provision_user(text, timestamptz, integer)'::regprocedure`,
      ),
    ).toEqual([{ default_acl: false }]);
    expect(
      await asAdmin(
        `SELECT r.rolname AS role,
                has_function_privilege(r.rolname, 'app.provision_user(text, timestamptz, integer)', 'EXECUTE') AS ok
         FROM pg_roles r
         WHERE r.rolname IN ('bricx_app', 'bricx_readonly', 'powersync_repl', 'bricx_relay')
         ORDER BY r.rolname`,
      ),
    ).toEqual([
      { role: "bricx_app", ok: true },
      { role: "bricx_readonly", ok: false },
      { role: "bricx_relay", ok: false },
      { role: "powersync_repl", ok: false },
    ]);
  });

  test("a new sub inserts the context's candidate id, created_at = last_seen_at = now", async () => {
    const candidate = ids.next();
    const id = await app.withTx(
      { orgId: ORG, userId: candidate, projectIds: [] },
      (tx) =>
        provisionUser(tx, { sub: "sub-new", now: T0, throttleSeconds: 300 }),
    );
    expect(id).toBe(candidate);
    expect(await rowOf("sub-new")).toEqual([
      { id: candidate, created_at: T0, last_seen_at: T0 },
    ]);
  });

  test("a known sub returns the existing id, never the new candidate; no second row", async () => {
    const first = await provision("sub-known", T0);
    const second = await provision("sub-known", at(1));
    expect(second).toBe(first);
    expect(await rowOf("sub-known")).toHaveLength(1);
  });

  test("on conflict only last_seen_at changes, at most once per throttle interval (config, here 300 s)", async () => {
    const id = await provision("sub-throttle", T0);
    // Within the interval: no write.
    expect(await provision("sub-throttle", at(299))).toBe(id);
    expect(await rowOf("sub-throttle")).toEqual([
      { id, created_at: T0, last_seen_at: T0 },
    ]);
    // Past it: last_seen_at moves; id and created_at stay.
    expect(await provision("sub-throttle", at(301))).toBe(id);
    expect(await rowOf("sub-throttle")).toEqual([
      { id, created_at: T0, last_seen_at: at(301) },
    ]);
    // A clock behind the stored value never moves it back.
    expect(await provision("sub-throttle", at(5), 0)).toBe(id);
    expect(await rowOf("sub-throttle")).toEqual([
      { id, created_at: T0, last_seen_at: at(301) },
    ]);
  });

  test("the throttle is the caller's: 0 writes on every later login, 3600 holds an hour", async () => {
    const id = await provision("sub-zero", T0, 0);
    await provision("sub-zero", at(1), 0);
    expect((await rowOf("sub-zero"))[0]?.last_seen_at).toBe(at(1));
    await provision("sub-zero", at(1800), 3600);
    expect((await rowOf("sub-zero"))[0]).toEqual({
      id,
      created_at: T0,
      last_seen_at: at(1),
    });
  });

  test("a throttled update does not rewrite the row (xmin unchanged)", async () => {
    await provision("sub-xmin", T0);
    const before = await asAdmin<{ x: string }>(
      "SELECT xmin::text AS x FROM bricx.users WHERE keycloak_sub = 'sub-xmin'",
    );
    await provision("sub-xmin", at(10));
    expect(
      await asAdmin<{ x: string }>(
        "SELECT xmin::text AS x FROM bricx.users WHERE keycloak_sub = 'sub-xmin'",
      ),
    ).toEqual(before);
  });

  test("ten concurrent first logins of one sub: one row, one id for all", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, () => provision("sub-race", T0)),
    );
    expect(new Set(results).size).toBe(1);
    expect(await rowOf("sub-race")).toHaveLength(1);
    expect((await rowOf("sub-race"))[0]?.id).toBe(results[0]);
  });

  test("without a user in the context the function refuses (22023), writing nothing", async () => {
    expect(
      await outcome(
        "bricx_app",
        "SELECT app.provision_user('sub-nocontext', now(), 300)",
      ),
    ).toBe("22023");
    expect(await rowOf("sub-nocontext")).toEqual([]);
  });

  test("the function refuses a bad sub or throttle (22023) even when called directly", async () => {
    const user = ids.next();
    for (const [sub, throttle] of [
      ["", 300],
      ["x".repeat(256), 300],
      ["ok", -1],
      ["ok", 86_401],
    ] as const) {
      expect(
        await outcome(
          "bricx_app",
          "SELECT app.provision_user($1, now(), $2)",
          [sub, throttle],
          user,
        ),
      ).toBe("22023");
    }
  });

  test("provisionUser() refuses a bad sub or throttle before any SQL (UserProvisionError)", async () => {
    for (const input of [
      { sub: "", now: T0, throttleSeconds: 300 },
      { sub: "x".repeat(MAX_SUB_LENGTH + 1), now: T0, throttleSeconds: 300 },
      { sub: "ok\u0000", now: T0, throttleSeconds: 300 },
      { sub: "ok", now: "yesterday", throttleSeconds: 300 },
      { sub: "ok", now: T0, throttleSeconds: 1.5 },
      { sub: "ok", now: T0, throttleSeconds: -1 },
    ]) {
      await expect(
        app.withTx({ orgId: ORG, userId: ids.next(), projectIds: [] }, (tx) =>
          provisionUser(tx, input),
        ),
      ).rejects.toBeInstanceOf(UserProvisionError);
    }
  });

  test("a refused sub carrying a sentinel: neither the error nor its serialized log form holds it", async () => {
    const error: unknown = await app
      .withTx({ orgId: ORG, userId: ids.next(), projectIds: [] }, (tx) =>
        provisionUser(tx, {
          sub: `${SENTINEL}${"x".repeat(MAX_SUB_LENGTH)}`,
          now: T0,
          throttleSeconds: 300,
        }),
      )
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    expect(error).toBeInstanceOf(UserProvisionError);
    expect(String(error)).not.toContain(SENTINEL);
    expect(JSON.stringify(serializeError(error))).not.toContain(SENTINEL);
    // And a database refusal of the same value, through the function.
    const client = await pg18.connectAs("bricx_app");
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_id', $1, true)", [
        ids.next(),
      ]);
      const dbError: unknown = await client
        .query("SELECT app.provision_user($1, now(), 300)", [
          `${SENTINEL}${"x".repeat(MAX_SUB_LENGTH)}`,
        ])
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(dbError).toBeInstanceOf(Error);
      expect(JSON.stringify(serializeError(dbError))).not.toContain(SENTINEL);
      expect(String(dbError)).not.toContain(SENTINEL);
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });
});

describe("bricx.users: own-row RLS (D8)", () => {
  test("bricx_app in withTx() reads only its own row", async () => {
    const mine = await provision("sub-mine", T0);
    await provision("sub-theirs", T0);
    const seen = await app.withTx(
      { orgId: ORG, userId: mine, projectIds: [] },
      async (tx) => {
        const r = await tx.execute<{ id: string }>(
          sql`SELECT id::text AS id FROM bricx.users`,
        );
        return r.rows.map((row) => row.id);
      },
    );
    expect(seen).toEqual([mine]);
  });

  test("no context: bricx_app and bricx_readonly see no row", async () => {
    await provision("sub-visible", T0);
    expect(await outcome("bricx_app", "SELECT * FROM bricx.users")).toBe(
      "ok:0",
    );
    expect(await outcome("bricx_readonly", "SELECT * FROM bricx.users")).toBe(
      "ok:0",
    );
  });

  test("bricx_readonly with a user context reads that row only", async () => {
    const id = await provision("sub-ro", T0);
    expect(
      await outcome("bricx_readonly", "SELECT * FROM bricx.users", [], id),
    ).toBe("ok:1");
  });

  test.each(["bricx_app", "bricx_readonly"] as const)(
    "%s cannot INSERT, UPDATE, DELETE or TRUNCATE (42501), even its own row",
    async (who) => {
      const id = await provision(`sub-write-${who}`, T0);
      for (const statement of [
        `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at) VALUES ('${ids.next()}', 'sub-forged', now(), now())`,
        "UPDATE bricx.users SET last_seen_at = now()",
        "UPDATE bricx.users SET keycloak_sub = 'stolen'",
        "DELETE FROM bricx.users",
        "TRUNCATE bricx.users",
      ]) {
        expect(await outcome(who, statement, [], id)).toBe("42501");
      }
    },
  );

  test("powersync_repl cannot read it", async () => {
    expect(await outcome("powersync_repl", "SELECT * FROM bricx.users")).toBe(
      "42501",
    );
  });
});
