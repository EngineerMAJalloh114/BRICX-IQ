// Every property the P2-02 bootstrap (infrastructure/docker/postgres/init,
// ADR 0035) must have, checked against a live database. Returns a list of
// problems, empty when all hold, so the integration test can prove each
// check fails when its property is broken (sabotage cases), the same way
// check:workspace's guards are proven by fixtures.
//
// Attempts that must be refused run inside a transaction that is always
// rolled back, so a check never changes the database, even when broken.
import { createHash } from "node:crypto";
import type pg from "pg";
import {
  appDatabase,
  type BootstrappedPostgres,
  type Role,
  roles,
  storageDatabase,
} from "./stack.js";

/** Postgres "insufficient_privilege": the refusal every attempt expects. */
const DENIED = "42501";

const ORG_A = "0192d4a0-0000-7000-8000-00000000000a";
const ORG_B = "0192d4a0-0000-7000-8000-00000000000b";

type Flags = Record<
  | "rolsuper"
  | "rolcreatedb"
  | "rolcreaterole"
  | "rolreplication"
  | "rolbypassrls"
  | "rolcanlogin",
  boolean
>;

const none = {
  rolsuper: false,
  rolcreatedb: false,
  rolcreaterole: false,
  rolreplication: false,
  rolbypassrls: false,
  rolcanlogin: true,
};

/** Exact attributes of every role (requirement 1, ruling C1). */
export const expectedFlags: Record<Role, Flags> = {
  bricx_owner: none,
  bricx_app: none,
  bricx_readonly: none,
  powersync_repl: { ...none, rolreplication: true, rolbypassrls: true },
  powersync_storage_owner: none,
};

const appPath = "search_path=bricx, extensions, pg_temp";
export const expectedSearchPath: Record<Role, string> = {
  bricx_owner: appPath,
  bricx_app: appPath,
  bricx_readonly: appPath,
  powersync_repl: appPath,
  powersync_storage_owner: "search_path=powersync, pg_temp",
};

/** Which databases each role may connect to (ruling B1). */
export const expectedConnect: Record<Role, string[]> = {
  bricx_owner: [appDatabase],
  bricx_app: [appDatabase],
  bricx_readonly: [appDatabase],
  powersync_repl: [appDatabase],
  powersync_storage_owner: [storageDatabase],
};

/** The probe tables the checks use; created by createProbes(). */
export const RLS_PROBE = "bricx.rls_probe";
export const SYNC_PROBE = "bricx.sync_probe";

/**
 * Probe tables, created the way migrations will: by bricx_owner, with
 * ENABLE + FORCE ROW LEVEL SECURITY and an org policy on the transaction
 * setting app.org_id. sync_probe is published following the pairing rule
 * (GRANT SELECT to powersync_repl + ALTER PUBLICATION in one transaction);
 * rls_probe is not. Rows for two orgs (2 for A, 3 for B) are inserted by
 * the bootstrap superuser.
 */
export async function createProbes(db: BootstrappedPostgres): Promise<void> {
  const owner = await db.connectAs("bricx_owner");
  try {
    await owner.query("BEGIN");
    for (const table of [RLS_PROBE, SYNC_PROBE]) {
      await owner.query(`CREATE TABLE ${table} (
        id uuid PRIMARY KEY DEFAULT uuidv7(),
        org_id uuid NOT NULL,
        note text NOT NULL)`);
      await owner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await owner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await owner.query(`CREATE POLICY org_isolation ON ${table}
        USING (org_id = nullif(current_setting('app.org_id', true), '')::uuid)
        WITH CHECK (org_id = nullif(current_setting('app.org_id', true), '')::uuid)`);
    }
    await owner.query(`GRANT SELECT ON ${SYNC_PROBE} TO powersync_repl`);
    await owner.query(`ALTER PUBLICATION powersync ADD TABLE ${SYNC_PROBE}`);
    await owner.query("COMMIT");
  } finally {
    await owner.end();
  }
  const admin = await db.admin();
  try {
    for (const table of [RLS_PROBE, SYNC_PROBE]) {
      await admin.query(
        `INSERT INTO ${table} (org_id, note) VALUES
          ($1, 'a1'), ($1, 'a2'), ($2, 'b1'), ($2, 'b2'), ($2, 'b3')`,
        [ORG_A, ORG_B],
      );
    }
  } finally {
    await admin.end();
  }
}

