// P4-02 (ADR 0052): the migrator against compose.yml's Postgres with the
// real init folder. Runs as bricx_owner, keeps its history in
// bricx_migrations, refuses any change to applied history, and leaves the
// powersync publication and powersync_repl's grants alone.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { QueryResultRow } from "pg";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  MIGRATIONS_DIR,
  MigrationError,
  type MigrateResult,
  migrate,
} from "../src/migrate.js";
import { readMigrations } from "../src/journal.js";
import {
  type FixtureMigration,
  journalFor,
  writeMigrations,
} from "./fixture-migrations.js";

const run = promisify(execFile);
const packageDir = path.resolve(import.meta.dirname, "..");

let pg: BootstrappedPostgres;
beforeAll(async () => {
  pg = await startPostgres();
});
afterAll(async () => {
  await pg.container.stop();
});

/** Drops every table the previous test created, as the test superuser. */
beforeEach(async () => {
  const admin = await pg.admin();
  try {
    await admin.query(`DO $$
      DECLARE t record;
      BEGIN
        FOR t IN SELECT schemaname, tablename FROM pg_tables
                 WHERE schemaname IN ('bricx', 'bricx_migrations') LOOP
          EXECUTE format('DROP TABLE %I.%I CASCADE', t.schemaname, t.tablename);
        END LOOP;
      END $$`);
  } finally {
    await admin.end();
  }
});

const urlFor = (role: "bricx_owner" | "bricx_app", password: string) => ({
  reveal: () =>
    `postgres://${role}:${password}@${pg.container.getHost()}:${String(pg.container.getMappedPort(5432))}/${appDatabase}`,
});
const ownerUrl = () =>
  urlFor("bricx_owner", exampleValue("BRICX_OWNER_PASSWORD"));
const appUrl = () => urlFor("bricx_app", exampleValue("BRICX_APP_PASSWORD"));

