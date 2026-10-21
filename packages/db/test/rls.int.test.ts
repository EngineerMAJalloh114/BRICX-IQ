// P4-04 (ADR 0054): the RLS framework against compose.yml's Postgres with
// the real init folder. The production journal plus the test-only fixture
// migrations (one table per policy shape) are applied by the real migrator
// as bricx_owner. Proves, for every table in schema bricx: ENABLE + FORCE,
// the policies and their roles, no rows without a context, each org only
// its own rows, every cross-org or cross-project write refused, and the
// same for bricx_readonly and bricx_owner. Also the app.* functions and
// the migrator's guard (deny-by-default).
import { randomUUID } from "node:crypto";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { PgDialect } from "drizzle-orm/pg-core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { readMigrations } from "../src/journal.js";
import {
  MIGRATIONS_DIR,
  MigrationError,
  guardProblem,
  migrate,
} from "../src/migrate.js";
import {
  OWN_ROW_TABLES,
  POLICY_ROLES,
  SYSTEM_TENANT_TABLES,
  TENANT_TABLES,
  USER_TABLES,
  enableTenantRls,
  tenantPolicy,
} from "../src/rls.js";
import {
  type TxContext,
  contextStatement,
  validateTxContext,
} from "../src/tx.js";
import {
  FIXTURE_DIR,
  FIXTURE_TABLES,
  composeMigrations,
  tagsOf,
} from "./rls-fixtures.js";

type Who = "bricx_owner" | "bricx_app" | "bricx_readonly";

interface Party {
  readonly org: string;
  readonly user: string;
  readonly project: string;
  readonly site: string;
}

const party = (n: string): Party => ({
  org: `0199e1a0-0000-7000-8000-0000000000${n}1`,
  user: `0199e1a0-0000-7000-8000-0000000000${n}2`,
  project: `0199e1a0-0000-7000-8000-0000000000${n}3`,
  site: `0199e1a0-0000-7000-8000-0000000000${n}4`,
});
const A = party("a");
const B = party("b");
const C = party("c");

const ctxOf = (p: Party, projectIds = [p.project]): TxContext => ({
  orgId: p.org,
  userId: p.user,
  projectIds,
});

/** Every tenant table the database must hold, with its resource. */
const ALL_TABLES: Readonly<Record<string, string>> = {
  ...TENANT_TABLES,
  ...FIXTURE_TABLES,
};

/**
 * Foreign-key parents, seeded before their children (P5-03, ROADMAP P5
 * Also line, P4 exit point 13): users before devices before sessions. A
 * test keeps this list equal to the catalog's foreign keys between bricx
 * tables, and proves that seeding a child first is refused.
 */
const SEED_PARENTS: Readonly<Record<string, readonly string[]>> = {
  "bricx.devices": ["bricx.users"],
  "bricx.sessions": ["bricx.users", "bricx.devices"],
};

/** `tables` with every SEED_PARENTS parent before its children. */
function seedOrder(tables: readonly string[]): string[] {
  const out: string[] = [];
  const visit = (table: string, trail: readonly string[]) => {
    if (out.includes(table)) return;
    if (trail.includes(table)) throw new Error("rls.int: seeding cycle");
    for (const parent of SEED_PARENTS[table] ?? []) {
      visit(parent, [...trail, table]);
    }
    out.push(table);
  };
  for (const table of tables) visit(table, []);
  return out;
}

/** The tables seeded for every party: the user tables, then ALL_TABLES. */
const SEEDED_TABLES = seedOrder([
  ...Object.keys(USER_TABLES),
  ...Object.keys(ALL_TABLES),
]);

const DENIED = "42501";
const dialect = new PgDialect();

let pg18: BootstrappedPostgres;
let applied: readonly string[] = [];

const ownerUrl = () => ({
  reveal: () =>
    `postgres://bricx_owner:${exampleValue("BRICX_OWNER_PASSWORD")}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`,
});

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const qualified = (table: string): string =>
  table.split(".").map(quote).join(".");

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
 * Runs `run` as `who` in a transaction that is always rolled back, with
 * withTx()'s own context statement when `ctx` is given.
 */
