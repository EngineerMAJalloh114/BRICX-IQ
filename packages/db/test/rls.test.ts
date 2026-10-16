// P4-04 (ADR 0054): enableTenantRls(table, resource) turns @bricx/permissions'
// RLS expressions into the SQL a migration appends after its CREATE TABLE.
// The global-table allowlist ships empty; the registry lists the tenant
// tables (P4-05: audit_events), each with the helper's output in its
// production migration; the production journal never holds a fixture
// migration.
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MODEL, rlsPolicies } from "@bricx/permissions/generate";
import { describe, expect, it } from "vitest";
import { readMigrations } from "../src/journal.js";
import { MIGRATIONS_DIR } from "../src/migrate.js";
import { GLOBAL_TABLES } from "../src/rls-guard.js";
import {
  POLICY_ROLES,
  TENANT_TABLES,
  enableTenantRls,
  tenantPolicy,
} from "../src/rls.js";
import { FIXTURE_DIR, FIXTURE_TABLES, tagsOf } from "./rls-fixtures.js";

const BP = "\n--> statement-breakpoint\n";
const packageDir = path.resolve(import.meta.dirname, "..");
const repoRoot = path.resolve(packageDir, "../..");

const errorOf = (run: () => unknown): Error => {
  try {
    run();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error("expected an Error");
};

describe("enableTenantRls(table, resource)", () => {
  it("org.member: ENABLE, FORCE, then SELECT, INSERT and UPDATE policies, each with its roles", () => {
    expect(enableTenantRls("bricx.fx", "org.member")).toBe(
      [
        '-- RLS for bricx.fx: resource org.member (pnpm db:rls, ADR 0054)\nALTER TABLE "bricx"."fx" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "bricx"."fx" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "fx_select" ON "bricx"."fx" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org());',
        'CREATE POLICY "fx_insert" ON "bricx"."fx" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org());',
        'CREATE POLICY "fx_update" ON "bricx"."fx" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());',
      ].join(BP),
    );
  });

  it("append-only (org.audit): no UPDATE policy; UPDATE and DELETE revoked from bricx_app (condition 1, rule 2)", () => {
    const out = enableTenantRls("bricx.fx", "org.audit");
    expect(out).not.toContain("FOR UPDATE");
    expect(out.split(BP).at(-1)).toBe(
      'REVOKE UPDATE, DELETE ON "bricx"."fx" FROM bricx_app;',
    );
    expect(out.match(/REVOKE/g)).toHaveLength(1);
  });

  it("the roles per policy (condition 4): SELECT owner, app, readonly; INSERT and UPDATE owner, app", () => {
    expect(POLICY_ROLES).toEqual({
      select: ["bricx_owner", "bricx_app", "bricx_readonly"],
      insert: ["bricx_owner", "bricx_app"],
      update: ["bricx_owner", "bricx_app"],
    });
    expect(Object.isFrozen(POLICY_ROLES)).toBe(true);
  });

  it("for every resource: the policies carry rls.sql's expressions, an explicit TO clause, and never DELETE or ALL", () => {
    const policies = rlsPolicies(DEFAULT_MODEL);
    expect(policies.length).toBeGreaterThan(0);
    for (const p of policies) {
      const out = enableTenantRls("bricx.fx", p.subject);
      const statements = out.split(BP);
      expect(statements[0], p.subject).toMatch(/ENABLE ROW LEVEL SECURITY;$/);
      expect(statements[1], p.subject).toBe(
        'ALTER TABLE "bricx"."fx" FORCE ROW LEVEL SECURITY;',
      );
      const creates = statements.filter((s) => s.startsWith("CREATE POLICY"));
      expect(creates, p.subject).toHaveLength(p.appendOnly ? 2 : 3);
      for (const c of creates) {
        expect(c, p.subject).toMatch(
          / AS PERMISSIVE FOR (SELECT|INSERT|UPDATE) TO bricx_[a-z_]+(, bricx_[a-z_]+)* (USING|WITH CHECK) \(/,
        );
      }
      expect(out, p.subject).toContain(`USING (${p.select});`);
      expect(out, p.subject).toContain(`WITH CHECK (${p.insert});`);
      if (p.update !== undefined) {
        expect(out, p.subject).toContain(
          `USING (${p.update}) WITH CHECK (${p.update});`,
        );
      }
      expect(out, p.subject).not.toMatch(/FOR (DELETE|ALL)\b/);
      expect(tenantPolicy(p.subject)).toEqual(p);
    }
  });

  it.each([
    ["no schema", "tasks"],
    ["another schema", "public.tasks"],
    ["the app schema", "app.tasks"],
    ["a quoted name", 'bricx."tasks"'],
    ["upper case", "bricx.Tasks"],
    ["a space", "bricx.my tasks"],
    ["SQL", "bricx.t; DROP TABLE x"],
    ["a name too long for its policy names", `bricx.${"t".repeat(57)}`],
  ])("refuses a table name with %s, without echoing it", (_what, table) => {
    const error = errorOf(() => enableTenantRls(table, "org.member"));
    expect(error.message).toBe("enableTenantRls: invalid table name");
    expect(error.message).not.toContain(table);
  });

  it("accepts the longest table name whose policy names fit in 63 bytes", () => {
    expect(() =>
      enableTenantRls(`bricx.${"t".repeat(56)}`, "org.member"),
    ).not.toThrow();
  });

  it("refuses an unknown resource, without echoing it", () => {
    const error = errorOf(() => enableTenantRls("bricx.fx", "org.secret"));
    expect(error.message).toBe("enableTenantRls: unknown resource");
    expect(() => tenantPolicy("org.secret")).toThrow(
      "enableTenantRls: unknown resource",
    );
  });
});

describe("the registry and the allowlist", () => {
  it("TENANT_TABLES maps bricx tables to known resources: bricx.audit_events (P4-05)", () => {
    expect(TENANT_TABLES).toEqual({ "bricx.audit_events": "org.audit" });
    expect(Object.isFrozen(TENANT_TABLES)).toBe(true);
    for (const [table, resource] of Object.entries(TENANT_TABLES)) {
      expect(() => enableTenantRls(table, resource)).not.toThrow();
    }
  });

  it("each registered table's production migration holds enableTenantRls()'s output verbatim", async () => {
    const statements = (await readMigrations(MIGRATIONS_DIR)).flatMap(
      (m) => m.statements,
    );
    const text = statements.join(BP);
    for (const [table, resource] of Object.entries(TENANT_TABLES)) {
      expect(text, table).toContain(enableTenantRls(table, resource));
    }
  });

  it("GLOBAL_TABLES ships empty; each entry needs an ADR line (condition 2)", () => {
    expect(GLOBAL_TABLES).toEqual([]);
    expect(Object.isFrozen(GLOBAL_TABLES)).toBe(true);
  });
});

describe("fixture migrations (condition 3)", () => {
  it("every fixture table's RLS SQL is the helper's output, verbatim", async () => {
    const sql = await readFile(
      path.join(FIXTURE_DIR, "9000_fx_rls_shapes.sql"),
      "utf8",
    );
    const entries = Object.entries(FIXTURE_TABLES);
    expect(entries).toHaveLength(6);
    // Each block sits between breakpoints; the last one ends the file.
    const blocks = `${sql.trimEnd()}${BP}`;
    for (const [table, resource] of entries) {
      expect(blocks, table).toContain(
        `${BP}${enableTenantRls(table, resource)}${BP}`,
      );
    }
  });

  it("cover every policy shape: org keyed by id, org, append-only, project, site with created_by, and project.project", () => {
    const shapes = Object.values(FIXTURE_TABLES).map((r) => {
      const p = tenantPolicy(r);
      return `${p.level}:${p.columns.org}:${p.columns.project ?? "-"}:${String(p.createdBy)}:${String(p.appendOnly)}`;
    });
    expect(shapes.sort()).toEqual(
      [
        "org:id:-:false:false",
        "org:org_id:-:false:false",
        "org:org_id:-:false:true",
        "project:org_id:project_id:false:false",
        "site:org_id:project_id:true:false",
        "project:org_id:id:true:false",
      ].sort(),
    );
  });

  it("live in a test-only folder, and the production journal holds none of them", async () => {
    expect(path.relative(packageDir, FIXTURE_DIR)).toBe(
      path.join("test", "fixtures", "rls"),
    );
    expect(path.relative(packageDir, MIGRATIONS_DIR)).toBe("migrations");
    const fixtureTags = await tagsOf(FIXTURE_DIR);
    expect(fixtureTags).toEqual(["9000_fx_rls_shapes", "9001_fx_functions"]);
    const production = await readMigrations(MIGRATIONS_DIR);
    expect(production.map((m) => m.tag)).toContain("0000_rls_functions");
    for (const m of production) {
      expect(fixtureTags).not.toContain(m.tag);
      expect(m.tag).not.toMatch(/fx_/);
      for (const statement of m.statements) {
        expect(statement).not.toMatch(/\bfx_/);
      }
    }
    const files = await readdir(MIGRATIONS_DIR);
    for (const tag of fixtureTags) expect(files).not.toContain(`${tag}.sql`);
  });
});

describe("no package cycle", () => {
  it("@bricx/permissions does not depend on or import @bricx/db", async () => {
    const permissions = path.join(repoRoot, "packages/permissions");
    const manifest = await readFile(
      path.join(permissions, "package.json"),
      "utf8",
    );
    expect(manifest).not.toContain('"@bricx/db');
    const files = await readdir(path.join(permissions, "src"), {
      recursive: true,
    });
    let scanned = 0;
    for (const file of files) {
      if (!file.endsWith(".ts")) continue;
      const code = await readFile(path.join(permissions, "src", file), "utf8");
      expect(code, file).not.toMatch(/["']@bricx\/db/);
      scanned += 1;
    }
    expect(scanned).toBeGreaterThan(5);
  });
});

describe("pnpm db:rls <table> <resource>", () => {
  const dbRls = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [path.join(packageDir, "scripts/rls.ts"), ...args],
      {
        encoding: "utf8",
      },
    );

  it("is the root script, running this package's scripts/rls.ts", async () => {
    const root: unknown = JSON.parse(
      await readFile(path.join(repoRoot, "package.json"), "utf8"),
    );
    expect(root).toMatchObject({
      scripts: { "db:rls": "node packages/db/scripts/rls.ts" },
    });
  });

  it("prints enableTenantRls()'s SQL and exits 0", () => {
    const run = dbRls("bricx.sites", "project.task");
    expect(run.status).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toBe(
      `${enableTenantRls("bricx.sites", "project.task")}\n`,
    );
  });

  it.each([
    [["bricx.sites"], 2, "usage: pnpm db:rls <bricx.table> <resource>\n"],
    [
      ["bricx.sites", "org.member", "x"],
      2,
      "usage: pnpm db:rls <bricx.table> <resource>\n",
    ],
    [
      ["sites", "org.member"],
      1,
      "db:rls: enableTenantRls: invalid table name\n",
    ],
    [
      ["bricx.sites", "org.secret"],
      1,
      "db:rls: enableTenantRls: unknown resource\n",
    ],
  ])("refuses %j with exit %i and prints no SQL", (args, status, stderr) => {
    const run = dbRls(...args);
    expect(run.status).toBe(status);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(stderr);
  });
});
