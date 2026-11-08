// P6-05 (ADR 0075; owner conditions C1, C3, C4, C6–C9): migration 0011
// against Postgres with the production journal, applied by the real
// migrator as bricx_owner.
// - bricx.projects (project.project), bricx.sites (project.site) and
//   bricx.project_membership_sites (project.member): FORCE RLS, tenant and
//   project isolation (Done-when 1), not published (phase D1);
// - every foreign key carries org_id (D10): no row points at another
//   org's project or site; a site elevation's site belongs to its project;
// - projects: the code pattern and its case-insensitive uniqueness per org
//   (C7), the contract value's CHECKs (C8), start <= end, the status
//   list; the guard trigger (P6004): currency, reporting currency and
//   timezone change only while draft (C1), archived is final, id, org,
//   creator and creation time never change;
// - sites: a valid, counter-clockwise, 2-D polygon of at most 1 000 km²
//   (D17, C6); the radius 0..10 000; the GiST index a point-in-site query
//   uses (EXPLAIN);
// - region_configs project rows hold no currency, reporting currency or
//   timezone (C1); access_grants' scope CHECKs (C9) and site_id in the
//   immutable trigger; the user reads their own site assignments and the
//   sites they are assigned to (DbGrantsSource, C4);
// - bricx_app never creates an extension (C6).
import { randomUUID } from "node:crypto";
import {
  type BootstrappedPostgres,
  type Role,
  appDatabase,
  exampleValue,
  rolePasswordKeys,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { PgDialect } from "drizzle-orm/pg-core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sqlstateOf } from "../src/database.js";
import { migrate } from "../src/migrate.js";
import {
  OWN_ROW_TABLES,
  PROJECT_APP_COLUMNS,
  PROJECT_MEMBERSHIP_SITE_APP_COLUMNS,
  SITE_APP_COLUMNS,
  TENANT_TABLES,
  TENANT_UPDATE_COLUMNS,
} from "../src/rls.js";
import {
  type TxContext,
  contextStatement,
  validateTxContext,
} from "../src/tx.js";

const DENIED = "42501";
const FK = "23503";
const CHECK = "23514";
const UNIQUE = "23505";
const GUARD = "P6004";
const dialect = new PgDialect();
const NOW = "2026-11-08T12:00:00.000Z";
const LATER = "2026-11-08T13:00:00.000Z";

let pg18: BootstrappedPostgres;
let n = 0;
const nextId = (): string => {
  n += 1;
  return `0199e1d5-${n.toString(16).padStart(4, "0")}-7000-8000-${randomUUID().slice(-12)}`;
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

/** The SQLSTATE of a statement run as the superuser, or "ok". */
async function adminOutcome(text: string, params: unknown[] = []) {
  const admin = await pg18.admin();
  try {
    await admin.query("BEGIN");
    try {
      await admin.query(text, params);
      return "ok";
    } catch (error) {
      return sqlstateOf(error) ?? "?";
    } finally {
      await admin.query("ROLLBACK");
    }
  } finally {
    await admin.end();
  }
}

/** "ok:<rowCount>" or the SQLSTATE of a statement as `who`, rolled back. */
async function outcome(
  who: Role,
  ctx: TxContext | undefined,
  text: string,
  params: unknown[] = [],
): Promise<string> {
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
      const r = await client.query(text, params);
      return `ok:${String(r.rowCount)}`;
    } catch (error) {
      return sqlstateOf(error) ?? "?";
    } finally {
      await client.query("ROLLBACK");
    }
  } finally {
    await client.end();
  }
}

/** The rows of a SELECT as `who`, rolled back. */
async function rowsAs<R extends pg.QueryResultRow>(
  who: Role,
  ctx: TxContext,
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const client = await pg18.connectAs(who);
  try {
    await client.query("BEGIN");
    const q = dialect.sqlToQuery(
      contextStatement(validateTxContext(ctx), 30_000),
    );
    await client.query(q.sql, q.params);
    const r = await client.query<R>(text, params);
    await client.query("ROLLBACK");
    return r.rows;
  } finally {
    await client.end();
  }
}

async function seedUser(): Promise<string> {
  const id = nextId();
  await asAdmin(
    `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
     VALUES ($1, $2, $3, $3)`,
    [id, `p605-${id}`, NOW],
  );
  return id;
}

