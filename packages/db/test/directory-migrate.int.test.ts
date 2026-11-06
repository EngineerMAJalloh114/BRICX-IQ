// P6-01 (ADR 0071; owner conditions C1 and C3): the directory migrations
// against compose.yml's Postgres with the REAL init folder (01-bootstrap.sh
// and 02-directory.sh). The directory migrator runs only as directory_owner
// and keeps its history in directory_migrations; the cell migrator refuses
// directory_owner and the directory migrator refuses bricx_owner. After the
// real journal, each role's privileges are exactly its row in ADR 0071:
// directory_reader SELECT only, directory_writer INSERT on org_directory
// plus the SELECT its conflict check needs and nothing on
// org_email_domains or cells; an organisation's cell never changes (every
// role, the owner included); a domain row needs verified_at.
import {
  type BootstrappedPostgres,
  appDatabase,
  directoryDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import type pg from "pg";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  DIRECTORY_MIGRATIONS_DIR,
  MIGRATIONS_DIR,
  MigrationError,
  migrate,
  migrateDirectory,
} from "../src/migrate.js";
import { writeMigrations } from "./fixture-migrations.js";

let pg18: BootstrappedPostgres;
beforeAll(async () => {
  pg18 = await startPostgres();
});
afterAll(async () => {
  await pg18.container.stop();
});

type Who = "directory_owner" | "directory_reader" | "directory_writer";
const passwordKey: Record<Who | "bricx_owner", string> = {
  directory_owner: "DIRECTORY_OWNER_PASSWORD",
  directory_reader: "DIRECTORY_READER_PASSWORD",
  directory_writer: "DIRECTORY_WRITER_PASSWORD",
  bricx_owner: "BRICX_OWNER_PASSWORD",
};
const urlFor = (role: Who | "bricx_owner", database: string) => ({
  reveal: () =>
    `postgres://${role}:${exampleValue(passwordKey[role])}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${database}`,
});
const directoryOwnerUrl = () => urlFor("directory_owner", directoryDatabase);

/** Drops everything a directory migration made, as the superuser. */
const DROP_ALL = `DO $$
  DECLARE t record;
  BEGIN
    FOR t IN SELECT schemaname, tablename FROM pg_tables
             WHERE schemaname IN ('directory', 'directory_migrations') LOOP
      EXECUTE format('DROP TABLE %I.%I CASCADE', t.schemaname, t.tablename);
    END LOOP;
    FOR t IN SELECT p.oid::regprocedure AS sig FROM pg_proc p
             WHERE p.pronamespace = to_regnamespace('directory') LOOP
      EXECUTE format('DROP FUNCTION %s CASCADE', t.sig);
    END LOOP;
  END $$`;

async function asAdmin<T extends pg.QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const admin = await pg18.admin(directoryDatabase);
  try {
    return (await admin.query<T>(sql, params)).rows;
  } finally {
    await admin.end();
  }
}

async function errorOf(run: () => Promise<unknown>): Promise<MigrationError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof MigrationError) return error;
    throw error;
  }
  throw new Error("expected a MigrationError");
}