async function inTx<T>(
  who: Who,
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

/** "ok:<rowCount>" or the SQLSTATE the statement failed with. */
async function outcome(
  who: Who,
  ctx: TxContext | undefined,
  text: string,
  params: unknown[] = [],
): Promise<string> {
  return inTx(who, ctx, async (client) => {
    try {
      const result = await client.query(text, params);
      return `ok:${String(result.rowCount)}`;
    } catch (error) {
      if (typeof error === "object" && error !== null && "code" in error) {
        return String(error.code);
      }
      throw error;
    }
  });
}

/** The distinct org-column values `who` sees, as text, sorted. */
async function visibleOrgs(
  who: Who,
  ctx: TxContext | undefined,
  table: string,
): Promise<string[]> {
  const column = quote(tenantPolicy(ALL_TABLES[table] ?? "").columns.org);
  return inTx(who, ctx, async (client) => {
    const r = await client.query<{ o: string }>(
      `SELECT DISTINCT ${column}::text AS o FROM ${qualified(table)} ORDER BY 1`,
    );
    return r.rows.map((row) => row.o);
  });
}

interface Column {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
}

const columnsOf = new Map<string, Column[]>();

/**
 * Required columns with a table's own invariant, which the by-type values
 * below would break (P4-05): audit_events' seq starts at 1, hash_version
 * at 1, and actor_type is 'user' or 'system' ('system' needs no actor_id).
 * A hash chain is not modelled here: test/audit.int.test.ts in apps/api
 * proves it. P5-03: a party's users row carries the party's user id (the
 * FK parent of devices and sessions), a device needs a real platform, and
 * a session's keycloak_sid is unique per org.
 */
const SEED_VALUES: Readonly<
  Record<string, (p: Party) => Readonly<Record<string, string>>>
> = {
  "bricx.audit_events": () => ({
    seq: "1",
    hash_version: "1",
    actor_type: "system",
  }),
  "bricx.users": (p) => ({ id: p.user, keycloak_sub: `seed-${p.user}` }),
  "bricx.devices": () => ({ platform: "web" }),
  "bricx.sessions": () => ({ keycloak_sid: randomUUID() }),
};

/**
 * One row for `p` in `table`: the policy's org, project and site columns,
 * created_by and user_id from `p`, then the table's SEED_VALUES, every
 * other required column a fixed value by type (bytea: 32 zero bytes). An
 * unknown type fails loudly, naming the table and column. A user table
 * has no policy columns.
 */
function rowFor(
  table: string,
  p: Party,
  overrides: Readonly<Record<string, string>> = {},
): { text: string; params: unknown[] } {
  const resource = ALL_TABLES[table];
  const policy = resource === undefined ? undefined : tenantPolicy(resource);
  const own: Record<string, string> = {
    ...SEED_VALUES[table]?.(p),
    ...(policy === undefined
      ? {}
      : {
          [policy.columns.org]: p.org,
          ...(policy.columns.project === undefined
            ? {}
            : { [policy.columns.project]: p.project }),
        }),
    site_id: p.site,
    created_by: p.user,
    user_id: p.user,
    ...overrides,
  };
  const names: string[] = [];
  const params: unknown[] = [];
  for (const c of columnsOf.get(table) ?? []) {
    let value: unknown;
    const mine = own[c.column_name];
    if (mine !== undefined) value = mine;
    else if (c.column_default !== null || c.is_nullable === "YES") continue;
    else if (c.data_type === "uuid") value = randomUUID();
    else if (c.data_type === "text") value = "seed";
    else if (["integer", "bigint", "smallint"].includes(c.data_type)) value = 0;
    else if (c.data_type === "boolean") value = false;
    else if (c.data_type === "numeric") value = "0";
    else if (c.data_type === "jsonb") value = "{}";
    else if (c.data_type === "bytea") value = `\\x${"00".repeat(32)}`;
    else if (c.data_type === "inet") value = "192.0.2.1";
    else if (c.data_type === "timestamp with time zone") {
      value = "2026-01-01T00:00:00Z";
    } else {
      throw new Error(
        `rls.int: no test value for ${table}.${c.column_name} (${c.data_type})`,
      );
    }
    names.push(quote(c.column_name));
    params.push(value);
  }
  return {
    text: `INSERT INTO ${qualified(table)} (${names.join(", ")}) VALUES (${params.map((_, i) => `$${String(i + 1)}`).join(", ")})`,
    params,
  };
}

beforeAll(async () => {
  pg18 = await startPostgres();
  const result = await migrate(
    ownerUrl(),
    await composeMigrations([MIGRATIONS_DIR, FIXTURE_DIR]),
  );
  applied = result.applied;
  // Parents before children (SEED_PARENTS): the FK seeding order.
  for (const table of SEEDED_TABLES) {
    const [schema, name] = table.split(".");
    columnsOf.set(
      table,
      await asAdmin<Column>(
        `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`,
        [schema, name],
      ),
    );
    // Seeded by the test superuser (RLS does not apply to it). Every
    // party gets a users row (the FK parent of the rows the tests insert
    // for C); the tenant tables get A's and B's rows.
    for (const p of table in USER_TABLES ? [A, B, C] : [A, B]) {
      const row = rowFor(table, p);
      await asAdmin(row.text, row.params);
    }
  }
});
afterAll(async () => {
  await pg18.container.stop();
});

describe("the migrations", () => {
  test("the production journal, then the fixtures, apply as bricx_owner", async () => {
    const production = (await readMigrations(MIGRATIONS_DIR)).map((m) => m.tag);
    expect(production[0]).toBe("0000_rls_functions");
    expect(applied).toEqual([...production, ...(await tagsOf(FIXTURE_DIR))]);
  });
});

describe("app.current_org(), app.current_user_id(), app.has_project(uuid)", () => {
  const read = (client: pg.Client) =>
    client
      .query<{ org: string | null; user: string | null; has: boolean }>(
        "SELECT app.current_org() AS org, app.current_user_id() AS user, app.has_project($1::uuid) AS has",
        [A.project],
      )
      .then((r) => r.rows[0]);

  test("no context: NULL, NULL, false", async () => {
    for (const who of ["bricx_app", "bricx_readonly"] as const) {
      expect(await inTx(who, undefined, read)).toEqual({
        org: null,
        user: null,
        has: false,
      });
    }
  });

  test("in a context: its org and user; has_project only for its projects", async () => {
    expect(await inTx("bricx_app", ctxOf(A), read)).toEqual({
      org: A.org,
      user: A.user,
      has: true,
    });
    expect(await inTx("bricx_app", ctxOf(A, [B.project]), read)).toEqual({
      org: A.org,
      user: A.user,
      has: false,
    });
    expect(await inTx("bricx_app", ctxOf(A, []), read)).toEqual({
      org: A.org,
      user: A.user,
      has: false,
    });
  });

  // After the transaction that set them, the app.* settings read '' (not
  // NULL) for the rest of the session: NULLIF keeps the ::uuid casts from
  // failing with 22P02 on a pooled connection.
  test("after COMMIT the settings read '': still NULL, NULL, false, never 22P02", async () => {
    const client = await pg18.connectAs("bricx_app");
    try {
      await client.query("BEGIN");
      const q = dialect.sqlToQuery(
        contextStatement(validateTxContext(ctxOf(A)), 30_000),
      );
      await client.query(q.sql, q.params);
      await client.query("COMMIT");
      const raw = await client.query<Record<string, string>>(
        `SELECT current_setting('app.org_id', true) AS org,
                current_setting('app.user_id', true) AS user,
                current_setting('app.project_ids', true) AS projects`,
      );
      expect(raw.rows[0]).toEqual({ org: "", user: "", projects: "" });
      expect(await read(client)).toEqual({ org: null, user: null, has: false });
    } finally {
      await client.end();
    }
  });

  test("SQL, STABLE, PARALLEL SAFE, SECURITY INVOKER, no SET clause, owned by bricx_owner", async () => {
    const rows = await asAdmin<Record<string, unknown>>(`
      SELECT p.oid::regprocedure::text AS sig, l.lanname AS lang,
             p.provolatile::text AS volatility, p.proparallel::text AS parallel,
             p.prosecdef AS definer, p.proconfig AS config,
             p.proowner::regrole::text AS owner
      FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang
      WHERE p.pronamespace = 'app'::regnamespace
        AND p.proname IN ('current_org', 'current_user_id', 'has_project')
      ORDER BY 1`);
    const expected = (sig: string) => ({
      sig,
      lang: "sql",
      volatility: "s",
      parallel: "s",
      definer: false,
      config: null,
      owner: "bricx_owner",
    });
    expect(rows).toEqual([
      expected("app.current_org()"),
      expected("app.current_user_id()"),
      expected("app.has_project(uuid)"),
    ]);
  });

  // P5-02 (ADR 0062): schema app holds the three RLS functions and the
  // provisioning function, nothing else; users.int.test.ts proves the
  // latter (SECURITY DEFINER, pinned search_path, bricx_app only).
  test("schema app holds exactly the three RLS functions and app.provision_user()", async () => {
    const rows = await asAdmin<{ sig: string }>(`
      SELECT p.oid::regprocedure::text AS sig FROM pg_proc p
      WHERE p.pronamespace = 'app'::regnamespace ORDER BY 1`);
    expect(rows.map((r) => r.sig)).toEqual([
      "app.current_org()",
      "app.current_user_id()",
      "app.has_project(uuid)",
      "app.provision_user(text,timestamp with time zone,integer)",
    ]);
  });

  test("EXECUTE: bricx_app and bricx_readonly only; never PUBLIC or powersync_repl", async () => {
    const rows = await asAdmin<{ sig: string; role: string; ok: boolean }>(`
      SELECT p.oid::regprocedure::text AS sig, r.rolname AS role,
             has_function_privilege(r.oid, p.oid, 'EXECUTE') AS ok
      FROM pg_proc p, pg_roles r
      WHERE p.pronamespace = 'app'::regnamespace
        AND p.proname IN ('current_org', 'current_user_id', 'has_project')
        AND r.rolname IN ('bricx_app', 'bricx_readonly', 'powersync_repl', 'powersync_storage_owner')
      ORDER BY 1, 2`);
    expect(rows).toHaveLength(12);
    for (const row of rows) {
      expect(row.ok, `${row.role} ${row.sig}`).toBe(
        row.role === "bricx_app" || row.role === "bricx_readonly",
      );
    }
    const publicGrants = await asAdmin(`
      SELECT p.proname FROM pg_proc p
      WHERE p.pronamespace = 'app'::regnamespace
        AND (p.proacl IS NULL
             OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a WHERE a.grantee = 0))`);
    expect(publicGrants).toEqual([]);
  });

  test("a function a later migration creates is not executable until it grants it", async () => {
    const rows = await asAdmin<{ role: string; ok: boolean }>(`
      SELECT r.rolname AS role,
             has_function_privilege(r.oid, 'bricx.fx_later()'::regprocedure, 'EXECUTE') AS ok
      FROM pg_roles r WHERE r.rolname IN ('bricx_app', 'bricx_readonly', 'powersync_repl')
      ORDER BY 1`);
    expect(rows).toEqual([
      { role: "bricx_app", ok: false },
      { role: "bricx_readonly", ok: false },
      { role: "powersync_repl", ok: false },
    ]);
  });
});

describe("every table in schema bricx (P4-04 Done when)", () => {
  // P4-06: the system tenant tables (bricx.outbox) carry their own
  // policies; packages/db/test/outbox.int.test.ts proves them.
  // P5-02 (D8, ADR 0062): bricx.users holds no org_id; it is the one user
  // table (USER_TABLES), own-row RLS, proven by users.int.test.ts.
  test("the database holds exactly the registered tenant tables, the system tenant tables, the user tables and the fixtures", async () => {
    const tables = await asAdmin<{ t: string }>(`
      SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
      WHERE table_schema IN ('bricx', 'app') AND table_type = 'BASE TABLE'
      ORDER BY 1`);
    expect(tables.length).toBeGreaterThan(0);
    expect(tables.map((r) => r.t)).toEqual(
      [
        ...Object.keys(ALL_TABLES),
        ...Object.keys(SYSTEM_TENANT_TABLES),
        ...Object.keys(USER_TABLES),
      ].sort(),
    );
  });

  test.each(Object.entries(ALL_TABLES))(
    "%s (%s): ENABLE + FORCE, the policies and their roles, the grants",
    async (table, resource) => {
      const policy = tenantPolicy(resource);
      const flags = await asAdmin(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class WHERE oid = $1::regclass`,
        [table],
      );
      expect(flags).toEqual([{ enabled: true, forced: true }]);
      const [schema, name = ""] = table.split(".");
      const policies = await asAdmin<{
        name: string;
        cmd: string;
        roles: string[];
        qual: string | null;
        check: string | null;
      }>(
        `SELECT policyname AS name, cmd, roles::text[] AS roles, qual, with_check AS check
         FROM pg_policies WHERE schemaname = $1 AND tablename = $2 ORDER BY policyname`,
        [schema, name],
      );
      // The tenant policies, by name; a table on OWN_ROW_TABLES carries
      // exactly its two own-row policies besides (P5-03, ADR 0063), and
      // no table carries any other policy.
      const tenant = policies.filter(
        (p) => p.name === `${name}_${p.cmd.toLowerCase()}`,
      );
      const byCmd = Object.fromEntries(
        tenant.map((p) => [p.cmd, [...p.roles].sort()]),
      );
      expect(byCmd).toEqual({
        SELECT: [...POLICY_ROLES.select].sort(),
        INSERT: [...POLICY_ROLES.insert].sort(),
        ...(policy.appendOnly
          ? {}
          : { UPDATE: [...POLICY_ROLES.update].sort() }),
      });
      const others = policies
        .filter((p) => !tenant.includes(p))
        .map(
          (p) =>
            `${p.name}:${p.cmd}:${[...p.roles].sort().join("+")}:${p.qual ?? ""}:${p.check ?? ""}`,
        )
        .sort();
      const column = OWN_ROW_TABLES[table];
      expect(others).toEqual(
        column === undefined
          ? []
          : [
              `${name}_own_select:SELECT:bricx_app+bricx_readonly:(${column} = app.current_user_id()):`,
              `${name}_own_update:UPDATE:bricx_app:(${column} = app.current_user_id()):(${column} = app.current_user_id())`,
            ],
      );
      const grants = await asAdmin<{ role: string; privileges: string }>(
        `SELECT r.rolname AS role,
                concat_ws(',',
                  CASE WHEN has_table_privilege(r.oid, $1::regclass, 'SELECT') THEN 'SELECT' END,
                  CASE WHEN has_table_privilege(r.oid, $1::regclass, 'INSERT') THEN 'INSERT' END,
                  CASE WHEN has_table_privilege(r.oid, $1::regclass, 'UPDATE') THEN 'UPDATE' END,
                  CASE WHEN has_table_privilege(r.oid, $1::regclass, 'DELETE') THEN 'DELETE' END,
                  CASE WHEN has_table_privilege(r.oid, $1::regclass, 'TRUNCATE') THEN 'TRUNCATE' END) AS privileges
         FROM pg_roles r WHERE r.rolname IN ('bricx_app', 'bricx_readonly', 'powersync_repl')
         ORDER BY 1`,
        [table],
      );
      expect(grants).toEqual([
        {
          role: "bricx_app",
          privileges: policy.appendOnly
            ? "SELECT,INSERT"
            : "SELECT,INSERT,UPDATE,DELETE",
        },
        { role: "bricx_readonly", privileges: "SELECT" },
        { role: "powersync_repl", privileges: "" },
      ]);
    },
  );

  test.each(Object.entries(ALL_TABLES))(
    "%s (%s): bricx_app sees and writes only its own org's rows",
    async (table, resource) => {
      const policy = tenantPolicy(resource);
      const t = qualified(table);
      const org = quote(policy.columns.org);
      const count = `SELECT 1 FROM ${t}`;

      // No context: no rows.
      expect(await outcome("bricx_app", undefined, count)).toBe("ok:0");
      // Each org sees only its own rows.
      expect(await visibleOrgs("bricx_app", ctxOf(A), table)).toEqual([A.org]);
      expect(await visibleOrgs("bricx_app", ctxOf(B), table)).toEqual([B.org]);

      // INSERT: its own org's row only.
      const own = rowFor(table, C);
      expect(
        await inTx("bricx_app", ctxOf(C), async (client) => {
          await client.query(own.text, own.params);
          return (await client.query(count)).rowCount;
        }),
      ).toBe(1);
      expect(await outcome("bricx_app", ctxOf(A), own.text, own.params)).toBe(
        DENIED,
      );
      if (policy.createdBy) {
        const forged = rowFor(table, C, { created_by: A.user });
        expect(
          await outcome("bricx_app", ctxOf(C), forged.text, forged.params),
        ).toBe(DENIED);
      }

      // UPDATE and DELETE.
      const updateB = `UPDATE ${t} SET ${org} = ${org} WHERE ${org} = $1`;
      const deleteAll = `DELETE FROM ${t}`;
      const deleteOwn = `DELETE FROM ${t} WHERE ${org} = $1`;
      if (policy.appendOnly) {
        // Condition 1: the privilege is revoked, so 42501 before RLS.
        expect(await outcome("bricx_app", ctxOf(A), updateB, [A.org])).toBe(
          DENIED,
        );
        expect(await outcome("bricx_app", ctxOf(A), updateB, [B.org])).toBe(
          DENIED,
        );
        expect(await outcome("bricx_app", ctxOf(A), deleteOwn, [A.org])).toBe(
          DENIED,
        );
        expect(await outcome("bricx_app", ctxOf(A), deleteAll)).toBe(DENIED);
      } else {
        expect(await outcome("bricx_app", ctxOf(A), updateB, [A.org])).toBe(
          "ok:1",
        );
        expect(await outcome("bricx_app", ctxOf(A), updateB, [B.org])).toBe(
          "ok:0",
        );
        expect(
          await outcome(
            "bricx_app",
            ctxOf(A),
            `UPDATE ${t} SET ${org} = $2 WHERE ${org} = $1`,
            [A.org, C.org],
          ),
        ).toBe(DENIED);
        // No DELETE policy: nothing is deleted, own rows included.
        expect(await outcome("bricx_app", ctxOf(A), deleteOwn, [A.org])).toBe(
          "ok:0",
        );
        expect(await outcome("bricx_app", ctxOf(A), deleteAll)).toBe("ok:0");
      }

      // Project and site level: only the context's projects.
      if (policy.columns.project !== undefined) {
        expect(await outcome("bricx_app", ctxOf(A, []), count)).toBe("ok:0");
        expect(await outcome("bricx_app", ctxOf(A, [B.project]), count)).toBe(
          "ok:0",
        );
        // project.project's INSERT is org + created_by: a new project is
        // not yet in anyone's project list (ADR 0048).
        expect(
          await outcome("bricx_app", ctxOf(C, []), own.text, own.params),
        ).toBe(policy.columns.project === "id" ? "ok:1" : DENIED);
      }
    },
  );

  test.each(Object.entries(ALL_TABLES))(
    "%s (%s): bricx_readonly reads its own org's rows and never writes (condition 4)",
    async (table) => {
      const t = qualified(table);
      expect(
        await outcome("bricx_readonly", undefined, `SELECT 1 FROM ${t}`),
      ).toBe("ok:0");
      expect(await visibleOrgs("bricx_readonly", ctxOf(A), table)).toEqual([
        A.org,
      ]);
      const own = rowFor(table, C);
      expect(
        await outcome("bricx_readonly", ctxOf(C), own.text, own.params),
      ).toBe(DENIED);
      expect(
        await outcome("bricx_readonly", ctxOf(A), `UPDATE ${t} SET id = id`),
      ).toBe(DENIED);
      expect(
        await outcome("bricx_readonly", ctxOf(A), `DELETE FROM ${t}`),
      ).toBe(DENIED);
    },
  );

  test.each(Object.entries(ALL_TABLES))(
    "%s (%s): bricx_owner is bound by FORCE: no rows without a context",
    async (table) => {
      expect(
        await outcome(
          "bricx_owner",
          undefined,
          `SELECT 1 FROM ${qualified(table)}`,
        ),
      ).toBe("ok:0");
      expect(await visibleOrgs("bricx_owner", ctxOf(B), table)).toEqual([
        B.org,
      ]);
    },
  );
});

describe("foreign-key parents are seeded first (P5-03, ROADMAP P5 Also line)", () => {
  test("SEED_PARENTS is exactly the catalog's foreign keys between bricx tables, and the seeding order puts every parent first", async () => {
    const edges = await asAdmin<{ child: string; parent: string }>(`
      SELECT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE c.contype = 'f' AND n.nspname = 'bricx' ORDER BY 1, 2`);
    expect(edges).toEqual(
      Object.entries(SEED_PARENTS)
        .flatMap(([child, parents]) =>
          parents.map((parent) => ({ child, parent })),
        )
        .sort((x, y) =>
          `${x.child} ${x.parent}`.localeCompare(`${y.child} ${y.parent}`),
        ),
    );
    expect(edges.length).toBeGreaterThan(0);
    for (const { child, parent } of edges) {
      expect(
        SEEDED_TABLES.indexOf(parent),
        `${parent} before ${child}`,
      ).toBeLessThan(SEEDED_TABLES.indexOf(child));
    }
    // The dependency closure of sessions, parents first.
    expect(seedOrder(["bricx.sessions"])).toEqual([
      "bricx.users",
      "bricx.devices",
      "bricx.sessions",
    ]);
  });

  test("seeding a child before its parent is refused by the FK (23503); in parent-first order it succeeds", async () => {
    const D = party("d");
    const admin = await pg18.admin();
    const attempt = async (table: string) => {
      const row = rowFor(table, D);
      await admin.query("SAVEPOINT s");
      try {
        await admin.query(row.text, row.params);
        return "ok";
      } catch (error) {
        await admin.query("ROLLBACK TO SAVEPOINT s");
        if (typeof error === "object" && error !== null && "code" in error) {
          return String(error.code);
        }
        throw error;
      }
    };
    try {
      await admin.query("BEGIN");
      expect(await attempt("bricx.sessions")).toBe("23503");
      expect(await attempt("bricx.devices")).toBe("23503");
      for (const table of seedOrder(["bricx.sessions"])) {
        expect(await attempt(table), table).toBe("ok");
      }
    } finally {
      await admin.query("ROLLBACK");
      await admin.end();
    }
  });
});

describe("the migrator's guard (deny-by-default, condition 2)", () => {
  const history = async () =>
    (
      await asAdmin<{ tag: string }>(
        "SELECT tag FROM bricx_migrations.applied ORDER BY idx",
      )
    ).map((r) => r.tag);

  // A foreign table needs a server bricx_owner may use. Created once by
  // the test superuser; the wrapper has no handler, so the table can be
  // created but never read (review round 2).
  beforeAll(async () => {
    await asAdmin("CREATE FOREIGN DATA WRAPPER fx_wrapper");
    await asAdmin("CREATE SERVER fx_server FOREIGN DATA WRAPPER fx_wrapper");
    await asAdmin("GRANT USAGE ON FOREIGN SERVER fx_server TO bricx_owner");
  });

  async function refusal(tag: string, statements: string[]) {
    const before = await history();
    const dir = await composeMigrations(
      [MIGRATIONS_DIR, FIXTURE_DIR],
      [{ idx: 9500, tag, statements }],
    );
    let caught: unknown;
    try {
      await migrate(ownerUrl(), dir);
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof MigrationError)) throw new Error("not refused");
    expect(await history()).toEqual(before);
    return caught;
  }

  test.each([
    [
      "a table with no org_id and no RLS",
      "9500_lookup",
      [
        'CREATE TABLE "bricx"."fx_lookup" ("code" text PRIMARY KEY, "label" text NOT NULL);',
      ],
      "bricx.fx_lookup",
    ],
    [
      "a tenant table without RLS",
      "9500_plain",
      [
        'CREATE TABLE "bricx"."fx_plain" ("id" uuid PRIMARY KEY, "org_id" uuid NOT NULL);',
      ],
      "bricx.fx_plain",
    ],
    [
      "ENABLE without FORCE",
      "9500_enabled",
      [
        'CREATE TABLE "bricx"."fx_enabled" ("id" uuid PRIMARY KEY, "org_id" uuid NOT NULL);',
        'ALTER TABLE "bricx"."fx_enabled" ENABLE ROW LEVEL SECURITY;',
      ],
      "bricx.fx_enabled",
    ],
    [
      "FORCE without ENABLE",
      "9500_forced",
      [
        'CREATE TABLE "bricx"."fx_forced" ("id" uuid PRIMARY KEY, "org_id" uuid NOT NULL);',
        'ALTER TABLE "bricx"."fx_forced" FORCE ROW LEVEL SECURITY;',
      ],
      "bricx.fx_forced",
    ],
    [
      "a partitioned table without RLS",
      "9500_partitioned",
      [
        'CREATE TABLE "bricx"."fx_partitioned" ("org_id" uuid NOT NULL) PARTITION BY LIST ("org_id");',
      ],
      "bricx.fx_partitioned",
    ],
    [
      "a materialized view (cannot carry RLS)",
      "9500_matview",
      [
        'CREATE MATERIALIZED VIEW "bricx"."fx_matview" AS SELECT "org_id", "note" FROM "bricx"."fx_org_member";',
      ],
      "bricx.fx_matview",
    ],
    [
      "a foreign table (cannot carry RLS)",
      "9500_foreign",
      [
        'CREATE FOREIGN TABLE "bricx"."fx_remote" ("id" uuid, "org_id" uuid) SERVER fx_server;',
      ],
      "bricx.fx_remote",
    ],
    [
      "a materialized view in schema app",
      "9500_app_matview",
      ['CREATE MATERIALIZED VIEW "app"."fx_app_matview" AS SELECT 1 AS "x";'],
      "app.fx_app_matview",
    ],
    [
      "a table in schema app without RLS",
      "9500_app_table",
      ['CREATE TABLE "app"."fx_cache" ("id" uuid PRIMARY KEY);'],
      "app.fx_cache",
    ],
    [
      "an existing tenant table losing FORCE",
      "9500_no_force",
      ['ALTER TABLE "bricx"."fx_org_member" NO FORCE ROW LEVEL SECURITY;'],
      "bricx.fx_org_member",
    ],
  ])(
    "refuses %s (tenant_rls_missing) and rolls it back",
    async (_what, tag, statements, relation) => {
      const error = await refusal(tag, statements);
      expect(error).toMatchObject({
        code: "tenant_rls_missing",
        tag,
        relation,
      });
      expect(error.message).toBe(
        `migration refused: tenant_rls_missing (${tag}): ${relation}`,
      );
      const table = await asAdmin<{ t: string | null; forced: boolean | null }>(
        `SELECT to_regclass($1)::text AS t,
              (SELECT relforcerowsecurity FROM pg_class WHERE oid = to_regclass($1)) AS forced`,
        [relation],
      );
      expect(table).toEqual([
        relation === "bricx.fx_org_member"
          ? { t: "bricx.fx_org_member", forced: true }
          : { t: null, forced: null },
      ]);
    },
  );

  test.each([
    [
      "SECURITY DEFINER without SET search_path",
      "9500_definer",
      [
        'CREATE FUNCTION "bricx"."fx_definer_bad"() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER BEGIN ATOMIC SELECT 1; END;',
      ],
      "bricx.fx_definer_bad()",
    ],
    [
      "SECURITY DEFINER with another SET only",
      "9500_definer_set",
      [
        'CREATE FUNCTION "app"."fx_definer_set"() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET work_mem = \'1MB\' BEGIN ATOMIC SELECT 1; END;',
      ],
      "app.fx_definer_set()",
    ],
  ])(
    "refuses %s (definer_search_path) and rolls it back",
    async (_what, tag, statements, relation) => {
      const error = await refusal(tag, statements);
      expect(error).toMatchObject({
        code: "definer_search_path",
        tag,
        relation,
      });
      expect(
        await asAdmin("SELECT to_regprocedure($1) AS f", [relation]),
      ).toEqual([{ f: null }]);
    },
  );

  // P5-02 (owner condition 3, ADR 0062): "pinned" means only the owner's
  // and the system's schemas; a writable or per-user schema is refused.
  test.each([
    ["public", "public"],
    ["$user", '"$user"'],
    ["public after pg_catalog", "pg_catalog, public"],
  ])(
    "refuses a SECURITY DEFINER search_path naming %s (definer_search_path)",
    async (_what, path) => {
      const tag = "9502_definer_path";
      const relation = "bricx.fx_definer_path()";
      const error = await refusal(tag, [
        `CREATE FUNCTION "bricx"."fx_definer_path"() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = ${path} BEGIN ATOMIC SELECT 1; END;`,
      ]);
      expect(error).toMatchObject({
        code: "definer_search_path",
        tag,
        relation,
      });
      expect(
        await asAdmin("SELECT to_regprocedure($1) AS f", [relation]),
      ).toEqual([{ f: null }]);
    },
  );

  test("refuses a pinned SECURITY DEFINER function that PUBLIC may EXECUTE (definer_public_execute)", async () => {
    const tag = "9503_definer_public";
    const relation = "app.fx_definer_public()";
    const error = await refusal(tag, [
      'CREATE FUNCTION "app"."fx_definer_public"() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp BEGIN ATOMIC SELECT 1; END;',
      'GRANT EXECUTE ON FUNCTION "app"."fx_definer_public"() TO PUBLIC;',
    ]);
    expect(error).toMatchObject({
      code: "definer_public_execute",
      tag,
      relation,
    });
    expect(
      await asAdmin("SELECT to_regprocedure($1) AS f", [relation]),
    ).toEqual([{ f: null }]);
  });

  test("the same function granted to bricx_app only passes the guard", async () => {
    const client = await pg18.connectAs("bricx_owner");
    try {
      await client.query("BEGIN");
      await client.query(
        'CREATE FUNCTION "app"."fx_definer_app"() RETURNS integer LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, pg_temp BEGIN ATOMIC SELECT 1; END;',
      );
      await client.query(
        'GRANT EXECUTE ON FUNCTION "app"."fx_definer_app"() TO bricx_app',
      );
      expect(await guardProblem(client)).toBeUndefined();
      await client.query(
        'GRANT EXECUTE ON FUNCTION "app"."fx_definer_app"() TO PUBLIC',
      );
      expect(await guardProblem(client)).toEqual({
        code: "definer_public_execute",
        relation: "app.fx_definer_app()",
      });
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });

  test("accepts SECURITY DEFINER with a pinned search_path (fixture 9001)", async () => {
    expect(
      await asAdmin<{ config: string[] }>(
        "SELECT proconfig AS config FROM pg_proc WHERE oid = 'bricx.fx_definer()'::regprocedure",
      ),
    ).toEqual([{ config: ["search_path=pg_catalog, pg_temp"] }]);
  });

  test("an allowlisted global table passes; the same table unlisted does not", async () => {
    const client = await pg18.connectAs("bricx_owner");
    try {
      await client.query("BEGIN");
      await client.query(
        'CREATE TABLE "bricx"."fx_currency" ("code" text PRIMARY KEY)',
      );
      expect(await guardProblem(client)).toEqual({
        code: "tenant_rls_missing",
        relation: "bricx.fx_currency",
      });
      expect(await guardProblem(client, ["bricx.fx_currency"])).toBeUndefined();
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });

  test("a plain view passes; an allowlisted materialized view passes, unlisted it does not", async () => {
    const client = await pg18.connectAs("bricx_owner");
    try {
      await client.query("BEGIN");
      await client.query(
        'CREATE VIEW "bricx"."fx_view" AS SELECT "org_id" FROM "bricx"."fx_org_member"',
      );
      expect(await guardProblem(client)).toBeUndefined();
      await client.query(
        'CREATE MATERIALIZED VIEW "bricx"."fx_rates" AS SELECT 1 AS "x"',
      );
      expect(await guardProblem(client)).toEqual({
        code: "tenant_rls_missing",
        relation: "bricx.fx_rates",
      });
      expect(await guardProblem(client, ["bricx.fx_rates"])).toBeUndefined();
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});

// P4-09 (ADR 0059, owner conditions 1 and 2): the guard reads the
// catalog. Every table on APPEND_ONLY_TABLES gives bricx_app no UPDATE,
// DELETE or TRUNCATE; every table in publication powersync gives
// powersync_repl SELECT. The catalog is the authority; the text rules in
// scripts/guards.mjs only catch mistakes earlier.
describe("the migrator's catalog guard (P4-09 conditions 1 and 2)", () => {
  async function refused(tag: string, statements: string[]) {
    const dir = await composeMigrations(
      [MIGRATIONS_DIR, FIXTURE_DIR],
      [{ idx: 9600, tag, statements }],
    );
    try {
      await migrate(ownerUrl(), dir);
    } catch (error) {
      if (error instanceof MigrationError) return error;
      throw error;
    }
    throw new Error("not refused");
  }

  /** Runs `run` as bricx_owner in a transaction that is rolled back. */
  async function asOwner<T>(run: (client: pg.Client) => Promise<T>) {
    const client = await pg18.connectAs("bricx_owner");
    try {
      await client.query("BEGIN");
      return await run(client);
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  }

  test.each([
    ["UPDATE", 'GRANT UPDATE ON "bricx"."audit_events" TO bricx_app;'],
    [
      "a column UPDATE",
      'GRANT UPDATE ("action") ON "bricx"."audit_events" TO bricx_app;',
    ],
    ["DELETE", 'GRANT DELETE ON "bricx"."audit_events" TO bricx_app;'],
    ["TRUNCATE", 'GRANT TRUNCATE ON "bricx"."audit_events" TO bricx_app;'],
  ])(
    "refuses a migration that gives bricx_app %s on an append-only table (append_only_writable) and rolls it back",
    async (_what, statement) => {
      const error = await refused("9600_writable", [statement]);
      expect(error).toMatchObject({
        code: "append_only_writable",
        tag: "9600_writable",
        relation: "bricx.audit_events",
      });
      expect(error.message).toBe(
        "migration refused: append_only_writable (9600_writable): bricx.audit_events",
      );
      const [row] = await asAdmin<{ u: boolean; d: boolean }>(
        `SELECT has_any_column_privilege('bricx_app', 'bricx.audit_events', 'UPDATE') AS u,
                has_table_privilege('bricx_app', 'bricx.audit_events', 'DELETE') AS d`,
      );
      expect(row).toEqual({ u: false, d: false });
    },
  );

  // The SQL pnpm db:rls gives a copy for an append-only resource (owner
  // decision 2026-10-17: new-module refuses append-only subjects, so the
  // guard is proven on that SQL here). Without its REVOKE it is refused.
  test("enableTenantRls() for an append-only resource passes; without its REVOKE the guard refuses it", async () => {
    const create =
      'CREATE TABLE "bricx"."fx_ledger_lines" ("id" uuid PRIMARY KEY, "org_id" uuid NOT NULL)';
    const rls = enableTenantRls("bricx.fx_ledger_lines", "finance.ledger")
      .split("\n--> statement-breakpoint\n")
      .map((statement) => statement.trim());
    const revoke = rls.filter((statement) => /^REVOKE /m.test(statement));
    expect(revoke).toEqual([
      'REVOKE UPDATE, DELETE ON "bricx"."fx_ledger_lines" FROM bricx_app;',
    ]);
    const listed = ["bricx.fx_ledger_lines"];
    expect(
      await asOwner(async (client) => {
        await client.query(create);
        for (const statement of rls) await client.query(statement);
        return guardProblem(client, [], listed);
      }),
    ).toBeUndefined();
    expect(
      await asOwner(async (client) => {
        await client.query(create);
        for (const statement of rls) {
          if (!revoke.includes(statement)) await client.query(statement);
        }
        return guardProblem(client, [], listed);
      }),
    ).toEqual({
      code: "append_only_writable",
      relation: "bricx.fx_ledger_lines",
    });
  });

  test("a listed append-only table that does not exist yet is not a problem", async () => {
    expect(
      await asOwner((client) => guardProblem(client, [], ["bricx.fx_later"])),
    ).toBeUndefined();
  });

  const published = [
    'CREATE TABLE "bricx"."fx_published" ("id" uuid PRIMARY KEY, "org_id" uuid NOT NULL);',
    'ALTER TABLE "bricx"."fx_published" ENABLE ROW LEVEL SECURITY;',
    'ALTER TABLE "bricx"."fx_published" FORCE ROW LEVEL SECURITY;',
  ];

  test("refuses a table in publication powersync without SELECT for powersync_repl (publication_without_grant)", async () => {
    const error = await refused("9600_published", [
      ...published,
      'ALTER PUBLICATION powersync ADD TABLE "bricx"."fx_published";',
    ]);
    expect(error).toMatchObject({
      code: "publication_without_grant",
      tag: "9600_published",
      relation: "bricx.fx_published",
    });
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM pg_publication_tables WHERE pubname = 'powersync'",
      ),
    ).toEqual([{ n: 0 }]);
    expect(
      await asAdmin("SELECT to_regclass('bricx.fx_published')::text AS t"),
    ).toEqual([{ t: null }]);
  });

  test("passes with GRANT SELECT ... TO powersync_repl; a later REVOKE is refused (the catalog is the authority)", async () => {
    await asOwner(async (client) => {
      for (const statement of published) await client.query(statement);
      await client.query(
        'GRANT SELECT ON "bricx"."fx_published" TO powersync_repl',
      );
      await client.query(
        'ALTER PUBLICATION powersync ADD TABLE "bricx"."fx_published"',
      );
      expect(await guardProblem(client)).toBeUndefined();
      await client.query(
        'REVOKE SELECT ON "bricx"."fx_published" FROM powersync_repl',
      );
      expect(await guardProblem(client)).toEqual({
        code: "publication_without_grant",
        relation: "bricx.fx_published",
      });
    });
  });

  // P5-02 (found by its sabotage runs): the planner may evaluate the
  // privilege check on every pg_class row before the publication join,
  // and the name form of has_table_privilege() then fails on pg_toast
  // relations as bricx_owner. Forcing the plan that did so makes the
  // flake deterministic; the guard must answer the same either way.
  test("the publication check holds under any join plan (no name lookup of unrelated relations)", async () => {
    for (const forced of [
      ["SET LOCAL enable_hashjoin = off"],
      [
        "SET LOCAL enable_mergejoin = off",
        "SET LOCAL enable_hashjoin = off",
        "SET LOCAL enable_indexscan = off",
        "SET LOCAL enable_bitmapscan = off",
      ],
    ]) {
      await asOwner(async (client) => {
        for (const statement of published) await client.query(statement);
        await client.query(
          'ALTER PUBLICATION powersync ADD TABLE "bricx"."fx_published"',
        );
        for (const statement of forced) await client.query(statement);
        expect(await guardProblem(client), forced.join("; ")).toEqual({
          code: "publication_without_grant",
          relation: "bricx.fx_published",
        });
        await client.query(
          'GRANT SELECT ON "bricx"."fx_published" TO powersync_repl',
        );
        expect(await guardProblem(client), forced.join("; ")).toBeUndefined();
      });
    }
  });
});

// Condition 5 (ADR 0054): bricx_owner is bound by FORCE, so a data
// migration sees no rows until it sets its own context, and then only that
// org's rows; the setting ends with the migration's transaction.
describe("a data migration (backfill) sets its own context", () => {
  test("without a context it touches nothing; with app.org_id = A only A's rows", async () => {
    const result = await migrate(
      ownerUrl(),
      await composeMigrations(
        [MIGRATIONS_DIR, FIXTURE_DIR],
        [
          {
            idx: 9900,
            tag: "9900_backfill",
            statements: [
              `UPDATE "bricx"."fx_org_member" SET "note" = 'no-context';`,
              `SELECT set_config('app.org_id', '${A.org}', true);`,
              `UPDATE "bricx"."fx_org_member" SET "note" = 'backfilled';`,
            ],
          },
        ],
      ),
    );
    expect(result.applied).toEqual(["9900_backfill"]);
    expect(
      await asAdmin(
        `SELECT org_id::text AS org, note FROM bricx.fx_org_member ORDER BY 1`,
      ),
    ).toEqual([
      { org: A.org, note: "backfilled" },
      { org: B.org, note: "seed" },
    ]);
  });

  test("a project-scoped backfill also sets app.project_ids: with the org alone it touches nothing", async () => {
    const result = await migrate(
      ownerUrl(),
      await composeMigrations(
        [MIGRATIONS_DIR, FIXTURE_DIR],
        [
          {
            idx: 9900,
            tag: "9900_backfill",
            statements: [
              `UPDATE "bricx"."fx_org_member" SET "note" = 'no-context';`,
              `SELECT set_config('app.org_id', '${A.org}', true);`,
              `UPDATE "bricx"."fx_org_member" SET "note" = 'backfilled';`,
            ],
          },
          {
            idx: 9901,
            tag: "9901_project_backfill",
            statements: [
              `SELECT set_config('app.org_id', '${A.org}', true);`,
              `UPDATE "bricx"."fx_project_member" SET "note" = 'org-only';`,
              `SELECT set_config('app.project_ids', '{${A.project}}', true);`,
              `UPDATE "bricx"."fx_project_member" SET "note" = 'backfilled';`,
            ],
          },
        ],
      ),
    );
    expect(result.applied).toEqual(["9901_project_backfill"]);
    expect(
      await asAdmin(
        `SELECT org_id::text AS org, note FROM bricx.fx_project_member ORDER BY 1`,
      ),
    ).toEqual([
      { org: A.org, note: "backfilled" },
      { org: B.org, note: "seed" },
    ]);
  });
});
