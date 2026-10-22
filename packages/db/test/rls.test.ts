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
import {
  APPEND_ONLY_TABLES,
  GLOBAL_TABLES,
  OWNER_POLICY_TABLES,
} from "../src/rls-guard.js";
import {
  DEVICE_APP_COLUMNS,
  OUTBOX_RELAY_COLUMNS,
  OWNER_READ_TABLES,
  OWN_ROW_TABLES,
  POLICY_ROLES,
  SYSTEM_TENANT_TABLES,
  TENANT_TABLES,
  USER_TABLES,
  enableIdempotencyRls,
  enableOutboxRls,
  enableOwnRowPolicies,
  enableOwnerReadPolicy,
  enableOwnedRls,
  enableTenantRls,
  enableUsersRls,
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

describe("enableOutboxRls(table) (P4-06, ADR 0056)", () => {
  it("ENABLE, FORCE; app INSERT for its own org; relay SELECT and UPDATE; column grants", () => {
    expect(enableOutboxRls("bricx.outbox")).toBe(
      [
        '-- RLS for bricx.outbox: system tenant table (enableOutboxRls, ADR 0056)\nALTER TABLE "bricx"."outbox" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "bricx"."outbox" FORCE ROW LEVEL SECURITY;',
        'CREATE POLICY "outbox_app_insert" ON "bricx"."outbox" AS PERMISSIVE FOR INSERT TO bricx_app WITH CHECK (org_id = app.current_org());',
        'CREATE POLICY "outbox_relay_select" ON "bricx"."outbox" AS PERMISSIVE FOR SELECT TO bricx_relay USING (true);',
        'CREATE POLICY "outbox_relay_update" ON "bricx"."outbox" AS PERMISSIVE FOR UPDATE TO bricx_relay USING (true) WITH CHECK (true);',
        'REVOKE ALL ON "bricx"."outbox" FROM bricx_app, bricx_readonly;',
        'GRANT INSERT (id, org_id, topic, payload) ON "bricx"."outbox" TO bricx_app;',
        'GRANT SELECT ON "bricx"."outbox" TO bricx_relay;',
        'GRANT UPDATE (published_at, attempts, next_attempt_at, last_error, dead_at) ON "bricx"."outbox" TO bricx_relay;',
      ].join(BP),
    );
  });

  it("the relay's UPDATE columns are exactly the delivery columns, frozen", () => {
    expect(OUTBOX_RELAY_COLUMNS).toEqual([
      "published_at",
      "attempts",
      "next_attempt_at",
      "last_error",
      "dead_at",
    ]);
    expect(Object.isFrozen(OUTBOX_RELAY_COLUMNS)).toBe(true);
  });

  it("never a DELETE or ALL policy, never a policy for the owner or readonly", () => {
    const out = enableOutboxRls("bricx.outbox");
    expect(out).not.toMatch(/FOR (DELETE|ALL)\b/);
    for (const statement of out.split(BP)) {
      if (!statement.startsWith("CREATE POLICY")) continue;
      expect(statement).not.toMatch(/bricx_owner|bricx_readonly/);
    }
  });

  it.each([
    ["no schema", "outbox"],
    ["another schema", "public.outbox"],
    ["SQL", "bricx.o; DROP TABLE x"],
    ["a name too long for its policy names", `bricx.${"t".repeat(51)}`],
  ])("refuses a table name with %s, without echoing it", (_what, table) => {
    const error = errorOf(() => enableOutboxRls(table));
    expect(error.message).toBe("enableOutboxRls: invalid table name");
  });

  it("accepts the longest table name whose policy names fit in 63 bytes", () => {
    expect(() => enableOutboxRls(`bricx.${"t".repeat(50)}`)).not.toThrow();
  });
});

describe("enableOwnedRls(table, column, writes?) (P5-03, ADR 0063)", () => {
  const SELF = "user_id = app.current_user_id()";

  it("devices: ENABLE, FORCE; own-row SELECT for app and readonly, own-row INSERT and UPDATE for app; SELECT, INSERT and a column-level UPDATE grant", () => {
    expect(
      enableOwnedRls("bricx.devices", "user_id", {
        update: DEVICE_APP_COLUMNS,
      }),
    ).toBe(
      [
        '-- RLS for bricx.devices: user table, own rows (enableOwnedRls, ADR 0063)\nALTER TABLE "bricx"."devices" ENABLE ROW LEVEL SECURITY;',
        'ALTER TABLE "bricx"."devices" FORCE ROW LEVEL SECURITY;',
        `CREATE POLICY "devices_self_select" ON "bricx"."devices" AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (${SELF});`,
        `CREATE POLICY "devices_self_insert" ON "bricx"."devices" AS PERMISSIVE FOR INSERT TO bricx_app WITH CHECK (${SELF});`,
        `CREATE POLICY "devices_self_update" ON "bricx"."devices" AS PERMISSIVE FOR UPDATE TO bricx_app USING (${SELF}) WITH CHECK (${SELF});`,
        'REVOKE ALL ON "bricx"."devices" FROM bricx_app, bricx_readonly;',
        'GRANT SELECT ON "bricx"."devices" TO bricx_app, bricx_readonly;',
        'GRANT INSERT ON "bricx"."devices" TO bricx_app;',
        'GRANT UPDATE (name, last_seen_at, revoked_at) ON "bricx"."devices" TO bricx_app;',
      ].join(BP),
    );
  });

  it("the device columns bricx_app may UPDATE are exactly name, last_seen_at and revoked_at (owner condition 1), frozen", () => {
    expect(DEVICE_APP_COLUMNS).toEqual(["name", "last_seen_at", "revoked_at"]);
    expect(Object.isFrozen(DEVICE_APP_COLUMNS)).toBe(true);
  });

  it("without writes: own-row SELECT only, and SELECT the only grant", () => {
    const out = enableOwnedRls("bricx.fx_owned", "owner_id");
    expect(out.split(BP)).toHaveLength(5);
    expect(out).not.toMatch(/INSERT|UPDATE/);
    expect(out).toContain("(owner_id = app.current_user_id())");
    expect(out).toContain(
      'GRANT SELECT ON "bricx"."fx_owned" TO bricx_app, bricx_readonly;',
    );
  });

  it("never a DELETE or ALL policy, never TRUNCATE or DELETE granted, never a policy for the owner", () => {
    const out = enableOwnedRls("bricx.devices", "user_id", {
      update: ["name"],
    });
    expect(out).not.toMatch(/FOR (DELETE|ALL)\b/);
    expect(out).not.toMatch(/GRANT[^;]*(DELETE|TRUNCATE)/);
    for (const statement of out.split(BP)) {
      if (!statement.startsWith("CREATE POLICY")) continue;
      expect(statement).not.toMatch(/bricx_owner/);
    }
  });

  it("enableUsersRls(table) is the owned shape plus the owner-side policies, unchanged since P5-02 (ADR 0062)", () => {
    const out = enableUsersRls("bricx.users");
    expect(out.split(BP)).toEqual([
      '-- RLS for bricx.users: user table, own-row reads (enableUsersRls, ADR 0062)\nALTER TABLE "bricx"."users" ENABLE ROW LEVEL SECURITY;',
      'ALTER TABLE "bricx"."users" FORCE ROW LEVEL SECURITY;',
      'CREATE POLICY "users_self_select" ON "bricx"."users" AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (id = app.current_user_id());',
      'CREATE POLICY "users_owner_select" ON "bricx"."users" AS PERMISSIVE FOR SELECT TO bricx_owner USING (true);',
      'CREATE POLICY "users_owner_insert" ON "bricx"."users" AS PERMISSIVE FOR INSERT TO bricx_owner WITH CHECK (true);',
      'CREATE POLICY "users_owner_update" ON "bricx"."users" AS PERMISSIVE FOR UPDATE TO bricx_owner USING (true) WITH CHECK (true);',
      'REVOKE ALL ON "bricx"."users" FROM bricx_app, bricx_readonly;',
      'GRANT SELECT ON "bricx"."users" TO bricx_app, bricx_readonly;',
    ]);
  });

  it.each([
    ["no schema", "devices", "user_id"],
    ["another schema", "public.devices", "user_id"],
    ["SQL in the table", "bricx.d; DROP TABLE x", "user_id"],
    [
      "a name too long for its policy names",
      `bricx.${"t".repeat(51)}`,
      "user_id",
    ],
  ])(
    "refuses a table name with %s, without echoing it",
    (_what, table, column) => {
      const error = errorOf(() => enableOwnedRls(table, column));
      expect(error.message).toBe("enableOwnedRls: invalid table name");
    },
  );

  it.each([
    ["empty", ""],
    ["upper case", "User_Id"],
    ["SQL", "user_id = user_id OR true"],
    ["too long", "c".repeat(64)],
  ])(
    "refuses an owner column that is %s, without echoing it",
    (_what, column) => {
      const error = errorOf(() => enableOwnedRls("bricx.devices", column));
      expect(error.message).toBe("enableOwnedRls: invalid column");
    },
  );

  it.each([
    ["empty", []],
    [
      "the owner column (bricx_app may never move a row to another user)",
      ["name", "user_id"],
    ],
    ["a duplicate", ["name", "name"]],
    ["SQL", ["name) TO public; --"]],
    ["too long", ["c".repeat(64)]],
  ])(
    "refuses an UPDATE column list with %s, without echoing it",
    (_what, update) => {
      const error = errorOf(() =>
        enableOwnedRls("bricx.devices", "user_id", { update }),
      );
      expect(error.message).toBe("enableOwnedRls: invalid update columns");
    },
  );
});

describe("enableOwnRowPolicies(table, column) (P5-03, owner condition 3, ADR 0063)", () => {
  const SELF = "user_id = app.current_user_id()";

  it("sessions: an own-row SELECT for app and readonly and an own-row UPDATE for app, in any org", () => {
    expect(enableOwnRowPolicies("bricx.sessions", "user_id")).toBe(
      [
        `-- Own-row policies for bricx.sessions: ${SELF} in any org (enableOwnRowPolicies, ADR 0063)\nCREATE POLICY "sessions_own_select" ON "bricx"."sessions" AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (${SELF});`,
        `CREATE POLICY "sessions_own_update" ON "bricx"."sessions" AS PERMISSIVE FOR UPDATE TO bricx_app USING (${SELF}) WITH CHECK (${SELF});`,
      ].join(BP),
    );
  });

  // P5-05 (ADR 0066): memberships and project memberships are read by
  // their user in any org (the membership lookup and GET /me/memberships)
  // but never written by them: the SELECT policy alone.
  it("{ update: false }: the own-row SELECT only (P5-05)", () => {
    expect(
      enableOwnRowPolicies("bricx.memberships", "user_id", { update: false }),
    ).toBe(
      `-- Own-row policies for bricx.memberships: ${SELF} in any org (enableOwnRowPolicies, ADR 0063)\nCREATE POLICY "memberships_own_select" ON "bricx"."memberships" AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (${SELF});`,
    );
    expect(
      enableOwnRowPolicies("bricx.sessions", "user_id", { update: true }),
    ).toBe(enableOwnRowPolicies("bricx.sessions", "user_id"));
  });

  it("never mentions the org, never INSERT, DELETE or ALL, never the owner, and grants nothing", () => {
    const out = enableOwnRowPolicies("bricx.sessions", "user_id");
    expect(out).not.toMatch(
      /org_id|current_org|FOR (INSERT|DELETE|ALL)\b|bricx_owner|GRANT|REVOKE/,
    );
  });

  it.each([
    ["no schema", "sessions", "user_id"],
    ["SQL in the table", "bricx.s; DROP TABLE x", "user_id"],
    [
      "a name too long for its policy names",
      `bricx.${"t".repeat(53)}`,
      "user_id",
    ],
  ])(
    "refuses a table name with %s, without echoing it",
    (_what, table, column) => {
      const error = errorOf(() => enableOwnRowPolicies(table, column));
      expect(error.message).toBe("enableOwnRowPolicies: invalid table name");
    },
  );

  it("accepts the longest table name whose policy names fit in 63 bytes", () => {
    const out = enableOwnRowPolicies(`bricx.${"t".repeat(52)}`, "user_id");
    expect(out).toContain(`"${"t".repeat(52)}_own_select"`);
    expect(`${"t".repeat(52)}_own_select`).toHaveLength(63);
  });

  it("refuses an invalid column, without echoing it", () => {
    const error = errorOf(() =>
      enableOwnRowPolicies("bricx.sessions", "user_id OR true"),
    );
    expect(error.message).toBe("enableOwnRowPolicies: invalid column");
  });
});

// P5-05 (owner condition 4, ADR 0066): app.mfa_state() is SECURITY DEFINER
// and runs as bricx_owner, which FORCE binds; it reads every org's roles
// and memberships through one owner-side SELECT policy per table, listed
// by name in the migration, in the ADR and in the guard's allowlist.
describe("enableOwnerReadPolicy(table) (P5-05, owner condition 4, ADR 0066)", () => {
  it("one SELECT policy for bricx_owner over every row, nothing else", () => {
    expect(enableOwnerReadPolicy("bricx.roles")).toBe(
      '-- Owner read policy for bricx.roles: every row, for app.mfa_state() (enableOwnerReadPolicy, ADR 0066; listed in OWNER_POLICY_TABLES)\nCREATE POLICY "roles_owner_select" ON "bricx"."roles" AS PERMISSIVE FOR SELECT TO bricx_owner USING (true);',
    );
    const out = enableOwnerReadPolicy("bricx.roles");
    expect(out.split(BP)).toHaveLength(1);
    expect(out).not.toMatch(
      /bricx_app|bricx_readonly|bricx_relay|FOR (INSERT|UPDATE|DELETE|ALL)\b|GRANT|REVOKE/,
    );
  });

  it.each([
    ["no schema", "roles"],
    ["SQL in the table", "bricx.r; DROP TABLE x"],
    ["a name too long for its policy name", `bricx.${"t".repeat(51)}`],
  ])("refuses a table name with %s, without echoing it", (_what, table) => {
    const error = errorOf(() => enableOwnerReadPolicy(table));
    expect(error.message).toBe("enableOwnerReadPolicy: invalid table name");
  });

  it("accepts the longest table name whose policy name fits in 63 bytes", () => {
    expect(enableOwnerReadPolicy(`bricx.${"t".repeat(50)}`)).toContain(
      `"${"t".repeat(50)}_owner_select"`,
    );
    expect(`${"t".repeat(50)}_owner_select`).toHaveLength(63);
  });

  it("OWNER_READ_TABLES is exactly the four P5-05 tables plus bricx.access_grants (P5-06), each a registered tenant table whose migration holds the policy verbatim", async () => {
    expect([...OWNER_READ_TABLES]).toEqual([
      "bricx.roles",
      "bricx.role_permissions",
      "bricx.memberships",
      "bricx.project_memberships",
      "bricx.access_grants",
    ]);
    expect(Object.isFrozen(OWNER_READ_TABLES)).toBe(true);
    const text = (await readMigrations(MIGRATIONS_DIR))
      .flatMap((m) => m.statements)
      .join(BP);
    for (const table of OWNER_READ_TABLES) {
      expect(TENANT_TABLES).toHaveProperty([table]);
      expect(text, table).toContain(enableOwnerReadPolicy(table));
    }
  });

  it("OWNER_POLICY_TABLES (the guard's allowlist; rls-guard.ts imports nothing) is users with its three owner policies plus OWNER_READ_TABLES with SELECT only", () => {
    expect(OWNER_POLICY_TABLES).toEqual({
      "bricx.users": ["SELECT", "INSERT", "UPDATE"],
      "bricx.roles": ["SELECT"],
      "bricx.role_permissions": ["SELECT"],
      "bricx.memberships": ["SELECT"],
      "bricx.project_memberships": ["SELECT"],
      // P5-06 (ADR 0067): read by app.mfa_state() v2 and
      // app.access_grants_due(); SELECT only, never a write.
      "bricx.access_grants": ["SELECT"],
    });
    expect(Object.isFrozen(OWNER_POLICY_TABLES)).toBe(true);
    const readOnly = Object.entries(OWNER_POLICY_TABLES)
      .filter(([, cmds]) => cmds.length === 1 && cmds[0] === "SELECT")
      .map(([table]) => table);
    expect(readOnly).toEqual([...OWNER_READ_TABLES]);
    // The users table's three come from enableUsersRls(), one per command.
    const users = enableUsersRls("bricx.users");
    for (const cmd of OWNER_POLICY_TABLES["bricx.users"] ?? []) {
      expect(users).toContain(
        `CREATE POLICY "users_owner_${cmd.toLowerCase()}" ON "bricx"."users" AS PERMISSIVE FOR ${cmd} TO bricx_owner`,
      );
    }
  });
});

describe("the registry and the allowlist", () => {
  it("TENANT_TABLES maps bricx tables to known resources: bricx.audit_events (P4-05), bricx.sessions (P5-03), the roles and memberships tables (P5-05), bricx.access_grants (P5-06)", () => {
    expect(TENANT_TABLES).toEqual({
      "bricx.audit_events": "org.audit",
      "bricx.sessions": "org.session",
      "bricx.roles": "org.role",
      "bricx.role_permissions": "org.role",
      "bricx.memberships": "org.member",
      "bricx.project_memberships": "project.member",
      "bricx.access_grants": "org.access_grant",
      // new-module: TENANT_TABLES (pnpm new-module adds a line above, P4-09)
    });
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

  it("SYSTEM_TENANT_TABLES lists bricx.outbox (P4-06) and bricx.idempotency_keys (P4-07), whose migrations hold the helpers' output verbatim", async () => {
    expect(SYSTEM_TENANT_TABLES).toEqual({
      "bricx.outbox": "outbox",
      "bricx.idempotency_keys": "idempotency",
    });
    expect(Object.isFrozen(SYSTEM_TENANT_TABLES)).toBe(true);
    const text = (await readMigrations(MIGRATIONS_DIR))
      .flatMap((m) => m.statements)
      .join(BP);
    expect(text).toContain(enableOutboxRls("bricx.outbox"));
    expect(text).toContain(enableIdempotencyRls("bricx.idempotency_keys"));
    for (const table of Object.keys(SYSTEM_TENANT_TABLES)) {
      expect(TENANT_TABLES).not.toHaveProperty([table]);
    }
  });

  it("USER_TABLES lists bricx.users (P5-02) and bricx.devices (P5-03); OWN_ROW_TABLES lists bricx.sessions (read and update), the two membership tables (read only, P5-05) and bricx.access_grants (read only, P5-06) on user_id; the migrations hold each helper's output verbatim", async () => {
    expect(USER_TABLES).toEqual({
      "bricx.users": "users",
      "bricx.devices": "devices",
    });
    expect(OWN_ROW_TABLES).toEqual({
      "bricx.sessions": { column: "user_id", update: true },
      "bricx.memberships": { column: "user_id", update: false },
      "bricx.project_memberships": { column: "user_id", update: false },
      "bricx.access_grants": { column: "user_id", update: false },
    });
    for (const own of Object.values(OWN_ROW_TABLES)) {
      expect(Object.isFrozen(own)).toBe(true);
    }
    expect(Object.isFrozen(USER_TABLES)).toBe(true);
    expect(Object.isFrozen(OWN_ROW_TABLES)).toBe(true);
    const text = (await readMigrations(MIGRATIONS_DIR))
      .flatMap((m) => m.statements)
      .join(BP);
    expect(text).toContain(enableUsersRls("bricx.users"));
    expect(text).toContain(
      enableOwnedRls("bricx.devices", "user_id", {
        update: DEVICE_APP_COLUMNS,
      }),
    );
    for (const [table, own] of Object.entries(OWN_ROW_TABLES)) {
      expect(TENANT_TABLES).toHaveProperty([table]);
      expect(text, table).toContain(
        enableOwnRowPolicies(table, own.column, { update: own.update }),
      );
      if (!own.update) {
        expect(text, table).not.toContain(
          `"${table.slice("bricx.".length)}_own_update"`,
        );
      }
    }
    for (const table of Object.keys(USER_TABLES)) {
      expect(TENANT_TABLES).not.toHaveProperty([table]);
      expect(SYSTEM_TENANT_TABLES).not.toHaveProperty([table]);
    }
  });

  it("APPEND_ONLY_TABLES is exactly the registered tables whose resource is append-only (P4-09 condition 1)", () => {
    // The migrator's guard reads APPEND_ONLY_TABLES (rls-guard.ts imports
    // nothing, so migrate never loads @bricx/permissions); this test keeps
    // it equal to what the registries and the permissions model say.
    const appendOnly = new Set(
      rlsPolicies(DEFAULT_MODEL)
        .filter((p) => p.appendOnly)
        .map((p) => p.subject),
    );
    const derived = Object.entries({
      ...TENANT_TABLES,
      ...SYSTEM_TENANT_TABLES,
    })
      .filter(([, resource]) => appendOnly.has(resource))
      .map(([table]) => table)
      .sort();
    expect(derived).toEqual(["bricx.audit_events"]);
    expect([...APPEND_ONLY_TABLES].sort()).toEqual(derived);
    expect(Object.isFrozen(APPEND_ONLY_TABLES)).toBe(true);
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