async function seedOrg(): Promise<string> {
  const id = nextId();
  await asAdmin(
    `INSERT INTO bricx.organizations
       (id, slug, legal_name, country, default_currency, default_language,
        timezone, units, data_region, created_at, updated_at)
     VALUES ($1, $2, 'Seeded Ltd', 'SL', 'SLE', 'en', 'Africa/Freetown',
        'metric', 'af-south-1', $3, $3)`,
    [id, `p605-${id.slice(-12)}`, NOW],
  );
  return id;
}

async function seedRole(org: string): Promise<string> {
  const id = nextId();
  await asAdmin(
    `INSERT INTO bricx.roles (id, org_id, key, name, created_at, updated_at)
     VALUES ($1, $2, $3, 'Role', $4, $4)`,
    [id, org, `r_${id.slice(-12)}`, NOW],
  );
  return id;
}

const SQUARE = {
  type: "Polygon",
  coordinates: [
    [
      [-13.24, 8.48],
      [-13.23, 8.48],
      [-13.23, 8.49],
      [-13.24, 8.49],
      [-13.24, 8.48],
    ],
  ],
};

const projectColumns = (org: string, by: string, over: object = {}) => ({
  id: nextId(),
  org_id: org,
  code: `P-${String(n)}`,
  name: "Bridge",
  status: "draft",
  currency: "SLE",
  reporting_currency: "USD",
  timezone: "Africa/Freetown",
  created_by: by,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

function insertSql(table: string, columns: Readonly<Record<string, unknown>>) {
  const names = Object.keys(columns);
  return {
    text: `INSERT INTO bricx.${table} (${names.join(", ")}) VALUES (${names
      .map((name, i) =>
        name === "geom"
          ? `extensions.ST_GeomFromGeoJSON($${String(i + 1)})::extensions.geography`
          : `$${String(i + 1)}`,
      )
      .join(", ")})`,
    params: names.map((name) => {
      const value = columns[name];
      return name === "geom" ? JSON.stringify(value) : value;
    }),
  };
}

async function seedProject(
  org: string,
  by: string,
  over: object = {},
): Promise<string> {
  const columns = projectColumns(org, by, over);
  const q = insertSql("projects", columns);
  await asAdmin(q.text, q.params);
  return columns.id;
}

const siteColumns = (
  org: string,
  project: string,
  by: string,
  over: object = {},
) => ({
  id: nextId(),
  org_id: org,
  project_id: project,
  name: "North yard",
  geom: SQUARE,
  geofence_radius_m: 50,
  created_by: by,
  created_at: NOW,
  updated_at: NOW,
  ...over,
});

async function seedSite(
  org: string,
  project: string,
  by: string,
  over: object = {},
): Promise<string> {
  const columns = siteColumns(org, project, by, over);
  const q = insertSql("sites", columns);
  await asAdmin(q.text, q.params);
  return columns.id;
}

async function seedProjectMembership(
  org: string,
  project: string,
  user: string,
): Promise<string> {
  const role = await seedRole(org);
  const id = nextId();
  await asAdmin(
    `INSERT INTO bricx.project_memberships
       (id, org_id, project_id, user_id, role_id, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, org, project, user, role, NOW],
  );
  return id;
}

const grantColumns = (
  org: string,
  user: string,
  by: string,
  permission: string,
  scopeId: string | null,
  siteId: string | null,
) => ({
  id: nextId(),
  org_id: org,
  user_id: user,
  permission,
  scope_id: scopeId,
  site_id: siteId,
  reason: "cover",
  granted_by: by,
  starts_at: NOW,
  expires_at: LATER,
  created_at: NOW,
});

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"));
}, 300_000);
afterAll(async () => {
  await pg18.container.stop();
});

describe("migration 0011: registration, RLS and publication", () => {
  test("registered tenant tables; the assignment table carries an own-row read; column-limited UPDATE", () => {
    expect(TENANT_TABLES["bricx.projects"]).toBe("project.project");
    expect(TENANT_TABLES["bricx.sites"]).toBe("project.site");
    expect(TENANT_TABLES["bricx.project_membership_sites"]).toBe(
      "project.member",
    );
    expect(OWN_ROW_TABLES["bricx.project_membership_sites"]).toEqual({
      column: "user_id",
      update: false,
    });
    expect(TENANT_UPDATE_COLUMNS["bricx.projects"]).toEqual(
      PROJECT_APP_COLUMNS,
    );
    expect(TENANT_UPDATE_COLUMNS["bricx.sites"]).toEqual(SITE_APP_COLUMNS);
    expect(TENANT_UPDATE_COLUMNS["bricx.project_membership_sites"]).toEqual(
      PROJECT_MEMBERSHIP_SITE_APP_COLUMNS,
    );
    for (const fixed of ["id", "org_id", "created_by", "created_at"]) {
      expect(PROJECT_APP_COLUMNS).not.toContain(fixed);
      expect(SITE_APP_COLUMNS).not.toContain(fixed);
    }
    expect(SITE_APP_COLUMNS).not.toContain("project_id");
    expect(PROJECT_MEMBERSHIP_SITE_APP_COLUMNS).toEqual(["removed_at"]);
  });

  test("ENABLE + FORCE row level security on the three tables; none is published (phase D1)", async () => {
    expect(
      await asAdmin(
        `SELECT relname AS name, relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class
         WHERE oid IN ('bricx.projects'::regclass, 'bricx.sites'::regclass,
                       'bricx.project_membership_sites'::regclass)
         ORDER BY relname`,
      ),
    ).toEqual([
      { name: "project_membership_sites", enabled: true, forced: true },
      { name: "projects", enabled: true, forced: true },
      { name: "sites", enabled: true, forced: true },
    ]);
    expect(
      await asAdmin(
        `SELECT tablename FROM pg_publication_tables
         WHERE schemaname = 'bricx'
           AND tablename IN ('projects', 'sites', 'project_membership_sites')`,
      ),
    ).toEqual([]);
  });

  test("RLS (Done-when 1): another org's projects and sites are invisible; a project context sees its own projects only; '*' sees the org's", async () => {
    const user = await seedUser();
    const a = await seedOrg();
    const b = await seedOrg();
    const pa1 = await seedProject(a, user);
    const pa2 = await seedProject(a, user);
    const pb = await seedProject(b, user);
    await seedSite(a, pa1, user);
    await seedSite(a, pa2, user);
    await seedSite(b, pb, user);
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id).sort();
    // Project scope: only its own project, in its own org.
    expect(
      ids(
        await rowsAs(
          "bricx_app",
          { orgId: a, userId: user, projectIds: [pa1] },
          "SELECT id FROM bricx.projects",
        ),
      ),
    ).toEqual([pa1]);
    expect(
      await rowsAs(
        "bricx_app",
        { orgId: a, userId: user, projectIds: [pa1] },
        "SELECT project_id FROM bricx.sites",
      ),
    ).toEqual([{ project_id: pa1 }]);
    // A project id of another org in the context still shows nothing of it.
    expect(
      await rowsAs(
        "bricx_app",
        { orgId: a, userId: user, projectIds: [pb] },
        "SELECT id FROM bricx.projects",
      ),
    ).toEqual([]);
    // Org scope ('*'): every project of the org, none of another.
    expect(
      ids(
        await rowsAs(
          "bricx_app",
          { orgId: a, userId: user, projectIds: [], allProjects: true },
          "SELECT id FROM bricx.projects",
        ),
      ),
    ).toEqual([pa1, pa2].sort());
    // No project ids: nothing.
    expect(
      await rowsAs(
        "bricx_app",
        { orgId: a, userId: user, projectIds: [] },
        "SELECT id FROM bricx.projects",
      ),
    ).toEqual([]);
    // Writing another org's project: refused or matches nothing.
    const into = insertSql("projects", projectColumns(b, user));
    expect(
      await outcome(
        "bricx_app",
        { orgId: a, userId: user, projectIds: [], allProjects: true },
        into.text,
        into.params,
      ),
    ).toBe(DENIED);
    expect(
      await outcome(
        "bricx_app",
        { orgId: a, userId: user, projectIds: [], allProjects: true },
        "UPDATE bricx.projects SET name = 'x' WHERE id = $1",
        [pb],
      ),
    ).toBe("ok:0");
  });

  test("a project INSERT checks the org and the creator; nobody deletes a project or a site", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const org = await seedOrg();
    const all = { orgId: org, userId: user, projectIds: [], allProjects: true };
    const mine = insertSql("projects", projectColumns(org, user));
    expect(await outcome("bricx_app", all, mine.text, mine.params)).toBe(
      "ok:1",
    );
    const theirs = insertSql("projects", projectColumns(org, other));
    expect(await outcome("bricx_app", all, theirs.text, theirs.params)).toBe(
      DENIED,
    );
    const project = await seedProject(org, user);
    await seedSite(org, project, user);
    for (const table of ["projects", "sites"]) {
      expect(
        await outcome(
          "bricx_app",
          all,
          `DELETE FROM bricx.${table} WHERE org_id = $1`,
          [org],
        ),
      ).toBe("ok:0");
    }
  });

  test("bricx_app may UPDATE only the editable columns", async () => {
    const user = await seedUser();
    const org = await seedOrg();
    const project = await seedProject(org, user);
    const site = await seedSite(org, project, user);
    const all = { orgId: org, userId: user, projectIds: [], allProjects: true };
    for (const set of [
      `id = '${nextId()}'`,
      `org_id = '${org}'`,
      `created_by = '${user}'`,
      "created_at = now()",
    ]) {
      expect(
        await outcome(
          "bricx_app",
          all,
          `UPDATE bricx.projects SET ${set} WHERE id = $1`,
          [project],
        ),
        set,
      ).toBe(DENIED);
      expect(
        await outcome(
          "bricx_app",
          all,
          `UPDATE bricx.sites SET ${set} WHERE id = $1`,
          [site],
        ),
        set,
      ).toBe(DENIED);
    }
    expect(
      await outcome(
        "bricx_app",
        all,
        `UPDATE bricx.sites SET project_id = $2 WHERE id = $1`,
        [site, project],
      ),
    ).toBe(DENIED);
    expect(
      await outcome(
        "bricx_app",
        all,
        "UPDATE bricx.projects SET name = 'Renamed', updated_at = $2 WHERE id = $1",
        [project, LATER],
      ),
    ).toBe("ok:1");
    expect(
      await outcome(
        "bricx_app",
        all,
        "UPDATE bricx.sites SET name = 'Renamed', updated_at = $2 WHERE id = $1",
        [site, LATER],
      ),
    ).toBe("ok:1");
  });

  test("bricx_app never creates an extension (C6)", async () => {
    expect(
      await outcome(
        "bricx_app",
        undefined,
        "CREATE EXTENSION IF NOT EXISTS hstore SCHEMA extensions",
      ),
    ).toBe(DENIED);
    expect(
      await asAdmin(
        "SELECT extnamespace::regnamespace::text AS schema FROM pg_extension WHERE extname = 'postgis'",
      ),
    ).toEqual([{ schema: "extensions" }]);
  });
});

describe("projects: CHECKs and the guard trigger", () => {
  test.each([
    ["A", true],
    ["p-01", true],
    ["BR.2026_x-1", true],
    ["9", true],
    [`A${"b".repeat(31)}`, true],
    [`A${"b".repeat(32)}`, false],
    ["", false],
    ["-A", false],
    [".A", false],
    ["A B", false],
    ["Å1", false],
    ["A/1", false],
  ])("code %j valid: %s (C7)", async (code, valid) => {
    const user = await seedUser();
    const org = await seedOrg();
    const q = insertSql("projects", projectColumns(org, user, { code }));
    expect(await adminOutcome(q.text, q.params)).toBe(valid ? "ok" : CHECK);
  });

  test("the code is unique per org regardless of case (C7); another org may reuse it", async () => {
    const user = await seedUser();
    const org = await seedOrg();
    const other = await seedOrg();
    await seedProject(org, user, { code: "Bridge-1" });
    const dup = insertSql(
      "projects",
      projectColumns(org, user, { code: "BRIDGE-1" }),
    );
    expect(await adminOutcome(dup.text, dup.params)).toBe(UNIQUE);
    const elsewhere = insertSql(
      "projects",
      projectColumns(other, user, { code: "bridge-1" }),
    );
    expect(await adminOutcome(elsewhere.text, elsewhere.params)).toBe("ok");
  });

  test.each([
    [{ contract_value_minor: "0", contract_value_currency: "USD" }, "ok"],
    [
      {
        contract_value_minor: "9223372036854775807",
        contract_value_currency: "SLE",
      },
      "ok",
    ],
    [{ contract_value_minor: "-1", contract_value_currency: "USD" }, CHECK],
    [{ contract_value_minor: "100" }, CHECK],
    [{ contract_value_currency: "USD" }, CHECK],
    [{ contract_value_minor: "1", contract_value_currency: "usd" }, CHECK],
    [{ start_date: "2026-01-01", end_date: "2026-01-01" }, "ok"],
    [{ start_date: "2026-01-02", end_date: "2026-01-01" }, CHECK],
    [{ name: "" }, CHECK],
    [{ name: "x".repeat(201) }, CHECK],
    [{ client_name: "" }, CHECK],
    [{ client_name: "x".repeat(201) }, CHECK],
    [{ status: "closed" }, CHECK],
    [{ currency: "us" }, CHECK],
    [{ reporting_currency: "EURO" }, CHECK],
    [{ timezone: "Not a zone!" }, CHECK],
    [{ status: "archived" }, CHECK],
    [{ status: "archived", archived_at: NOW }, "ok"],
    [{ status: "draft", archived_at: NOW }, CHECK],
  ])("%j -> %s (C8, D18)", async (over, expected) => {
    const user = await seedUser();
    const org = await seedOrg();
    const q = insertSql("projects", projectColumns(org, user, over));
    expect(await adminOutcome(q.text, q.params)).toBe(expected);
  });

  test.each(["currency", "reporting_currency", "timezone"])(
    "%s changes only while draft (C1, P6004)",
    async (column) => {
      const user = await seedUser();
      const org = await seedOrg();
      const value = column === "timezone" ? "Africa/Lagos" : "EUR";
      const draft = await seedProject(org, user);
      expect(
        await adminOutcome(
          `UPDATE bricx.projects SET ${column} = $2 WHERE id = $1`,
          [draft, value],
        ),
      ).toBe("ok");
      for (const status of ["active", "on_hold", "completed"]) {
        const project = await seedProject(org, user, { status });
        expect(
          await adminOutcome(
            `UPDATE bricx.projects SET ${column} = $2 WHERE id = $1`,
            [project, value],
          ),
          status,
        ).toBe(GUARD);
      }
    },
  );

  test("an archived project never changes again; id, org, creator and creation time never change (P6004)", async () => {
    const user = await seedUser();
    const org = await seedOrg();
    const archived = await seedProject(org, user, {
      status: "archived",
      archived_at: NOW,
    });
    for (const set of ["name = 'x'", "status = 'draft', archived_at = NULL"]) {
      expect(
        await adminOutcome(`UPDATE bricx.projects SET ${set} WHERE id = $1`, [
          archived,
        ]),
        set,
      ).toBe(GUARD);
    }
    const project = await seedProject(org, user);
    for (const set of [
      `id = '${nextId()}'`,
      `org_id = '${await seedOrg()}'`,
      `created_by = '${await seedUser()}'`,
      `created_at = '${LATER}'`,
    ]) {
      expect(
        await adminOutcome(`UPDATE bricx.projects SET ${set} WHERE id = $1`, [
          project,
        ]),
        set,
      ).toBe(GUARD);
    }
  });
});

describe("sites: geometry (D17, C6), radius and the GiST index", () => {
  const ring = (coords: number[][]) => ({
    type: "Polygon",
    coordinates: [coords],
  });

  test.each([
    ["the square", SQUARE, "ok"],
    [
      "a square with a clockwise hole",
      {
        type: "Polygon",
        coordinates: [
          SQUARE.coordinates[0],
          [
            [-13.238, 8.482],
            [-13.238, 8.488],
            [-13.232, 8.488],
            [-13.232, 8.482],
            [-13.238, 8.482],
          ],
        ],
      },
      "ok",
    ],
    [
      "a self-intersecting bow tie",
      ring([
        [-13.24, 8.48],
        [-13.23, 8.49],
        [-13.23, 8.48],
        [-13.24, 8.49],
        [-13.24, 8.48],
      ]),
      CHECK,
    ],
    [
      "a clockwise outer ring",
      ring([
        [-13.24, 8.48],
        [-13.24, 8.49],
        [-13.23, 8.49],
        [-13.23, 8.48],
        [-13.24, 8.48],
      ]),
      CHECK,
    ],
    [
      "one degree square (about 12 000 km²)",
      ring([
        [-13.5, 8.0],
        [-12.5, 8.0],
        [-12.5, 9.0],
        [-13.5, 9.0],
        [-13.5, 8.0],
      ]),
      CHECK,
    ],
    [
      "a 3-D polygon",
      ring([
        [-13.24, 8.48, 1],
        [-13.23, 8.48, 1],
        [-13.23, 8.49, 1],
        [-13.24, 8.49, 1],
        [-13.24, 8.48, 1],
      ]),
      CHECK,
    ],
  ])("%s -> %s", async (_name, geom, expected) => {
    const user = await seedUser();
    const org = await seedOrg();
    const project = await seedProject(org, user);
    const q = insertSql("sites", siteColumns(org, project, user, { geom }));
    expect(await adminOutcome(q.text, q.params)).toBe(expected);
  });

  test("the area bound is 1 000 km²: about 31.6 km square passes at the equator only below it", async () => {
    const user = await seedUser();
    const org = await seedOrg();
    const project = await seedProject(org, user);
    const square = (side: number) =>
      ring([
        [0, 0],
        [side, 0],
        [side, side],
        [0, side],
        [0, 0],
      ]);
    // 0.28° ≈ 31.2 km: ≈ 970 km²; 0.29° ≈ 32.3 km: ≈ 1 040 km².
    const ok = insertSql(
      "sites",
      siteColumns(org, project, user, { geom: square(0.28) }),
    );
    expect(await adminOutcome(ok.text, ok.params)).toBe("ok");
    const big = insertSql(
      "sites",
      siteColumns(org, project, user, { geom: square(0.29) }),
    );
    expect(await adminOutcome(big.text, big.params)).toBe(CHECK);
  });

  test.each([
    [0, "ok"],
    [10_000, "ok"],
    [-1, CHECK],
    [10_001, CHECK],
  ])("geofence_radius_m %d -> %s", async (radius, expected) => {
    const user = await seedUser();
    const org = await seedOrg();
    const project = await seedProject(org, user);
    const q = insertSql(
      "sites",
      siteColumns(org, project, user, { geofence_radius_m: radius }),
    );
    expect(await adminOutcome(q.text, q.params)).toBe(expected);
  });

  test.each([
    [{ name: "" }, CHECK],
    [{ name: "x".repeat(201) }, CHECK],
    [{ address: "x".repeat(500) }, "ok"],
    [{ address: "x".repeat(501) }, CHECK],
    [{ archived_at: NOW }, "ok"],
  ])("%j -> %s", async (over, expected) => {
    const user = await seedUser();
    const org = await seedOrg();
    const project = await seedProject(org, user);
    const q = insertSql("sites", siteColumns(org, project, user, over));
    expect(await adminOutcome(q.text, q.params)).toBe(expected);
  });

  test("a GiST index on geom, and a point-in-site query uses it (EXPLAIN)", async () => {
    expect(
      await asAdmin(
        `SELECT am.amname AS method
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_am am ON am.oid = c.relam
         WHERE i.indrelid = 'bricx.sites'::regclass AND c.relname = 'sites_geom_gist'`,
      ),
    ).toEqual([{ method: "gist" }]);
    const admin = await pg18.admin();
    try {
      await admin.query("BEGIN");
      await admin.query("SET LOCAL enable_seqscan = off");
      const plan = await admin.query<{ "QUERY PLAN": string }>(
        `EXPLAIN SELECT id FROM bricx.sites
         WHERE extensions.ST_Intersects(geom, extensions.ST_SetSRID(extensions.ST_MakePoint(-13.235, 8.485), 4326)::extensions.geography)`,
      );
      await admin.query("ROLLBACK");
      expect(plan.rows.map((r) => r["QUERY PLAN"]).join("\n")).toContain(
        "sites_geom_gist",
      );
    } finally {
      await admin.end();
    }
  });

  test("an archived site is final: only bricx_owner-free reads; archived_at never clears (P6005)", async () => {
    const user = await seedUser();
    const org = await seedOrg();
    const project = await seedProject(org, user);
    const site = await seedSite(org, project, user, { archived_at: NOW });
    expect(
      await adminOutcome(
        "UPDATE bricx.sites SET archived_at = NULL WHERE id = $1",
        [site],
      ),
    ).toBe("P6005");
    expect(
      await adminOutcome("UPDATE bricx.sites SET name = 'x' WHERE id = $1", [
        site,
      ]),
    ).toBe("P6005");
  });
});

describe("foreign keys carry org_id (D10)", () => {
  test("a site, a project membership and a region row cannot point at another org's project", async () => {
    const user = await seedUser();
    const a = await seedOrg();
    const b = await seedOrg();
    const pb = await seedProject(b, user);
    const site = insertSql("sites", siteColumns(a, pb, user));
    expect(await adminOutcome(site.text, site.params)).toBe(FK);
    const role = await seedRole(a);
    expect(
      await adminOutcome(
        `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [nextId(), a, pb, user, role, NOW],
      ),
    ).toBe(FK);
    expect(
      await adminOutcome(
        `INSERT INTO bricx.region_configs (id, org_id, project_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [nextId(), a, pb, NOW],
      ),
    ).toBe(FK);
    // An unknown project is refused too (P6-03 Also line).
    expect(
      await adminOutcome(
        `INSERT INTO bricx.region_configs (id, org_id, project_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $4)`,
        [nextId(), a, nextId(), NOW],
      ),
    ).toBe(FK);
  });

  test("an elevation's project is the org's; its site belongs to that project", async () => {
    const user = await seedUser();
    const by = await seedUser();
    const a = await seedOrg();
    const b = await seedOrg();
    const pa = await seedProject(a, user);
    const pa2 = await seedProject(a, user);
    const pb = await seedProject(b, user);
    const sa2 = await seedSite(a, pa2, user);
    const sa = await seedSite(a, pa, user);
    const grant = (
      scope: string | null,
      site: string | null,
      permission: string,
    ) =>
      insertSql(
        "access_grants",
        grantColumns(a, user, by, permission, scope, site),
      );
    const cases: [string | null, string | null, string, string][] = [
      [pb, null, "project.project.update.project", FK],
      [pa, sa2, "project.site.update.site", FK],
      [pa, sa, "project.site.update.site", "ok"],
      [pa, null, "project.project.update.project", "ok"],
    ];
    for (const [scope, site, permission, expected] of cases) {
      const q = grant(scope, site, permission);
      expect(
        await adminOutcome(q.text, q.params),
        `${String(scope)} ${String(site)}`,
      ).toBe(expected);
    }
  });

  test("a site assignment's site and membership are the same org's and project's", async () => {
    const user = await seedUser();
    const a = await seedOrg();
    const pa = await seedProject(a, user);
    const pa2 = await seedProject(a, user);
    const sa2 = await seedSite(a, pa2, user);
    const sa = await seedSite(a, pa, user);
    const membership = await seedProjectMembership(a, pa, user);
    const assign = (
      site: string,
      project: string,
      member: string,
      who: string,
    ) =>
      adminOutcome(
        `INSERT INTO bricx.project_membership_sites
           (id, org_id, project_id, project_membership_id, user_id, site_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [nextId(), a, project, member, who, site, NOW],
      );
    expect(await assign(sa, pa, membership, user)).toBe("ok");
    expect(await assign(sa2, pa, membership, user)).toBe(FK);
    expect(await assign(sa2, pa2, membership, user)).toBe(FK);
    expect(await assign(sa, pa, membership, await seedUser())).toBe(FK);
  });
});

