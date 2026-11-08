// P6-03 (ADR 0073; owner conditions C2, C3): migration 0010 and
// @bricx/db/region-configs against Postgres with the production journal,
// applied by the real migrator as bricx_owner.
// - bricx.region_configs (org.region_config): FORCE RLS; one organisation
//   never sees or writes another's rows; one row per (org, project), the
//   org row included (NULLS NOT DISTINCT); bricx_app may UPDATE only the
//   field columns and updated_at; nobody deletes; not published.
// - The CHECKs are the backstop behind the API's DTOs (C3): the org row
//   refuses currency, language, timezone and units (D8); a project row
//   refuses the idle timeout (D10); the idle timeout is 60..43 200 (C2);
//   every code and id has its shape; the payment list is bounded.
// - org_id references organizations; project_id has no FK until P6-05.
// P6-05 (ADR 0075 D8, D10; owner conditions C1, C2; dated note on ADR
// 0073): project_id references projects (org_id, id), so project rows
// name seeded projects (newProject()); a project row refuses currency,
// reporting currency and timezone (region_configs_project_fields: the
// project's own columns are that layer); readRegionLayers() is undefined
// for a project the transaction does not see, and carries the project's
// columns otherwise. The P6-03 assertions changed here are listed in the
// PR body.
// - readRegionLayers() reads the organisation and both rows in one query;
//   readSessionIdleSeconds() reads the org row's limit; writeRegionConfig()
//   inserts, then updates only the given fields.
import { randomUUID } from "node:crypto";
import {
  type BootstrappedPostgres,
  type Role,
  appDatabase,
  exampleValue,
  rolePasswordKeys,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { seedProject } from "@bricx/db-bootstrap/fixtures";
import { PgDialect } from "drizzle-orm/pg-core";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type Database, openDatabase } from "../src/database.js";
import { migrate } from "../src/migrate.js";
import {
  REGION_CONFIG_APP_COLUMNS,
  TENANT_TABLES,
  TENANT_UPDATE_COLUMNS,
} from "../src/rls.js";
import {
  readRegionConfig,
  readRegionLayers,
  readSessionIdleSeconds,
  writeRegionConfig,
} from "../src/region-configs.js";
import { sqlstateOf } from "../src/database.js";
import {
  type TxContext,
  contextStatement,
  validateTxContext,
} from "../src/tx.js";

const DENIED = "42501";
const FK = "23503";
const CHECK = "23514";
const UNIQUE = "23505";
const dialect = new PgDialect();
const NOW = "2026-11-07T12:00:00.000Z";
const LATER = "2026-11-07T13:00:00.000Z";

let pg18: BootstrappedPostgres;
let app: Database;
let n = 0;
const nextId = (): string => {
  n += 1;
  return `0199e1d1-${n.toString(16).padStart(4, "0")}-7000-8000-${randomUUID().slice(-12)}`;
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

/** A project of `org` (P6-05: the FK target of a project row), its id. */
async function newProject(org: string): Promise<string> {
  const id = nextId();
  await seedProject(asAdmin, org, id);
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
    [id, `rc-${id.slice(-12)}`, NOW],
  );
  return id;
}

const USER = "0199e1d1-ffff-7000-8000-000000000001";
const ctx = (orgId: string): TxContext => ({
  orgId,
  userId: USER,
  projectIds: [],
});

/** An INSERT of one row with `columns` (as bricx_app in `org`). */
const insertRow = (
  org: string,
  projectId: string | null,
  columns: Readonly<Record<string, unknown>> = {},
) => {
  const names = ["id", "org_id", "project_id", "created_at", "updated_at"];
  const values: unknown[] = [nextId(), org, projectId, NOW, NOW];
  for (const [name, value] of Object.entries(columns)) {
    names.push(name);
    values.push(value);
  }
  return {
    text: `INSERT INTO bricx.region_configs (${names.join(", ")})
           VALUES (${values.map((_, i) => `$${String(i + 1)}`).join(", ")})`,
    params: values,
  };
};

