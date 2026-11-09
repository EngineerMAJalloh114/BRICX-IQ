// `pnpm db:seed` (P6-05b, ADR 0076) against Postgres with the production
// journal, applied by the real migrator as bricx_owner. Binding decisions
// C1, D, E1, H1, I1 and J1:
// - the first run writes every dataset row; the second writes none and
//   finds no drift (idempotent);
// - the seed runs as bricx_app through withTx(), so FORCE RLS holds: one
//   seeded organisation never sees the other's rows; a handle that is not
//   bricx_app is refused before anything is written;
// - a stored row that differs from the dataset (an owner edit between
//   runs) stops the run naming table and id only, and the row is left as
//   it is (never overwritten);
// - the CLI (tsx seed/run.ts, the `pnpm db:seed` command) prints the same
//   summary (row counts per table, nothing else) on every run (condition
//   5), refuses production and a non-bricx_app user without echoing a
//   value, and fails clearly when the env file is missing (condition 6);
// - every created_at/updated_at is the seed instant, from the fixed Clock
//   (condition 2); org B (eu-west-1) is written although the dev API's
//   cell (.env.example CELL_ID) is af-south-1: both orgs carry a dev cell
//   of db:migrate's directory step (DEV_CELLS; condition 6).
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv, promisify } from "node:util";
import {
  type BootstrappedPostgres,
  type Role,
  appDatabase,
  exampleValue,
  repoRoot,
  rolePasswordKeys,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { PgDialect } from "drizzle-orm/pg-core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildDataset } from "../seed/dataset.js";
import { deriveSeedId } from "../seed/derive.js";
import { seedId } from "../seed/ids.js";
import { SeedDriftError, SeedRoleError, runSeed } from "../seed/seed.js";
import { type Database, openDatabase } from "../src/database.js";
import { DEV_CELLS } from "../src/dev-cells.js";
import { migrate } from "../src/migrate.js";
import { contextStatement, validateTxContext } from "../src/tx.js";

const run = promisify(execFile);
const dialect = new PgDialect();
const dataset = buildDataset(seedId);
const [orgA, orgB] = dataset.orgs;
if (orgA === undefined || orgB === undefined) throw new Error("two orgs");

let pg18: BootstrappedPostgres;
let app: Database;

const urlFor = (role: Role) =>
  `postgres://${role}:${exampleValue(rolePasswordKeys[role])}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;
const secretFor = (role: Role) => ({ reveal: () => urlFor(role) });

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

/** Rows each table should hold after a seed (both organisations). */
const expectedCounts = {
  organizations: 2,
  users: dataset.orgs.reduce((n, o) => n + o.users.length, 0),
  region_configs: 4,
  roles: dataset.orgs.reduce((n, o) => n + o.roles.length, 0),
  role_permissions: dataset.orgs.reduce(
    (n, o) => n + o.roles.reduce((m, r) => m + r.permissions.length, 0),
    0,
  ),
  memberships: dataset.orgs.reduce((n, o) => n + o.users.length, 0),
  projects: 2,
  sites: 4,
  project_memberships: dataset.orgs.reduce(
    (n, o) => n + o.projectMembers.length,
    0,
  ),
  project_membership_sites: dataset.orgs.reduce(
    (n, o) => n + o.siteAssignments.length,
    0,
  ),
} as const;
const totalRows = Object.values(expectedCounts).reduce((n, c) => n + c, 0);
/** What the CLI prints on every successful run (condition 5). */
const summary = `seed: ${Object.entries(expectedCounts)
  .map(([table, n]) => `${table} ${String(n)}`)
  .join(", ")}; no drift\n`;

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of Object.keys(expectedCounts)) {
    const [row] = await asAdmin<{ n: string }>(
      `SELECT count(*)::text AS n FROM bricx.${table}`,
    );
    out[table] = Number(row?.n ?? "-1");
  }
  return out;
}

/** Counts of `table` that bricx_app sees in `orgId`'s context. */
async function visible(
  orgId: string,
  userId: string,
  projectIds: string[],
  table: string,
): Promise<number> {
  const client = await pg18.connectAs("bricx_app");
  try {
    await client.query("BEGIN");
    const q = dialect.sqlToQuery(
      contextStatement(
        validateTxContext({ orgId, userId, projectIds }),
        30_000,
      ),
    );
    await client.query(q.sql, q.params);
    const r = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM bricx.${table}`,
    );
    await client.query("ROLLBACK");
    return Number(r.rows[0]?.n ?? "-1");
  } finally {
    await client.end();
  }
}