describe("region_configs (C1) and access_grants (C9) CHECKs", () => {
  test.each([
    [{ currency: "USD" }, CHECK],
    [{ reporting_currency: "USD" }, CHECK],
    [{ timezone: "Africa/Lagos" }, CHECK],
    [{ language: "fr", units: "metric", format_locale: "fr-SL" }, "ok"],
  ])(
    "a project row %j -> %s; the org row keeps its reporting currency",
    async (over, expected) => {
      const user = await seedUser();
      const org = await seedOrg();
      const project = await seedProject(org, user);
      const q = insertSql("region_configs", {
        id: nextId(),
        org_id: org,
        project_id: project,
        created_at: NOW,
        updated_at: NOW,
        ...over,
      });
      expect(await adminOutcome(q.text, q.params)).toBe(expected);
      const orgRow = insertSql("region_configs", {
        id: nextId(),
        org_id: org,
        project_id: null,
        reporting_currency: "USD",
        created_at: NOW,
        updated_at: NOW,
      });
      expect(await adminOutcome(orgRow.text, orgRow.params)).toBe("ok");
    },
  );

  test("a site key needs scope_id and site_id; a project key scope_id and no site_id; org and own keys neither (C9)", async () => {
    const user = await seedUser();
    const by = await seedUser();
    const org = await seedOrg();
    const project = await seedProject(org, user);
    const site = await seedSite(org, project, user);
    const cases: [string, string | null, string | null, string][] = [
      ["project.site.update.site", project, site, "ok"],
      ["project.site.update.site", project, null, CHECK],
      ["project.site.update.site", null, null, CHECK],
      ["project.project.update.project", project, null, "ok"],
      ["project.project.update.project", project, site, CHECK],
      ["project.project.update.project", null, null, CHECK],
      ["org.member.read.org", null, null, "ok"],
      ["org.member.read.org", project, null, CHECK],
      ["org.member.read.org", project, site, CHECK],
      ["finance.expense.read.own", null, null, "ok"],
      ["finance.expense.read.own", project, null, CHECK],
    ];
    for (const [permission, scope, siteId, expected] of cases) {
      const q = insertSql(
        "access_grants",
        grantColumns(org, user, by, permission, scope, siteId),
      );
      expect(
        await adminOutcome(q.text, q.params),
        `${permission} ${String(scope)} ${String(siteId)}`,
      ).toBe(expected);
    }
  });

  test("site_id is immutable like the rest of an elevation (trigger access_grants_immutable)", async () => {
    const user = await seedUser();
    const by = await seedUser();
    const org = await seedOrg();
    const project = await seedProject(org, user);
    const site = await seedSite(org, project, user);
    const other = await seedSite(org, project, user);
    const columns = grantColumns(
      org,
      user,
      by,
      "project.site.read.site",
      project,
      site,
    );
    const q = insertSql("access_grants", columns);
    await asAdmin(q.text, q.params);
    expect(
      await adminOutcome(
        "UPDATE bricx.access_grants SET site_id = $2 WHERE id = $1",
        [columns.id, other],
      ),
    ).toBe(DENIED);
  });
});