const tryInsert = (
  org: string,
  projectId: string | null,
  columns: Readonly<Record<string, unknown>> = {},
) => {
  const q = insertRow(org, projectId, columns);
  return outcome("bricx_app", ctx(org), q.text, q.params);
};

beforeAll(async () => {
  pg18 = await startPostgres();
  await migrate(urlFor("bricx_owner"));
  app = openDatabase(urlFor("bricx_app"));
}, 300_000);
afterAll(async () => {
  await app.close();
  await pg18.container.stop();
});

describe("migration 0010: bricx.region_configs", () => {
  test("registered: a tenant table of org.region_config with column-limited UPDATE", () => {
    expect(TENANT_TABLES["bricx.region_configs"]).toBe("org.region_config");
    expect(TENANT_UPDATE_COLUMNS["bricx.region_configs"]).toEqual(
      REGION_CONFIG_APP_COLUMNS,
    );
    expect(REGION_CONFIG_APP_COLUMNS).not.toContain("org_id");
    expect(REGION_CONFIG_APP_COLUMNS).not.toContain("project_id");
    expect(REGION_CONFIG_APP_COLUMNS).not.toContain("created_at");
    expect(REGION_CONFIG_APP_COLUMNS).not.toContain("id");
  });

  test("ENABLE + FORCE row level security; not published to PowerSync (D14)", async () => {
    expect(
      await asAdmin(
        `SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced
         FROM pg_class WHERE oid = 'bricx.region_configs'::regclass`,
      ),
    ).toEqual([{ enabled: true, forced: true }]);
    expect(
      await asAdmin(
        `SELECT tablename FROM pg_publication_tables
         WHERE schemaname = 'bricx' AND tablename = 'region_configs'`,
      ),
    ).toEqual([]);
  });

  test("RLS (Done-when 3): an organisation sees and writes only its own rows", async () => {
    const a = await seedOrg();
    const b = await seedOrg();
    const project = await newProject(b);
    const rowB = insertRow(b, null, { reporting_currency: "USD" });
    await asAdmin(rowB.text, rowB.params);
    const projB = insertRow(b, project, { language: "fr" });
    await asAdmin(projB.text, projB.params);
    expect(
      await outcome(
        "bricx_app",
        ctx(a),
        "SELECT id FROM bricx.region_configs WHERE org_id = $1",
        [b],
      ),
    ).toBe("ok:0");
    expect(
      await outcome(
        "bricx_app",
        ctx(b),
        "SELECT id FROM bricx.region_configs WHERE org_id = $1",
        [b],
      ),
    ).toBe("ok:2");
    // Writing another org's row: the INSERT policy refuses, an UPDATE matches nothing.
    expect(
      await outcome(
        "bricx_app",
        ctx(a),
        insertRow(b, await newProject(b)).text,
        insertRow(b, await newProject(b)).params,
      ),
    ).toBe(DENIED);
    expect(
      await outcome(
        "bricx_app",
        ctx(a),
        "UPDATE bricx.region_configs SET reporting_currency = 'EUR' WHERE org_id = $1",
        [b],
      ),
    ).toBe("ok:0");
    // Without a context nothing is visible.
    expect(
      await outcome(
        "bricx_app",
        undefined,
        "SELECT id FROM bricx.region_configs",
      ),
    ).toBe("ok:0");
  });

  test("one row per layer: a second org row or a second row for one project is 23505", async () => {
    const org = await seedOrg();
    const project = await newProject(org);
    const first = insertRow(org, null);
    await asAdmin(first.text, first.params);
    const proj = insertRow(org, project);
    await asAdmin(proj.text, proj.params);
    expect(await tryInsert(org, null)).toBe(UNIQUE);
    expect(await tryInsert(org, project)).toBe(UNIQUE);
    expect(await tryInsert(org, await newProject(org))).toBe("ok:1");
  });

  test("bricx_app may not change id, org_id, project_id or created_at (42501), and a DELETE removes nothing", async () => {
    const org = await seedOrg();
    const row = insertRow(org, await newProject(org));
    await asAdmin(row.text, row.params);
    for (const set of [
      `id = '${nextId()}'`,
      `org_id = '${org}'`,
      `project_id = '${await newProject(org)}'`,
      "created_at = now()",
    ]) {
      expect(
        await outcome(
          "bricx_app",
          ctx(org),
          `UPDATE bricx.region_configs SET ${set} WHERE org_id = $1`,
          [org],
        ),
        set,
      ).toBe(DENIED);
    }
    expect(
      await outcome(
        "bricx_app",
        ctx(org),
        "UPDATE bricx.region_configs SET units = 'metric', updated_at = now() WHERE org_id = $1",
        [org],
      ),
    ).toBe("ok:1");
    expect(
      await outcome(
        "bricx_app",
        ctx(org),
        "DELETE FROM bricx.region_configs WHERE org_id = $1",
        [org],
      ),
    ).toBe("ok:0");
    // No DELETE policy under FORCE: the DELETE matches no row; the row stays.
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM bricx.region_configs WHERE org_id = $1",
        [org],
      ),
    ).toEqual([{ n: 1 }]);
  });

  test("org_id references organizations (23503); project_id references a project of the same org (23503, P6-05)", async () => {
    const missing = nextId();
    const q = insertRow(missing, null);
    const admin = await pg18.admin();
    try {
      await expect(admin.query(q.text, q.params)).rejects.toMatchObject({
        code: FK,
      });
    } finally {
      await admin.end();
    }
    const org = await seedOrg();
    const other = await seedOrg();
    // P6-05 (ADR 0075 D10): an unknown project, or another org's, is 23503.
    const unknown = insertRow(org, nextId());
    const foreign = insertRow(org, await newProject(other));
    for (const q of [unknown, foreign]) {
      const owner = await pg18.admin();
      try {
        await expect(owner.query(q.text, q.params)).rejects.toMatchObject({
          code: FK,
          constraint: "region_configs_project_fk",
        });
      } finally {
        await owner.end();
      }
    }
    expect(await tryInsert(org, await newProject(org))).toBe("ok:1");
  });
});