/** The SQLSTATE `sql` ends with as `who` ("ok" on success), rolled back. */
async function outcome(who: Who, sql: string): Promise<string> {
  const client = await pg18.connectAs(who, directoryDatabase);
  try {
    await client.query("BEGIN");
    try {
      await client.query(sql);
      return "ok";
    } catch (error) {
      return (error as { code?: string }).code ?? "error";
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}

const ORG_A = "0192d4a0-0000-7000-8000-0000000000a1";
const ORG_B = "0192d4a0-0000-7000-8000-0000000000b1";

/** Two cells, one organisation, one verified domain, written as the owner (C3). */
async function seedAsOwner(): Promise<void> {
  const owner = await pg18.connectAs("directory_owner", directoryDatabase);
  try {
    await owner.query(`INSERT INTO directory.cells (id, api_base_url, keycloak_url) VALUES
      ('af-south-1', 'https://api.af-south-1.bricx.invalid', 'https://id.af-south-1.bricx.invalid/realms/bricx'),
      ('eu-west-1', 'https://api.eu-west-1.bricx.invalid', 'https://id.eu-west-1.bricx.invalid/realms/bricx')`);
    await owner.query(
      "INSERT INTO directory.org_directory (org_id, org_slug, cell_id) VALUES ($1, 'acme', 'af-south-1')",
      [ORG_A],
    );
    await owner.query(
      "INSERT INTO directory.org_email_domains (domain, org_id, verified_at) VALUES ('acme.example', $1, now())",
      [ORG_A],
    );
  } finally {
    await owner.end();
  }
}

beforeEach(async () => {
  await asAdmin(DROP_ALL);
});

describe("the directory migrator (P6-01, ADR 0071)", () => {
  test("applies the real journal as directory_owner, once; history in directory_migrations", async () => {
    const first = await migrateDirectory(directoryOwnerUrl());
    expect(first).toEqual({ applied: ["0000_directory"], alreadyApplied: 0 });
    const again = await migrateDirectory(directoryOwnerUrl());
    expect(again).toEqual({ applied: [], alreadyApplied: 1 });
    expect(
      await asAdmin<{ r: string }>(
        "SELECT idx || ':' || tag AS r FROM directory_migrations.applied ORDER BY idx",
      ),
    ).toEqual([{ r: "0:0000_directory" }]);
    expect(
      await asAdmin<{ t: string }>(
        "SELECT tablename AS t FROM pg_tables WHERE schemaname = 'directory' ORDER BY 1",
      ),
    ).toEqual([
      { t: "cells" },
      { t: "org_directory" },
      { t: "org_email_domains" },
    ]);
  });

  test("refuses bricx_owner, on either database (wrong_role), before anything runs", async () => {
    for (const database of [directoryDatabase, appDatabase]) {
      const error = await errorOf(() =>
        migrateDirectory(urlFor("bricx_owner", database)),
      );
      expect(error.code).toBe(
        database === appDatabase ? "wrong_role" : "database_unavailable",
      );
    }
    expect(
      await asAdmin("SELECT 1 FROM pg_tables WHERE schemaname = 'directory'"),
    ).toEqual([]);
  });

  test("the cell migrator refuses directory_owner (wrong_role)", async () => {
    const error = await errorOf(() =>
      migrate(directoryOwnerUrl(), MIGRATIONS_DIR),
    );
    expect(error.code).toBe("wrong_role");
    expect(error.message).not.toContain(
      exampleValue("DIRECTORY_OWNER_PASSWORD"),
    );
    expect(
      await asAdmin("SELECT 1 FROM pg_tables WHERE schemaname = 'directory'"),
    ).toEqual([]);
  });

  test("sabotage: the cell journal run as directory_owner by the directory migrator is refused, not applied", async () => {
    // The directory migrator accepts directory_owner, so nothing but the
    // database itself stands between it and a wrong folder: the cell's
    // first migration creates functions in schema app, which does not
    // exist in bricx_directory, so it fails and leaves no history row.
    const error = await errorOf(() =>
      migrateDirectory(directoryOwnerUrl(), MIGRATIONS_DIR),
    );
    expect(error.code).toBe("migration_failed");
    expect(await asAdmin("SELECT 1 FROM directory_migrations.applied")).toEqual(
      [],
    );
  });

  test("refuses a directory table without ENABLE + FORCE ROW LEVEL SECURITY (rolled back)", async () => {
    const folder = await writeMigrations([
      {
        idx: 0,
        tag: "0000_bad",
        statements: ["CREATE TABLE directory.bad (id int PRIMARY KEY)"],
      },
    ]);
    const error = await errorOf(() =>
      migrateDirectory(directoryOwnerUrl(), folder),
    );
    expect(error).toMatchObject({
      code: "tenant_rls_missing",
      relation: "directory.bad",
    });
    expect(
      await asAdmin("SELECT 1 FROM pg_tables WHERE tablename = 'bad'"),
    ).toEqual([]);
  });

  test("refuses a SECURITY DEFINER function in the directory (rolled back)", async () => {
    const folder = await writeMigrations([
      {
        idx: 0,
        tag: "0000_definer",
        statements: [
          "CREATE FUNCTION directory.f() RETURNS int LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog, pg_temp BEGIN ATOMIC SELECT 1; END",
        ],
      },
    ]);
    const error = await errorOf(() =>
      migrateDirectory(directoryOwnerUrl(), folder),
    );
    expect(error).toMatchObject({
      code: "definer_forbidden",
      relation: "directory.f()",
    });
  });

  test("refuses a table privilege for PUBLIC (rolled back)", async () => {
    const folder = await writeMigrations([
      {
        idx: 0,
        tag: "0000_public",
        statements: [
          "CREATE TABLE directory.open (id int PRIMARY KEY)",
          "ALTER TABLE directory.open ENABLE ROW LEVEL SECURITY",
          "ALTER TABLE directory.open FORCE ROW LEVEL SECURITY",
          "GRANT SELECT ON directory.open TO PUBLIC",
        ],
      },
    ]);
    const error = await errorOf(() =>
      migrateDirectory(directoryOwnerUrl(), folder),
    );
    expect(error).toMatchObject({
      code: "public_table_privilege",
      relation: "directory.open",
    });
  });
});

describe("directory privileges after the real journal (C1, C3)", () => {
  beforeEach(async () => {
    await migrateDirectory(directoryOwnerUrl());
    await seedAsOwner();
  });

  test("every directory table has ENABLE + FORCE RLS and no grant to PUBLIC", async () => {
    const rows = await asAdmin<{
      t: string;
      rls: boolean;
      force: boolean;
      acl: string;
    }>(
      `SELECT c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS force,
              coalesce(c.relacl::text, '') AS acl
       FROM pg_class c WHERE c.relnamespace = 'directory'::regnamespace AND c.relkind = 'r'
       ORDER BY 1`,
    );
    expect(rows.map((r) => [r.t, r.rls, r.force])).toEqual([
      ["cells", true, true],
      ["org_directory", true, true],
      ["org_email_domains", true, true],
    ]);
    for (const row of rows) expect(row.acl).not.toMatch(/(^|[{,])=/);
  });

  test("the privilege matrix is exactly ADR 0071's", async () => {
    const rows = await asAdmin<{ r: string }>(
      `SELECT grantee || ' ' || table_name || ' ' || string_agg(privilege_type, ',' ORDER BY privilege_type) AS r
       FROM information_schema.role_table_grants
       WHERE table_schema = 'directory' AND grantee IN ('directory_reader', 'directory_writer')
       GROUP BY grantee, table_name ORDER BY 1`,
    );
    expect(rows.map((r) => r.r)).toEqual([
      "directory_reader cells SELECT",
      "directory_reader org_directory SELECT",
      "directory_reader org_email_domains SELECT",
      "directory_writer org_directory INSERT,SELECT",
    ]);
  });

  test("directory_reader reads every table and writes none", async () => {
    for (const table of ["cells", "org_directory", "org_email_domains"]) {
      expect(
        await outcome("directory_reader", `SELECT * FROM directory.${table}`),
      ).toBe("ok");
    }
    const reader = await pg18.connectAs("directory_reader", directoryDatabase);
    try {
      const { rows } = await reader.query<{ n: string }>(
        "SELECT (SELECT count(*) FROM directory.cells) || '/' || (SELECT count(*) FROM directory.org_directory) || '/' || (SELECT count(*) FROM directory.org_email_domains) AS n",
      );
      expect(rows[0]?.n).toBe("2/1/1");
    } finally {
      await reader.end();
    }
    for (const sql of [
      `INSERT INTO directory.org_directory (org_id, org_slug, cell_id) VALUES ('${ORG_B}', 'beta', 'eu-west-1')`,
      "UPDATE directory.org_directory SET org_slug = 'x'",
      "DELETE FROM directory.org_directory",
      `INSERT INTO directory.org_email_domains (domain, org_id, verified_at) VALUES ('beta.example', '${ORG_A}', now())`,
      "DELETE FROM directory.org_email_domains",
      "INSERT INTO directory.cells (id, api_base_url, keycloak_url) VALUES ('us-east-1', 'https://a.invalid', 'https://b.invalid/realms/bricx')",
      "UPDATE directory.cells SET api_base_url = 'https://evil.invalid'",
      "TRUNCATE directory.org_directory",
    ]) {
      expect([sql, await outcome("directory_reader", sql)]).toEqual([
        sql,
        "42501",
      ]);
    }
  });

  test("directory_writer inserts and reads org_directory only; never org_email_domains or cells (C3)", async () => {
    expect(
      await outcome(
        "directory_writer",
        `INSERT INTO directory.org_directory (org_id, org_slug, cell_id) VALUES ('${ORG_B}', 'beta', 'eu-west-1')`,
      ),
    ).toBe("ok");
    expect(
      await outcome(
        "directory_writer",
        "SELECT org_id, org_slug, cell_id FROM directory.org_directory",
      ),
    ).toBe("ok");
    for (const sql of [
      "UPDATE directory.org_directory SET org_slug = 'x'",
      "DELETE FROM directory.org_directory",
      "TRUNCATE directory.org_directory",
      `INSERT INTO directory.org_email_domains (domain, org_id, verified_at) VALUES ('beta.example', '${ORG_A}', now())`,
      "SELECT * FROM directory.org_email_domains",
      "UPDATE directory.org_email_domains SET verified_at = now()",
      "DELETE FROM directory.org_email_domains",
      "SELECT * FROM directory.cells",
      "INSERT INTO directory.cells (id, api_base_url, keycloak_url) VALUES ('us-east-1', 'https://a.invalid', 'https://b.invalid/realms/bricx')",
      "UPDATE directory.cells SET api_base_url = 'https://evil.invalid'",
    ]) {
      expect([sql, await outcome("directory_writer", sql)]).toEqual([
        sql,
        "42501",
      ]);
    }
  });

  test("an organisation's cell and id never change, even as directory_owner (ADR 0020)", async () => {
    for (const sql of [
      "UPDATE directory.org_directory SET cell_id = 'eu-west-1'",
      `UPDATE directory.org_directory SET org_id = '${ORG_B}'`,
    ]) {
      expect([sql, await outcome("directory_owner", sql)]).toEqual([
        sql,
        "P6001",
      ]);
    }
    // The superuser bypasses RLS, but not the trigger.
    const admin = await pg18.admin(directoryDatabase);
    try {
      await expect(
        admin.query("UPDATE directory.org_directory SET cell_id = 'eu-west-1'"),
      ).rejects.toMatchObject({ code: "P6001" });
    } finally {
      await admin.end();
    }
  });

  test("a domain row needs verified_at (NOT NULL, C3)", async () => {
    expect(
      await outcome(
        "directory_owner",
        `INSERT INTO directory.org_email_domains (domain, org_id, verified_at) VALUES ('beta.example', '${ORG_A}', NULL)`,
      ),
    ).toBe("23502");
    expect(
      await outcome(
        "directory_owner",
        `INSERT INTO directory.org_email_domains (domain, org_id) VALUES ('beta.example', '${ORG_A}')`,
      ),
    ).toBe("23502");
  });

  test("CHECKs refuse a malformed cell id, slug, URL or domain", async () => {
    for (const sql of [
      "INSERT INTO directory.cells (id, api_base_url, keycloak_url) VALUES ('Mars', 'https://a.invalid', 'https://b.invalid/realms/bricx')",
      "INSERT INTO directory.cells (id, api_base_url, keycloak_url) VALUES ('us-east-1', 'https://a.invalid/path', 'https://b.invalid/realms/bricx')",
      "INSERT INTO directory.cells (id, api_base_url, keycloak_url) VALUES ('us-east-1', 'https://user:pw@a.invalid', 'https://b.invalid/realms/bricx')",
      "INSERT INTO directory.cells (id, api_base_url, keycloak_url) VALUES ('us-east-1', 'ftp://a.invalid', 'https://b.invalid/realms/bricx')",
      "INSERT INTO directory.cells (id, api_base_url, keycloak_url) VALUES ('us-east-1', 'https://a.invalid', 'https://b.invalid/realms/bricx?x=1')",
      `INSERT INTO directory.org_directory (org_id, org_slug, cell_id) VALUES ('${ORG_B}', 'Beta', 'eu-west-1')`,
      `INSERT INTO directory.org_directory (org_id, org_slug, cell_id) VALUES ('${ORG_B}', '-beta', 'eu-west-1')`,
      `INSERT INTO directory.org_directory (org_id, org_slug, cell_id) VALUES ('${ORG_B}', 'ab', 'eu-west-1')`,
      `INSERT INTO directory.org_directory (org_id, org_slug, cell_id) VALUES ('${ORG_B}', '${"a".repeat(64)}', 'eu-west-1')`,
      `INSERT INTO directory.org_email_domains (domain, org_id, verified_at) VALUES ('Acme.Example', '${ORG_A}', now())`,
      `INSERT INTO directory.org_email_domains (domain, org_id, verified_at) VALUES ('localhost', '${ORG_A}', now())`,
      `INSERT INTO directory.org_email_domains (domain, org_id, verified_at) VALUES ('acme.example.', '${ORG_A}', now())`,
      `INSERT INTO directory.org_email_domains (domain, org_id, verified_at) VALUES ('${"a".repeat(250)}.com', '${ORG_A}', now())`,
    ]) {
      expect([sql, await outcome("directory_owner", sql)]).toEqual([
        sql,
        "23514",
      ]);
    }
  });
});

describe("the directory migrations folder", () => {
  test("is its own folder, next to the cell's", () => {
    expect(DIRECTORY_MIGRATIONS_DIR).not.toBe(MIGRATIONS_DIR);
    expect(DIRECTORY_MIGRATIONS_DIR.endsWith("directory-migrations")).toBe(
      true,
    );
  });
});