const tsxCli = path.join(repoRoot, "node_modules/tsx/dist/cli.mjs");
const runScript = path.join(repoRoot, "packages/db/seed/run.ts");

/** Runs the seed CLI with `env`; exit code, stdout and stderr. */
async function cli(
  env: Record<string, string>,
  flags: readonly string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      [tsxCli, ...flags, runScript],
      {
        cwd: repoRoot,
        env: { PATH: process.env["PATH"] ?? "", ...env },
        timeout: 120_000,
      },
    );
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: unknown; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : -1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(secretFor("bricx_owner"));
  app = openDatabase(secretFor("bricx_app"));
}, 300_000);
afterAll(async () => {
  await app.close();
  await pg18.container.stop();
});

describe("pnpm db:seed (P6-05b)", () => {
  test("a handle that is not bricx_app is refused before any write (C1)", async () => {
    const owner = openDatabase(secretFor("bricx_owner"));
    try {
      await expect(runSeed(owner, dataset)).rejects.toBeInstanceOf(
        SeedRoleError,
      );
    } finally {
      await owner.close();
    }
    expect((await counts())["organizations"]).toBe(0);
  });

  test("a row the targetless ON CONFLICT skips (another row holds its slug) is drift, and nothing is written (H1, condition 1)", async () => {
    const squatter = deriveSeedId("test/squatter");
    await asAdmin(
      `INSERT INTO bricx.organizations
         (id, slug, legal_name, country, default_currency, default_language,
          timezone, units, data_region, created_at, updated_at)
       VALUES ($1, $2, 'Squatter Ltd', 'SL', 'SLE', 'en', 'Africa/Freetown',
          'metric', 'af-south-1', $3, $3)`,
      [squatter, orgA.slug, dataset.instant],
    );
    await expect(runSeed(app, dataset)).rejects.toThrow(
      new SeedDriftError("organizations", orgA.id),
    );
    const after = await counts();
    expect(after).toEqual({
      ...Object.fromEntries(Object.keys(expectedCounts).map((t) => [t, 0])),
      organizations: 1,
    });
    await asAdmin("DELETE FROM bricx.organizations WHERE id = $1", [squatter]);
  });

  test("the first run writes every dataset row", async () => {
    const result = await runSeed(app, dataset);
    expect(result).toEqual({
      inserted: totalRows,
      present: 0,
      tables: expectedCounts,
    });
    expect(await counts()).toEqual(expectedCounts);
  });

  test("the second run writes nothing and finds no drift (H1)", async () => {
    const before = await asAdmin(
      "SELECT id, last_seen_at::text FROM bricx.users ORDER BY id",
    );
    const result = await runSeed(app, dataset);
    expect(result).toEqual({
      inserted: 0,
      present: totalRows,
      tables: expectedCounts,
    });
    expect(await counts()).toEqual(expectedCounts);
    expect(
      await asAdmin(
        "SELECT id, last_seen_at::text FROM bricx.users ORDER BY id",
      ),
    ).toEqual(before);
  });

  test("the rows carry the dataset's regions, currencies and boundaries (J1)", async () => {
    expect(
      await asAdmin(
        "SELECT id::text, data_region FROM bricx.organizations ORDER BY data_region",
      ),
    ).toEqual([
      { id: orgA.id, data_region: "af-south-1" },
      { id: orgB.id, data_region: "eu-west-1" },
    ]);
    const sites = await asAdmin<{ valid: boolean; area: number }>(
      `SELECT extensions.ST_IsValid(geom::extensions.geometry) AS valid,
              extensions.ST_Area(geom) AS area FROM bricx.sites`,
    );
    expect(sites).toHaveLength(4);
    for (const site of sites) {
      expect(site.valid).toBe(true);
      expect(site.area).toBeGreaterThan(0);
      expect(site.area).toBeLessThan(1e9);
    }
  });

  test("every created_at and updated_at is the seed instant (condition 2)", async () => {
    const stamped: Record<string, readonly string[]> = {
      organizations: ["created_at", "updated_at"],
      users: ["created_at", "last_seen_at"],
      region_configs: ["created_at", "updated_at"],
      roles: ["created_at", "updated_at"],
      role_permissions: ["granted_at"],
      memberships: ["created_at"],
      projects: ["created_at", "updated_at"],
      sites: ["created_at", "updated_at"],
      project_memberships: ["created_at"],
      project_membership_sites: ["created_at"],
    };
    expect(Object.keys(stamped)).toEqual(Object.keys(expectedCounts));
    for (const [table, columns] of Object.entries(stamped)) {
      for (const column of columns) {
        expect(
          await asAdmin(
            `SELECT DISTINCT to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at FROM bricx.${table}`,
          ),
          `${table}.${column}`,
        ).toEqual([{ at: dataset.instant }]);
      }
    }
  });

  test("org B (eu-west-1) is written under the dev cell config (J1, condition 6)", async () => {
    const example = parseEnv(
      readFileSync(path.join(repoRoot, ".env.example"), "utf8"),
    );
    expect(example["CELL_ID"]).toBe("af-south-1");
    const devCells = DEV_CELLS.map((cell) => cell.id);
    for (const org of dataset.orgs) {
      expect(devCells).toContain(org.dataRegion);
    }
    expect(
      await asAdmin(
        "SELECT slug, data_region FROM bricx.organizations WHERE id = $1",
        [orgB.id],
      ),
    ).toEqual([{ slug: orgB.slug, data_region: "eu-west-1" }]);
    expect(
      await visible(
        orgB.id,
        orgB.users[0]?.id ?? "",
        [orgB.project.id],
        "sites",
      ),
    ).toBe(2);
  });

  test("one organisation never sees the other's rows (FORCE RLS)", async () => {
    for (const [mine, theirs] of [
      [orgA, orgB],
      [orgB, orgA],
    ] as const) {
      const owner = mine.users[0]?.id ?? "";
      const ownProjects = [mine.project.id];
      expect(await visible(mine.id, owner, ownProjects, "projects")).toBe(1);
      expect(await visible(mine.id, owner, ownProjects, "sites")).toBe(2);
      expect(await visible(mine.id, owner, ownProjects, "roles")).toBe(
        mine.roles.length,
      );
      expect(
        await visible(mine.id, owner, [theirs.project.id], "projects"),
      ).toBe(0);
      expect(await visible(mine.id, owner, [theirs.project.id], "sites")).toBe(
        0,
      );
      expect(await visible(mine.id, owner, [], "organizations")).toBe(1);
    }
  });

  test("an edited project stops the run, names table and id only, and stays edited (H1)", async () => {
    const edited = "Edited by the owner 7f3a";
    await asAdmin("UPDATE bricx.projects SET name = $1 WHERE id = $2", [
      edited,
      orgA.project.id,
    ]);
    let caught: unknown;
    try {
      await runSeed(app, dataset);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SeedDriftError);
    const drift = caught as SeedDriftError;
    expect(drift.table).toBe("projects");
    expect(drift.id).toBe(orgA.project.id);
    expect(drift.message).toBe(`seed drift: projects ${orgA.project.id}`);
    expect(drift.message).not.toContain(edited);
    expect(drift.message).not.toContain(orgA.project.name);
    expect(
      await asAdmin("SELECT name FROM bricx.projects WHERE id = $1", [
        orgA.project.id,
      ]),
    ).toEqual([{ name: edited }]);
    expect(await counts()).toEqual(expectedCounts);
    await asAdmin("UPDATE bricx.projects SET name = $1 WHERE id = $2", [
      orgA.project.name,
      orgA.project.id,
    ]);
  });

  test("a moved site boundary is drift too, and is not overwritten", async () => {
    const site = orgB.sites[1];
    if (site === undefined) throw new Error("site");
    const moved =
      '{"type":"Polygon","coordinates":[[[0,0],[0.001,0],[0.001,0.001],[0,0.001],[0,0]]]}';
    await asAdmin(
      "UPDATE bricx.sites SET geom = extensions.ST_GeomFromGeoJSON($1)::extensions.geography WHERE id = $2",
      [moved, site.id],
    );
    await expect(runSeed(app, dataset)).rejects.toThrow(
      `seed drift: sites ${site.id}`,
    );
    const [row] = await asAdmin<{ g: string }>(
      "SELECT extensions.ST_AsGeoJSON(geom) AS g FROM bricx.sites WHERE id = $1",
      [site.id],
    );
    expect(JSON.parse(row?.g ?? "null")).toEqual(JSON.parse(moved));
    await asAdmin(
      "UPDATE bricx.sites SET geom = extensions.ST_GeomFromGeoJSON($1)::extensions.geography WHERE id = $2",
      [JSON.stringify(site.boundary), site.id],
    );
    expect(await runSeed(app, dataset)).toEqual({
      inserted: 0,
      present: totalRows,
      tables: expectedCounts,
    });
  });

  test("a user whose subject maps to another id is drift (users)", async () => {
    const user = orgB.users[3];
    if (user === undefined) throw new Error("user");
    await asAdmin("UPDATE bricx.users SET keycloak_sub = $1 WHERE id = $2", [
      "renamed-subject-1",
      user.id,
    ]);
    await expect(runSeed(app, dataset)).rejects.toThrow(
      `seed drift: users ${user.id}`,
    );
    await asAdmin("UPDATE bricx.users SET keycloak_sub = $1 WHERE id = $2", [
      user.sub,
      user.id,
    ]);
  });

  test("the CLI seeds as bricx_app and prints the same counts-only summary each run (I1, condition 5)", async () => {
    const env = { NODE_ENV: "development", DATABASE_URL: urlFor("bricx_app") };
    const outputs: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const result = await cli(env);
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
      outputs.push(result.stdout);
    }
    expect(outputs[0]).toBe(summary);
    expect(outputs[1]).toBe(outputs[0]);
    expect(await counts()).toEqual(expectedCounts);
  });

  test("the CLI fails clearly when the env file is missing (condition 6)", async () => {
    const missing = path.join(repoRoot, "packages/db/test/no-such.env");
    const result = await cli({}, [`--env-file=${missing}`]);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`${missing}: not found`);
    const empty = await cli({});
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain("NODE_ENV: missing");
    expect(empty.stderr).toContain("DATABASE_URL: missing");
    expect(empty.stderr).toContain(".env");
  });

  test("the CLI refuses production and a non-bricx_app user, echoing no value (E1)", async () => {
    const production = await cli({
      NODE_ENV: "production",
      DATABASE_URL: urlFor("bricx_app"),
    });
    expect(production.code).toBe(1);
    expect(production.stdout).toBe("");
    expect(production.stderr).toContain("NODE_ENV: seed_refused_in_production");
    expect(production.stderr).not.toContain(
      exampleValue(rolePasswordKeys.bricx_app),
    );
    const owner = await cli({
      NODE_ENV: "development",
      DATABASE_URL: urlFor("bricx_owner"),
    });
    expect(owner.code).toBe(1);
    expect(owner.stderr).toContain("DATABASE_URL: seed_role_not_bricx_app");
    expect(owner.stderr).not.toContain(
      exampleValue(rolePasswordKeys.bricx_owner),
    );
    expect(await counts()).toEqual(expectedCounts);
  });

  test("the CLI reports drift as table and id, exit 1", async () => {
    await asAdmin(
      "UPDATE bricx.organizations SET legal_name = $1 WHERE id = $2",
      ["Changed Legal Name 9c1", orgB.id],
    );
    const result = await cli({
      NODE_ENV: "development",
      DATABASE_URL: urlFor("bricx_app"),
    });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe(`seed drift: organizations ${orgB.id}\n`);
  });
});