describe("the CHECK backstop (C3, C2)", () => {
  test.each([
    ["language", "fr"],
    ["units", "us_customary"],
  ])(
    "the org row refuses %s (D8): 23514; a project row takes it",
    async (column, value) => {
      const org = await seedOrg();
      expect(await tryInsert(org, null, { [column]: value })).toBe(CHECK);
      expect(
        await tryInsert(org, await newProject(org), { [column]: value }),
      ).toBe("ok:1");
    },
  );

  // P6-05 (C1): currency and timezone are the project's own columns, so a
  // project row refuses them too (was: a project row takes them, P6-03);
  // the org row still refuses them (D8).
  test.each([
    ["currency", "USD"],
    ["timezone", "Africa/Lagos"],
  ])(
    "the org row refuses %s (D8) and so does a project row (P6-05, C1): 23514",
    async (column, value) => {
      const org = await seedOrg();
      expect(await tryInsert(org, null, { [column]: value })).toBe(CHECK);
      expect(
        await tryInsert(org, await newProject(org), { [column]: value }),
      ).toBe(CHECK);
    },
  );

  test("a project row refuses the reporting currency (P6-05, C1); the org row takes it", async () => {
    const org = await seedOrg();
    expect(
      await tryInsert(org, await newProject(org), {
        reporting_currency: "USD",
      }),
    ).toBe(CHECK);
    expect(await tryInsert(org, null, { reporting_currency: "USD" })).toBe(
      "ok:1",
    );
  });

  test("a project row refuses the idle timeout (D10); the org row takes it", async () => {
    const org = await seedOrg();
    expect(
      await tryInsert(org, await newProject(org), {
        session_idle_seconds: 900,
      }),
    ).toBe(CHECK);
    expect(await tryInsert(org, null, { session_idle_seconds: 900 })).toBe(
      "ok:1",
    );
  });

  test.each([
    [59, CHECK],
    [60, "ok:1"],
    [43_200, "ok:1"],
    [43_201, CHECK],
    [0, CHECK],
    [-1, CHECK],
  ])("idle %s seconds: %s (60..43 200, C2)", async (seconds, expected) => {
    const org = await seedOrg();
    expect(await tryInsert(org, null, { session_idle_seconds: seconds })).toBe(
      expected,
    );
  });

  test.each([
    ["reporting_currency", "usd"],
    ["reporting_currency", "USDX"],
    ["format_locale", "en_GB"],
    ["format_locale", `en-${"x".repeat(40)}`],
    ["tax_profile_id", "-tax"],
    ["tax_profile_id", "Tax"],
    ["accounting_adapter", "Xero"],
    ["accounting_adapter", "x"],
    ["rate_library", "rates library"],
  ])("%s = %j: 23514", async (column, value) => {
    const org = await seedOrg();
    expect(await tryInsert(org, null, { [column]: value })).toBe(CHECK);
  });

  test.each([
    [
      "seventeen adapters",
      Array.from({ length: 17 }, (_, i) => `a${String(i).padStart(2, "0")}`),
      CHECK,
    ],
    ["a bad id", ["M-Pesa"], CHECK],
    ["a NULL element", ["mpesa", null], CHECK],
    ["a comma inside an id", ["a,b"], CHECK],
    [
      "sixteen adapters",
      Array.from({ length: 16 }, (_, i) => `a${String(i).padStart(2, "0")}`),
      "ok:1",
    ],
    ["an empty list", [], "ok:1"],
  ])("payment adapters, %s: %s", async (_what, list, expected) => {
    const org = await seedOrg();
    expect(await tryInsert(org, null, { payment_adapters: list })).toBe(
      expected,
    );
  });
});