async function asAdmin<T extends QueryResultRow = QueryResultRow>(
  query: string,
): Promise<T[]> {
  const admin = await pg.admin();
  try {
    return (await admin.query<T>(query)).rows;
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

/** History rows as "idx:tag". */
async function history(): Promise<string[]> {
  const rows = await asAdmin<{ r: string }>(
    "SELECT idx || ':' || tag AS r FROM bricx_migrations.applied ORDER BY idx",
  );
  return rows.map((row) => row.r);
}

/**
 * The bricx schema as the catalog sees it: every relation with its kind,
 * owner and ACL, every column, constraint and index. Two databases built
 * by the same migrations must give the same snapshot.
 */
async function catalog(): Promise<unknown> {
  const relations = await asAdmin(`
    SELECT c.relname, c.relkind::text, c.relowner::regrole::text AS owner,
           c.relacl::text AS acl, c.relrowsecurity, c.relforcerowsecurity
    FROM pg_class c WHERE c.relnamespace = 'bricx'::regnamespace
    ORDER BY c.relname`);
  const columns = await asAdmin(`
    SELECT table_name, column_name, data_type, is_nullable, column_default
    FROM information_schema.columns WHERE table_schema = 'bricx'
    ORDER BY table_name, ordinal_position`);
  const constraints = await asAdmin(`
    SELECT conrelid::regclass::text AS rel, conname, pg_get_constraintdef(oid) AS def
    FROM pg_constraint WHERE connamespace = 'bricx'::regnamespace
    ORDER BY 1, 2`);
  const indexes = await asAdmin(`
    SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'bricx'
    ORDER BY indexname`);
  return { relations, columns, constraints, indexes };
}

const three: FixtureMigration[] = [
  {
    idx: 0,
    tag: "0000_projects",
    statements: [
      `CREATE TABLE "bricx"."projects" (
        "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
        "org_id" uuid NOT NULL,
        "name" text NOT NULL
      );`,
      `CREATE INDEX "projects_org_id_idx" ON "bricx"."projects" ("org_id");`,
    ],
  },
  {
    idx: 1,
    tag: "0001_tasks",
    statements: [
      `CREATE TABLE "bricx"."tasks" (
        "id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
        "org_id" uuid NOT NULL,
        "project_id" uuid NOT NULL
      );`,
      `ALTER TABLE "bricx"."tasks" ADD CONSTRAINT "tasks_project_id_fk"
        FOREIGN KEY ("project_id") REFERENCES "bricx"."projects"("id");`,
      `ALTER TABLE "bricx"."tasks" ENABLE ROW LEVEL SECURITY;`,
      `ALTER TABLE "bricx"."tasks" FORCE ROW LEVEL SECURITY;`,
    ],
  },
  {
    idx: 2,
    tag: "0002_task_title",
    statements: [
      `ALTER TABLE "bricx"."tasks" ADD COLUMN "title" text DEFAULT '' NOT NULL;`,
    ],
  },
];

describe("schema bricx_migrations (D3)", () => {
  // Every role that can log in, memberships included (so a login role
  // granted pg_read_all_data would show); the predefined pg_* roles
  // themselves cannot log in.
  test("is owned by bricx_owner; no other login role has USAGE or CREATE", async () => {
    const rows = await asAdmin<{ owner: string; others: string }>(`
      SELECT nspowner::regrole::text AS owner,
             (SELECT string_agg(r.rolname || ':' || p, ',')
                FROM pg_roles r, unnest(ARRAY['USAGE', 'CREATE']) p
               WHERE r.rolname <> 'bricx_owner' AND NOT r.rolsuper
                 AND r.rolcanlogin
                 AND has_schema_privilege(r.oid, n.oid, p)) AS others
      FROM pg_namespace n WHERE nspname = 'bricx_migrations'`);
    expect(rows).toEqual([{ owner: "bricx_owner", others: null }]);
  });
});

describe("migrate() as bricx_owner", () => {
  test("applies a 3-migration fixture to an empty database, then nothing", async () => {
    const dir = await writeMigrations(three);
    const first = await migrate(ownerUrl(), dir);
    expect(first).toEqual<MigrateResult>({
      applied: ["0000_projects", "0001_tasks", "0002_task_title"],
      alreadyApplied: 0,
    });
    expect(await history()).toEqual([
      "0:0000_projects",
      "1:0001_tasks",
      "2:0002_task_title",
    ]);
    const owners = await asAdmin<{ owner: string; n: string }>(`
      SELECT relowner::regrole::text AS owner, count(*)::text AS n FROM pg_class
      WHERE relnamespace IN ('bricx'::regnamespace, 'bricx_migrations'::regnamespace)
      GROUP BY 1`);
    expect(owners.map((o) => o.owner)).toEqual(["bricx_owner"]);
    const hashes = await asAdmin<{ sha256: string; ok: boolean }>(
      "SELECT sha256, applied_at <= now() AS ok FROM bricx_migrations.applied ORDER BY idx",
    );
    for (const [i, m] of three.entries()) {
      const bytes = await readFile(path.join(dir, `${m.tag}.sql`));
      expect(hashes[i]).toEqual({
        sha256: createHash("sha256").update(bytes).digest("hex"),
        ok: true,
      });
    }

    const second = await migrate(ownerUrl(), dir);
    expect(second).toEqual<MigrateResult>({ applied: [], alreadyApplied: 3 });
    expect(await history()).toHaveLength(3);
  });

  test("each prefix in order gives the same catalog as all at once (D8)", async () => {
    await migrate(ownerUrl(), await writeMigrations(three));
    const allAtOnce = await catalog();
    const historyAll = await history();

    const admin = await pg.admin();
    try {
      await admin.query(
        "DROP TABLE bricx.tasks, bricx.projects, bricx_migrations.applied",
      );
    } finally {
      await admin.end();
    }
    for (let n = 1; n <= three.length; n += 1) {
      const result = await migrate(
        ownerUrl(),
        await writeMigrations(three.slice(0, n)),
      );
      expect(result.applied).toEqual([three[n - 1]?.tag]);
    }
    expect(await catalog()).toEqual(allAtOnce);
    expect(await history()).toEqual(historyAll);
  });

  test("the history is unreadable to bricx_app", async () => {
    await migrate(ownerUrl(), await writeMigrations(three));
    const app = await pg.connectAs("bricx_app");
    try {
      await expect(
        app.query("SELECT * FROM bricx_migrations.applied"),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await app.end();
    }
  });

  test("leaves the powersync publication empty and powersync_repl without grants", async () => {
    await migrate(ownerUrl(), await writeMigrations(three));
    const published = await asAdmin<{ n: string }>(
      "SELECT count(*)::text AS n FROM pg_publication_tables WHERE pubname = 'powersync'",
    );
    expect(published).toEqual([{ n: "0" }]);
    const grants = await asAdmin<{ n: string }>(
      "SELECT count(*)::text AS n FROM information_schema.role_table_grants WHERE grantee = 'powersync_repl'",
    );
    expect(grants).toEqual([{ n: "0" }]);
  });
});

describe("migrate() refuses to rewrite history", () => {
  test("an edited applied migration (applied_migration_changed)", async () => {
    const dir = await writeMigrations(three.slice(0, 2));
    await migrate(ownerUrl(), dir);
    await writeFile(
      path.join(dir, "0001_tasks.sql"),
      `${await readFile(path.join(dir, "0001_tasks.sql"), "utf8")}\n-- edited`,
    );
    const error = await errorOf(() => migrate(ownerUrl(), dir));
    expect(error).toMatchObject({
      code: "applied_migration_changed",
      tag: "0001_tasks",
    });
  });

  test("an edit is refused before any pending migration runs", async () => {
    const dir = await writeMigrations(three.slice(0, 2));
    await migrate(ownerUrl(), dir);
    const edited = await writeMigrations([
      {
        ...(three[0] ?? { idx: 0, tag: "x", statements: [] }),
        statements: ["SELECT 1;"],
      },
      ...three.slice(1),
    ]);
    expect((await errorOf(() => migrate(ownerUrl(), edited))).code).toBe(
      "applied_migration_changed",
    );
    expect(await history()).toEqual(["0:0000_projects", "1:0001_tasks"]);
  });

  test("a removed applied migration (applied_migration_removed)", async () => {
    await migrate(ownerUrl(), await writeMigrations(three.slice(0, 2)));
    const error = await errorOf(async () =>
      migrate(ownerUrl(), await writeMigrations(three.slice(0, 1))),
    );
    expect(error).toMatchObject({
      code: "applied_migration_removed",
      tag: "0001_tasks",
    });
  });

  test("a reordered applied migration (applied_migration_reordered)", async () => {
    const a = { idx: 0, tag: "0000_a", statements: ["SELECT 1;"] };
    const b = { idx: 1, tag: "0001_b", statements: ["SELECT 2;"] };
    await migrate(ownerUrl(), await writeMigrations([a, b]));
    const swapped = await writeMigrations([
      { ...b, idx: 0 },
      { ...a, idx: 1 },
    ]);
    const error = await errorOf(() => migrate(ownerUrl(), swapped));
    expect(error).toMatchObject({
      code: "applied_migration_reordered",
      tag: "0000_a",
    });
    expect(await history()).toEqual(["0:0000_a", "1:0001_b"]);
  });

  test("a new migration below the highest applied idx (gap_fill)", async () => {
    const a = { idx: 0, tag: "0000_a", statements: ["SELECT 1;"] };
    const b = {
      idx: 1,
      tag: "0001_b",
      statements: ['CREATE TABLE "bricx"."gap" ("id" int);'],
    };
    const c = { idx: 2, tag: "0002_c", statements: ["SELECT 3;"] };
    await migrate(ownerUrl(), await writeMigrations([a, c]));
    expect(await history()).toEqual(["0:0000_a", "2:0002_c"]);
    const error = await errorOf(async () =>
      migrate(ownerUrl(), await writeMigrations([a, b, c])),
    );
    expect(error).toMatchObject({ code: "gap_fill", tag: "0001_b" });
    expect(await history()).toEqual(["0:0000_a", "2:0002_c"]);
    expect(
      await asAdmin("SELECT 1 FROM pg_tables WHERE tablename = 'gap'"),
    ).toEqual([]);
  });
});

describe("migrate() failures", () => {
  test("a failing migration leaves no table and no history row", async () => {
    const failing: FixtureMigration[] = [
      three[0] ?? { idx: 0, tag: "x", statements: [] },
      {
        idx: 1,
        tag: "0001_broken",
        statements: [
          'CREATE TABLE "bricx"."half" ("id" int);',
          'ALTER TABLE "bricx"."missing" ADD COLUMN "x" int;',
        ],
      },
    ];
    const error = await errorOf(async () =>
      migrate(ownerUrl(), await writeMigrations(failing)),
    );
    expect(error).toMatchObject({
      code: "migration_failed",
      tag: "0001_broken",
      statement: 2,
      sqlState: "42P01",
    });
    expect(error.serverMessage).toContain("missing");
    expect(await history()).toEqual(["0:0000_projects"]);
    expect(
      await asAdmin("SELECT 1 FROM pg_tables WHERE tablename = 'half'"),
    ).toEqual([]);
  });

  test("two concurrent migrators: one applies, the other finds nothing to do", async () => {
    const slow: FixtureMigration[] = [
      {
        idx: 0,
        tag: "0000_slow",
        statements: [
          "SELECT pg_sleep(1);",
          'CREATE TABLE "bricx"."once" ("id" int);',
        ],
      },
      {
        idx: 1,
        tag: "0001_more",
        statements: ['CREATE TABLE "bricx"."twice" ("id" int);'],
      },
    ];
    const dir = await writeMigrations(slow);
    const results = await Promise.all([
      migrate(ownerUrl(), dir),
      migrate(ownerUrl(), dir),
    ]);
    const applied = results.map((r) => r.applied.length).sort();
    expect(applied).toEqual([0, 2]);
    expect(results.map((r) => r.alreadyApplied).sort()).toEqual([0, 2]);
    expect(await history()).toEqual(["0:0000_slow", "1:0001_more"]);
  });

  test("the bricx_app URL is refused before anything runs (wrong_role)", async () => {
    const error = await errorOf(async () =>
      migrate(appUrl(), await writeMigrations(three)),
    );
    expect(error.code).toBe("wrong_role");
    expect(error.message).not.toContain(exampleValue("BRICX_APP_PASSWORD"));
    expect(
      await asAdmin(
        "SELECT 1 FROM pg_tables WHERE schemaname IN ('bricx', 'bricx_migrations')",
      ),
    ).toEqual([]);
  });

  test("an unreachable database is database_unavailable, with no detail", async () => {
    const error = await errorOf(async () =>
      migrate(
        {
          reveal: () =>
            ownerUrl()
              .reveal()
              .replace(
                exampleValue("BRICX_OWNER_PASSWORD"),
                "wrong-password-77",
              ),
        },
        await writeMigrations(three),
      ),
    );
    expect(error.code).toBe("database_unavailable");
    expect(error.message).toBe("migration refused: database_unavailable");
    expect(error.cause).toBeUndefined();
  });
});

describe("the real migrations folder (D8, D15)", () => {
  test("applies from empty, again as a no-op, and through each prefix", async () => {
    const entries = await readMigrations(MIGRATIONS_DIR);
    const first = await migrate(ownerUrl(), MIGRATIONS_DIR);
    expect(first.applied).toEqual(entries.map((e) => e.tag));
    const full = await catalog();
    expect(await migrate(ownerUrl(), MIGRATIONS_DIR)).toEqual<MigrateResult>({
      applied: [],
      alreadyApplied: entries.length,
    });
    await asAdmin(`DO $$
      DECLARE t record;
      BEGIN
        FOR t IN SELECT schemaname, tablename FROM pg_tables
                 WHERE schemaname IN ('bricx', 'bricx_migrations') LOOP
          EXECUTE format('DROP TABLE %I.%I CASCADE', t.schemaname, t.tablename);
        END LOOP;
      END $$`);
    const files = await readdir(MIGRATIONS_DIR);
    for (let n = 0; n <= entries.length; n += 1) {
      const prefix = entries.slice(0, n);
      const dir = await mkdtemp(path.join(os.tmpdir(), "bricx-prefix-"));
      await mkdir(path.join(dir, "meta"));
      await writeFile(
        path.join(dir, "meta/_journal.json"),
        JSON.stringify(journalFor(prefix)),
      );
      for (const e of prefix) {
        expect(files).toContain(`${e.tag}.sql`);
        await writeFile(
          path.join(dir, `${e.tag}.sql`),
          await readFile(path.join(MIGRATIONS_DIR, `${e.tag}.sql`)),
        );
      }
      await migrate(ownerUrl(), dir);
    }
    expect(await catalog()).toEqual(full);
  });
});

describe("drizzle-kit generate output (P4-02 change 1)", () => {
  test("a schema built from the column helpers generates, migrates and matches the catalog", async () => {
    const work = await mkdtemp(path.join(os.tmpdir(), "bricx-drizzle-kit-"));
    await symlink(
      path.join(packageDir, "node_modules"),
      path.join(work, "node_modules"),
    );
    await writeFile(path.join(work, "package.json"), '{ "type": "module" }\n');
    const helpers = path.join(packageDir, "src/schema");
    await writeFile(
      path.join(work, "schema.ts"),
      `import { text, uuid } from "drizzle-orm/pg-core";
import { createdAt, createdBy, deletedAt, id, orgId, updatedAt, version } from ${JSON.stringify(path.join(helpers, "columns.js"))};
import { bricx } from ${JSON.stringify(path.join(helpers, "namespace.js"))};
export const sites = bricx.table("sites", {
  id: id(), orgId: orgId(), name: text().notNull(),
  createdAt: createdAt(), updatedAt: updatedAt(), createdBy: createdBy(),
  version: version(), deletedAt: deletedAt(),
});
export const zones = bricx.table("zones", {
  id: id(), orgId: orgId(),
  siteId: uuid("site_id").notNull().references(() => sites.id),
});
`,
    );
    await writeFile(
      path.join(work, "drizzle.config.ts"),
      `import { defineConfig } from "drizzle-kit";
export default defineConfig({ dialect: "postgresql", schema: "./schema.ts", out: "./out", schemaFilter: ["bricx"], strict: true });
`,
    );
    const drizzleKit = path.join(
      packageDir,
      "node_modules/drizzle-kit/bin.cjs",
    );
    const generate = (name: string) =>
      run(process.execPath, [drizzleKit, "generate", "--name", name], {
        cwd: work,
        encoding: "utf8",
      });
    await generate("sites_zones");
    // v2: a new column, as a second migration.
    await writeFile(
      path.join(work, "schema.ts"),
      (await readFile(path.join(work, "schema.ts"), "utf8")).replace(
        "name: text().notNull(),",
        "name: text().notNull(), code: text(),",
      ),
    );
    await generate("site_code");

    const out = path.join(work, "out");
    const sqlFiles = (await readdir(out))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    // drizzle-kit exits 0 even when it writes nothing, so check the files.
    expect(sqlFiles).toEqual(["0000_sites_zones.sql", "0001_site_code.sql"]);
    const firstSql = await readFile(path.join(out, sqlFiles[0] ?? ""), "utf8");
    expect(firstSql).toContain("--> statement-breakpoint");
    expect(firstSql).not.toMatch(/CREATE SCHEMA/i);

    const result = await migrate(ownerUrl(), out);
    expect(result.applied).toEqual(["0000_sites_zones", "0001_site_code"]);

    const columns = await asAdmin<{ c: string }>(`
      SELECT table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable
             || coalesce(' = ' || column_default, '') AS c
      FROM information_schema.columns WHERE table_schema = 'bricx'
      ORDER BY table_name, ordinal_position`);
    expect(columns.map((c) => c.c)).toEqual([
      "sites.id uuid NO = uuidv7()",
      "sites.org_id uuid NO",
      "sites.name text NO",
      "sites.created_at timestamp with time zone NO = now()",
      "sites.updated_at timestamp with time zone NO = now()",
      "sites.created_by uuid NO",
      "sites.version integer NO = 1",
      "sites.deleted_at timestamp with time zone YES",
      "sites.code text YES",
      "zones.id uuid NO = uuidv7()",
      "zones.org_id uuid NO",
      "zones.site_id uuid NO",
    ]);
    const fks = await asAdmin<{ def: string }>(`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conrelid = 'bricx.zones'::regclass AND contype = 'f'`);
    expect(fks).toHaveLength(1);
    expect(fks[0]?.def).toMatch(
      /^FOREIGN KEY \(site_id\) REFERENCES (?:bricx\.)?sites\(id\)/,
    );
    const owners = await asAdmin<{ o: string }>(`
      SELECT DISTINCT relowner::regrole::text AS o FROM pg_class
      WHERE relnamespace = 'bricx'::regnamespace`);
    expect(owners).toEqual([{ o: "bricx_owner" }]);
    // The id default really is a UUIDv7.
    const inserted = await asAdmin<{ v: number }>(`
      INSERT INTO bricx.sites (org_id, name, created_by)
      VALUES (uuidv7(), 'Freetown yard', uuidv7())
      RETURNING uuid_extract_version(id) AS v`);
    expect(inserted).toEqual([{ v: 7 }]);
  });
});