/** Runs `sql` in a transaction that is always rolled back. */
async function attempt(
  client: pg.Client,
  sql: string,
  params: unknown[] = [],
  orgId?: string,
): Promise<{ code: string; rows: Record<string, unknown>[] }> {
  await client.query("BEGIN");
  try {
    if (orgId !== undefined) {
      await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    }
    const result = await client.query(sql, params);
    return { code: "ok", rows: result.rows as Record<string, unknown>[] };
  } catch (error) {
    return { code: (error as { code?: string }).code ?? "error", rows: [] };
  } finally {
    await client.query("ROLLBACK");
  }
}

/** Visible probe rows as "org:note", sorted. */
async function visible(
  client: pg.Client,
  table: string,
  orgId?: string,
): Promise<string> {
  const { code, rows } = await attempt(
    client,
    `SELECT CASE org_id WHEN '${ORG_A}' THEN 'A' WHEN '${ORG_B}' THEN 'B' END || ':' || note AS row
     FROM ${table} ORDER BY 1`,
    [],
    orgId,
  );
  return code === "ok" ? rows.map((r) => String(r["row"])).join(",") : code;
}

/**
 * Every bootstrap property, against a database where createProbes() ran.
 * @param published tables expected in publication `powersync`
 */
export async function bootstrapProblems(
  db: BootstrappedPostgres,
  published: string[] = [SYNC_PROBE],
): Promise<string[]> {
  const problems: string[] = [];
  const expect = (what: string, actual: unknown, wanted: unknown) => {
    if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
      problems.push(
        `${what}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(wanted)}`,
      );
    }
  };
  const refused = async (
    who: Role,
    client: pg.Client,
    what: string,
    sql: string,
    orgId?: string,
  ) => {
    expect(
      `${who} ${what}`,
      (await attempt(client, sql, [], orgId)).code,
      DENIED,
    );
  };

  const admin = await db.admin();
  try {
    // Role attributes and pinned search_path (requirement 1, ruling C1).
    const flags = await admin.query<
      Flags & { rolname: Role; config: string[] | null }
    >(
      `SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolreplication,
              rolbypassrls, rolcanlogin,
              (SELECT setconfig FROM pg_db_role_setting
                WHERE setrole = r.oid AND setdatabase = 0) AS config
       FROM pg_roles r WHERE rolname = ANY($1)`,
      [roles],
    );
    for (const role of roles) {
      const row = flags.rows.find((r) => r.rolname === role);
      if (!row) {
        problems.push(`${role}: role missing`);
        continue;
      }
      for (const [flag, wanted] of Object.entries(expectedFlags[role])) {
        expect(`${role}: ${flag}`, row[flag as keyof Flags], wanted);
      }
      expect(`${role}: pinned search_path`, row.config, [
        expectedSearchPath[role],
      ]);
    }

    // PUBLIC: no CONNECT, TEMPORARY or CREATE on either database; no CREATE
    // or USAGE on any schema a role's search_path names (requirement 1).
    for (const database of [appDatabase, storageDatabase]) {
      for (const privilege of ["CONNECT", "TEMPORARY", "CREATE"]) {
        const { rows } = await admin.query<{ granted: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_database d, aclexplode(d.datacl) a
             WHERE d.datname = $1 AND a.grantee = 0 AND a.privilege_type = $2)
           OR (SELECT datacl IS NULL FROM pg_database WHERE datname = $1) AS granted`,
          [database, privilege],
        );
        expect(
          `PUBLIC ${privilege} on database ${database}`,
          rows[0]?.granted,
          false,
        );
      }
    }
    for (const schema of ["public", "bricx", "extensions"]) {
      for (const privilege of ["CREATE", "USAGE"]) {
        const { rows } = await admin.query<{ granted: boolean }>(
          `SELECT EXISTS (SELECT 1 FROM pg_namespace n, aclexplode(n.nspacl) a
             WHERE n.nspname = $1 AND a.grantee = 0 AND a.privilege_type = $2)
           OR (SELECT nspacl IS NULL FROM pg_namespace WHERE nspname = $1) AS granted`,
          [schema, privilege],
        );
        expect(
          `PUBLIC ${privilege} on schema ${schema}`,
          rows[0]?.granted,
          false,
        );
      }
    }

    // Extensions, all in the extensions schema (requirement 3, ruling A2).
    const extensions = await admin.query<{ ext: string }>(
      `SELECT extname || '@' || extnamespace::regnamespace AS ext
       FROM pg_extension WHERE extname <> 'plpgsql' ORDER BY 1`,
    );
    expect(
      "extensions",
      extensions.rows.map((r) => r.ext),
      [
        "btree_gist@extensions",
        "pg_trgm@extensions",
        "pgcrypto@extensions",
        "postgis@extensions",
      ],
    );

    // Publication: owned by bricx_owner, publishes every change PowerSync
    // needs, holds exactly the tables paired with a GRANT (requirement 2).
    const publication = await admin.query(
      `SELECT pubowner::regrole::text AS owner, puballtables, pubinsert,
              pubupdate, pubdelete, pubtruncate, pubviaroot
       FROM pg_publication WHERE pubname = 'powersync'`,
    );
    expect("publication powersync", publication.rows[0], {
      owner: "bricx_owner",
      puballtables: false,
      pubinsert: true,
      pubupdate: true,
      pubdelete: true,
      pubtruncate: true,
      pubviaroot: false,
    });
    const pubTables = await admin.query<{ t: string }>(
      `SELECT schemaname || '.' || tablename AS t FROM pg_publication_tables
       WHERE pubname = 'powersync' ORDER BY 1`,
    );
    expect(
      "tables in publication powersync",
      pubTables.rows.map((r) => r.t),
      published,
    );
    const replSelect = await admin.query<{ t: string }>(
      `SELECT table_schema || '.' || table_name AS t
       FROM information_schema.role_table_grants
       WHERE grantee = 'powersync_repl' ORDER BY 1`,
    );
    expect(
      "powersync_repl table privileges (SELECT on published tables only)",
      replSelect.rows.map((r) => r.t),
      published,
    );
    const replPrivileges = await admin.query<{ p: string }>(
      `SELECT DISTINCT privilege_type AS p FROM information_schema.role_table_grants
       WHERE grantee = 'powersync_repl' ORDER BY 1`,
    );
    expect(
      "powersync_repl privilege types",
      replPrivileges.rows.map((r) => r.p),
      published.length > 0 ? ["SELECT"] : [],
    );

    // Default privileges: DML (no TRUNCATE, REFERENCES, TRIGGER) for the
    // app, SELECT for reporting, nothing for powersync_repl.
    const defaults = await admin.query<{ d: string }>(
      `SELECT d.defaclrole::regrole::text || ' ' || d.defaclobjtype::text || ' '
              || a.grantee::regrole::text || ' ' || string_agg(a.privilege_type, ',' ORDER BY a.privilege_type) AS d
       FROM pg_default_acl d, aclexplode(d.defaclacl) a
       WHERE d.defaclnamespace = 'bricx'::regnamespace
       GROUP BY d.defaclrole, d.defaclobjtype, a.grantee ORDER BY 1`,
    );
    expect(
      "default privileges in schema bricx",
      defaults.rows.map((r) => r.d).sort(),
      [
        "bricx_owner S bricx_app SELECT,USAGE",
        "bricx_owner r bricx_app DELETE,INSERT,SELECT,UPDATE",
        "bricx_owner r bricx_readonly SELECT",
      ].sort(),
    );
  } finally {
    await admin.end();
  }

  // Who can connect where, by real connection attempts (ruling B1).
  for (const role of roles) {
    for (const database of [appDatabase, storageDatabase]) {
      let outcome = "ok";
      try {
        const client = await db.connectAs(role, database);
        await client.end();
      } catch (error) {
        outcome = (error as { code?: string }).code ?? "error";
      }
      const wanted = expectedConnect[role].includes(database) ? "ok" : DENIED;
      expect(`${role} connects to database ${database}`, outcome, wanted);
    }
  }

  // bricx_app: DML under RLS, no DDL, no TRUNCATE (requirements 1 and 8).
  const app = await db.connectAs("bricx_app");
  try {
    for (const [what, sql] of [
      ["CREATE TABLE in bricx", "CREATE TABLE bricx.sabotage (id int)"],
      ["CREATE TABLE in public", "CREATE TABLE public.sabotage (id int)"],
      [
        "CREATE TABLE in extensions",
        "CREATE TABLE extensions.sabotage (id int)",
      ],
      ["CREATE TEMP TABLE", "CREATE TEMP TABLE sabotage (id int)"],
      ["CREATE SCHEMA", "CREATE SCHEMA sabotage"],
      ["ALTER TABLE", `ALTER TABLE ${RLS_PROBE} ADD COLUMN sabotage int`],
      ["DROP TABLE", `DROP TABLE ${RLS_PROBE}`],
      ["TRUNCATE", `TRUNCATE ${RLS_PROBE}`],
      ["CREATE ROLE", "CREATE ROLE sabotage"],
      ["CREATE EXTENSION (trusted citext)", "CREATE EXTENSION citext"],
      [
        "ALTER PUBLICATION",
        `ALTER PUBLICATION powersync ADD TABLE ${RLS_PROBE}`,
      ],
    ] as const) {
      await refused("bricx_app", app, `cannot ${what}`, sql);
    }
    // A real RLS proof: own org's rows only, none without a context.
    expect(
      "bricx_app sees with app.org_id = A",
      await visible(app, RLS_PROBE, ORG_A),
      "A:a1,A:a2",
    );
    expect(
      "bricx_app sees with app.org_id = B",
      await visible(app, RLS_PROBE, ORG_B),
      "B:b1,B:b2,B:b3",
    );
    expect(
      "bricx_app sees without app.org_id",
      await visible(app, RLS_PROBE),
      "",
    );
    await refused(
      "bricx_app",
      app,
      "cannot insert another org's row",
      `INSERT INTO ${RLS_PROBE} (org_id, note) VALUES ('${ORG_B}', 'x')`,
      ORG_A,
    );
    const dml = await attempt(
      app,
      `WITH i AS (INSERT INTO ${RLS_PROBE} (org_id, note) VALUES ('${ORG_A}', 'a3') RETURNING 1),
            u AS (UPDATE ${RLS_PROBE} SET note = note || '!' WHERE note = 'a1' RETURNING 1),
            d AS (DELETE FROM ${RLS_PROBE} WHERE note = 'a2' RETURNING 1)
       SELECT concat((SELECT count(*) FROM i), (SELECT count(*) FROM u), (SELECT count(*) FROM d)) AS n`,
      [],
      ORG_A,
    );
    expect(
      "bricx_app INSERT/UPDATE/DELETE own org rows",
      [dml.code, dml.rows[0]?.["n"]],
      ["ok", "111"],
    );
    // PostGIS and pgcrypto resolve through the pinned search_path (A2 gate).
    const functions = await attempt(
      app,
      `SELECT ST_AsText(ST_SetSRID(ST_MakePoint(-13.2317, 8.4657), 4326)) AS point,
              round(ST_Distance(ST_MakePoint(0, 0)::geography, ST_MakePoint(0, 1)::geography)) AS metres,
              encode(digest('bricx', 'sha256'), 'hex') AS sha256,
              length(gen_random_bytes(16)) AS random_bytes,
              similarity('bricx', 'bricx') AS trigram`,
    );
    expect(
      "bricx_app calls PostGIS, pgcrypto and pg_trgm unqualified",
      [functions.code, functions.rows[0]],
      [
        "ok",
        {
          point: "POINT(-13.2317 8.4657)",
          metres: 110574,
          sha256: createHash("sha256").update("bricx").digest("hex"),
          random_bytes: 16,
          trigram: 1,
        },
      ],
    );
  } finally {
    await app.end();
  }

  // bricx_readonly: reads under RLS, never writes.
  const readonly = await db.connectAs("bricx_readonly");
  try {
    expect(
      "bricx_readonly sees with app.org_id = A",
      await visible(readonly, RLS_PROBE, ORG_A),
      "A:a1,A:a2",
    );
    expect(
      "bricx_readonly sees without app.org_id",
      await visible(readonly, RLS_PROBE),
      "",
    );
    for (const [what, sql] of [
      [
        "INSERT",
        `INSERT INTO ${RLS_PROBE} (org_id, note) VALUES ('${ORG_A}', 'x')`,
      ],
      ["UPDATE", `UPDATE ${RLS_PROBE} SET note = 'x'`],
      ["DELETE", `DELETE FROM ${RLS_PROBE}`],
      ["TRUNCATE", `TRUNCATE ${RLS_PROBE}`],
      ["CREATE TABLE", "CREATE TABLE bricx.sabotage (id int)"],
    ] as const) {
      await refused("bricx_readonly", readonly, `cannot ${what}`, sql, ORG_A);
    }
  } finally {
    await readonly.end();
  }

  // powersync_repl: reads published tables only, across every org
  // (BYPASSRLS: RLS does not protect replication), never writes.
  const repl = await db.connectAs("powersync_repl");
  try {
    if (published.includes(SYNC_PROBE)) {
      expect(
        "powersync_repl sees every org's rows in a published table",
        await visible(repl, SYNC_PROBE),
        "A:a1,A:a2,B:b1,B:b2,B:b3",
      );
    }
    expect(
      "powersync_repl reads an unpublished table",
      await visible(repl, RLS_PROBE),
      DENIED,
    );
    for (const [what, sql] of [
      [
        "INSERT",
        `INSERT INTO ${SYNC_PROBE} (org_id, note) VALUES ('${ORG_A}', 'x')`,
      ],
      ["UPDATE", `UPDATE ${SYNC_PROBE} SET note = 'x'`],
      ["DELETE", `DELETE FROM ${SYNC_PROBE}`],
      ["CREATE TABLE", "CREATE TABLE bricx.sabotage (id int)"],
    ] as const) {
      await refused("powersync_repl", repl, `cannot ${what}`, sql);
    }
  } finally {
    await repl.end();
  }

  return problems;
}