describe("@bricx/db/region-configs", () => {
  test("writeRegionConfig() inserts, then updates only the given fields; readRegionConfig() reads the layer", async () => {
    const org = await seedOrg();
    const first = await app.withTx(ctx(org), (tx) =>
      writeRegionConfig(tx, {
        id: nextId(),
        orgId: org,
        projectId: null,
        changes: { reportingCurrency: "USD", paymentAdapters: ["mpesa"] },
        now: NOW,
      }),
    );
    expect(first).toMatchObject({
      orgId: org,
      projectId: null,
      reportingCurrency: "USD",
      paymentAdapters: ["mpesa"],
      sessionIdleSeconds: null,
      createdAt: "2026-11-07T12:00:00.000000Z",
      updatedAt: "2026-11-07T12:00:00.000000Z",
    });
    const second = await app.withTx(ctx(org), (tx) =>
      writeRegionConfig(tx, {
        id: nextId(),
        orgId: org,
        projectId: null,
        changes: { sessionIdleSeconds: 900, reportingCurrency: null },
        now: LATER,
      }),
    );
    expect(second).toMatchObject({
      id: first.id,
      reportingCurrency: null,
      paymentAdapters: ["mpesa"],
      sessionIdleSeconds: 900,
      createdAt: first.createdAt,
      updatedAt: "2026-11-07T13:00:00.000000Z",
    });
    expect(
      await app.withTx(ctx(org), (tx) => readRegionConfig(tx, org, null)),
    ).toEqual(second);
    expect(
      await app.withTx(ctx(org), (tx) => readRegionConfig(tx, org, nextId())),
    ).toBeUndefined();
  });

  test("readRegionLayers(): the organisation's columns, its org row and one project's row; another project's row is not read", async () => {
    const org = await seedOrg();
    const project = await newProject(org);
    const other = await newProject(org);
    await app.withTx(ctx(org), async (tx) => {
      for (const [projectId, changes] of [
        [null, { formatLocale: "en-GB" }],
        [project, { language: "fr" }],
        [other, { language: "ar" }],
      ] as const) {
        await writeRegionConfig(tx, {
          id: nextId(),
          orgId: org,
          projectId,
          changes,
          now: NOW,
        });
      }
    });
    // P6-05: projects' RLS shows a project only inside the context's
    // projects (app.has_project), so the read runs with that project.
    const layers = await app.withTx(
      { ...ctx(org), projectIds: [project] },
      (tx) => readRegionLayers(tx, org, project),
    );
    expect(layers?.organization).toEqual({
      country: "SL",
      currency: "SLE",
      language: "en",
      timezone: "Africa/Freetown",
      units: "metric",
    });
    expect(layers?.org?.formatLocale).toBe("en-GB");
    expect(layers?.project).toMatchObject({
      projectId: project,
      language: "fr",
    });
    // P6-05 (D8): the project's own columns, in the same query.
    expect(layers?.projectColumns).toEqual({
      status: "draft",
      currency: "USD",
      reportingCurrency: "USD",
      timezone: "Africa/Freetown",
    });
    const orgOnly = await app.withTx(ctx(org), (tx) =>
      readRegionLayers(tx, org),
    );
    expect(orgOnly?.org?.formatLocale).toBe("en-GB");
    expect(orgOnly?.project).toBeUndefined();
    const unknownProject = await app.withTx(ctx(org), (tx) =>
      readRegionLayers(tx, org, nextId()),
    );
    // P6-05 (C2): a project the transaction does not see is no layers at
    // all, so the API answers 404 (was: the org's layers, P6-03).
    expect(unknownProject).toBeUndefined();
    // A real project outside the context's projects: the same (C5).
    const outside = await app.withTx(
      { ...ctx(org), projectIds: [other] },
      (tx) => readRegionLayers(tx, org, project),
    );
    expect(outside).toBeUndefined();
  });

  test("readRegionLayers() for an organisation with no rows gives its columns alone; another org's is undefined", async () => {
    const org = await seedOrg();
    const other = await seedOrg();
    const layers = await app.withTx(ctx(org), (tx) =>
      readRegionLayers(tx, org),
    );
    expect(layers).toEqual({
      organization: {
        country: "SL",
        currency: "SLE",
        language: "en",
        timezone: "Africa/Freetown",
        units: "metric",
      },
      org: undefined,
      project: undefined,
    });
    expect(
      await app.withTx(ctx(org), (tx) => readRegionLayers(tx, other)),
    ).toBeUndefined();
  });

  test("readSessionIdleSeconds(): the org row's limit, or null", async () => {
    const org = await seedOrg();
    expect(
      await app.withTx(ctx(org), (tx) => readSessionIdleSeconds(tx, org)),
    ).toBeNull();
    await app.withTx(ctx(org), (tx) =>
      writeRegionConfig(tx, {
        id: nextId(),
        orgId: org,
        projectId: null,
        changes: { sessionIdleSeconds: 600 },
        now: NOW,
      }),
    );
    expect(
      await app.withTx(ctx(org), (tx) => readSessionIdleSeconds(tx, org)),
    ).toBe(600);
  });

  test("the layer read is one query on the region_configs_layer index (C2)", async () => {
    const org = await seedOrg();
    const admin = await pg18.admin();
    let text: string;
    try {
      await admin.query("SET enable_seqscan = off");
      const plan = await admin.query(
        "EXPLAIN SELECT * FROM bricx.region_configs WHERE org_id = $1 AND (project_id IS NULL OR project_id = $2)",
        [org, nextId()],
      );
      text = JSON.stringify(plan.rows);
    } finally {
      await admin.end();
    }
    expect(text).toContain("region_configs_layer");
  });
});