describe("own reads for DbGrantsSource (C4)", () => {
  test("with no project ids, a user reads their own open assignments and the sites they name or an elevation names, nothing else", async () => {
    const user = await seedUser();
    const other = await seedUser();
    const by = await seedUser();
    const org = await seedOrg();
    const project = await seedProject(org, user);
    const assigned = await seedSite(org, project, user);
    const elevated = await seedSite(org, project, user);
    const unrelated = await seedSite(org, project, user);
    const membership = await seedProjectMembership(org, project, user);
    const theirs = await seedProjectMembership(org, project, other);
    await asAdmin(
      `INSERT INTO bricx.project_membership_sites
         (id, org_id, project_id, project_membership_id, user_id, site_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7), ($8, $2, $3, $9, $10, $11, $7)`,
      [
        nextId(),
        org,
        project,
        membership,
        user,
        assigned,
        NOW,
        nextId(),
        theirs,
        other,
        unrelated,
      ],
    );
    const g = insertSql(
      "access_grants",
      grantColumns(org, user, by, "project.site.read.site", project, elevated),
    );
    await asAdmin(g.text, g.params);
    const ctx = { orgId: org, userId: user, projectIds: [] };
    expect(
      await rowsAs(
        "bricx_app",
        ctx,
        "SELECT site_id FROM bricx.project_membership_sites",
      ),
    ).toEqual([{ site_id: assigned }]);
    expect(
      (
        await rowsAs<{ id: string }>(
          "bricx_app",
          ctx,
          "SELECT id FROM bricx.sites",
        )
      )
        .map((r) => r.id)
        .sort(),
    ).toEqual([assigned, elevated].sort());
    // Another org's context sees none of it.
    expect(
      await rowsAs(
        "bricx_app",
        { orgId: await seedOrg(), userId: user, projectIds: [] },
        "SELECT id FROM bricx.sites",
      ),
    ).toEqual([]);
  });

  test("an assignment is ended, never deleted: bricx_app may UPDATE removed_at only", async () => {
    const user = await seedUser();
    const org = await seedOrg();
    const project = await seedProject(org, user);
    const site = await seedSite(org, project, user);
    const membership = await seedProjectMembership(org, project, user);
    const id = nextId();
    await asAdmin(
      `INSERT INTO bricx.project_membership_sites
         (id, org_id, project_id, project_membership_id, user_id, site_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [id, org, project, membership, user, site, NOW],
    );
    const ctx = { orgId: org, userId: user, projectIds: [project] };
    expect(
      await outcome(
        "bricx_app",
        ctx,
        "UPDATE bricx.project_membership_sites SET site_id = site_id WHERE id = $1",
        [id],
      ),
    ).toBe(DENIED);
    expect(
      await outcome(
        "bricx_app",
        ctx,
        "UPDATE bricx.project_membership_sites SET removed_at = $2 WHERE id = $1",
        [id, LATER],
      ),
    ).toBe("ok:1");
    expect(
      await outcome(
        "bricx_app",
        ctx,
        "DELETE FROM bricx.project_membership_sites WHERE id = $1",
        [id],
      ),
    ).toBe("ok:0");
    // One open row per membership and site.
    expect(
      await adminOutcome(
        `INSERT INTO bricx.project_membership_sites
           (id, org_id, project_id, project_membership_id, user_id, site_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [nextId(), org, project, membership, user, site, NOW],
      ),
    ).toBe(UNIQUE);
  });
});
