// The RLS policy framework (P4-04, ADR 0054). enableTenantRls(table,
// resource) turns one resource's expressions from @bricx/permissions
// (rlsPolicies, the same data rls.sql renders) into the SQL a migration
// appends right after its CREATE TABLE: ENABLE and FORCE ROW LEVEL
// SECURITY, then one policy per command with an explicit TO clause. No
// DELETE policy, so a DELETE matches no row under FORCE; an append-only
// resource also gets no UPDATE policy and loses UPDATE and DELETE for
// bricx_app (CLAUDE.md rule 2), so those fail with 42501. `pnpm db:rls`
// prints this SQL; the migration is hand-reviewed (rule 12). The migrator
// refuses any table without ENABLE + FORCE (rls-guard.ts).
import {
  DEFAULT_MODEL,
  type RlsPolicy,
  rlsPolicies,
} from "@bricx/permissions/generate";

export type { RlsPolicy } from "@bricx/permissions/generate";

/**
 * Every tenant table and the resource it stores. The RLS integration test
 * proves the policies of every table listed here against a real database,
 * and that schema bricx holds no other table. P4-05 adds the first one;
 * pnpm new-module adds one per module (P4-09, ADR 0059).
 */
export const TENANT_TABLES: Readonly<Record<string, string>> = Object.freeze({
  // P6-02 (ADR 0072): the organisation itself; its tenant column is id.
  "bricx.organizations": "org.organization",
  "bricx.audit_events": "org.audit",
  "bricx.sessions": "org.session",
  // P5-05 (ADR 0066): roles and memberships, read by app.mfa_state()
  // through OWNER_READ_TABLES besides.
  "bricx.roles": "org.role",
  "bricx.role_permissions": "org.role",
  "bricx.memberships": "org.member",
  "bricx.project_memberships": "project.member",
  // P5-06 (ADR 0067): temporary elevations, read by app.mfa_state() v2
  // and app.access_grants_due() through OWNER_READ_TABLES besides.
  "bricx.access_grants": "org.access_grant",
  // P6-03 (ADR 0073): the org row and the project rows of the region
  // configuration.
  "bricx.region_configs": "org.region_config",
  // P6-05 (ADR 0075): projects, their sites, and the sites a project
  // membership is assigned to.
  "bricx.projects": "project.project",
  "bricx.sites": "project.site",
  "bricx.project_membership_sites": "project.member",
  // new-module: TENANT_TABLES (pnpm new-module adds a line above, P4-09)
});

/** An own-row entry: the user column, and whether bricx_app may UPDATE. */
export interface OwnRow {
  readonly column: string;
  readonly update: boolean;
}

/**
 * Tenant tables that also carry own-row policies (P5-03, owner condition
 * 3, ADR 0063): the user column whose rows bricx_app and bricx_readonly
 * may SELECT, and, with `update`, bricx_app UPDATE, whatever their org.
 * The migration appends enableOwnRowPolicies() after enableTenantRls();
 * the RLS integration test expects exactly those extra policies here.
 * P5-05 (ADR 0066): the membership tables are read by their user in any
 * org (the guard's membership lookup, GET /v1/me/memberships, the
 * project list) and never written by them: SELECT only.
 */
export const OWN_ROW_TABLES: Readonly<Record<string, OwnRow>> = Object.freeze({
  "bricx.sessions": Object.freeze({ column: "user_id", update: true }),
  "bricx.memberships": Object.freeze({ column: "user_id", update: false }),
  "bricx.project_memberships": Object.freeze({
    column: "user_id",
    update: false,
  }),
  // P5-06 (ADR 0067): a user reads their own elevations in any org (GET
  // /v1/me/access-grants, the P7 countdown); never writes them.
  "bricx.access_grants": Object.freeze({ column: "user_id", update: false }),
  // P6-05 (ADR 0075, C4): a user's site assignments, read by
  // DbGrantsSource before the project list exists; never written by them.
  "bricx.project_membership_sites": Object.freeze({
    column: "user_id",
    update: false,
  }),
});

/**
 * Tenant tables a user also reads through the rows that name them for
 * that user (P6-05, ADR 0075, C4): bricx.sites, whose sites a user is
 * assigned to (an open project_membership_sites row) or an open
 * elevation names (access_grants.site_id), in the context's org. The
 * migration appends enableAssignedSitePolicy(); the RLS integration test
 * expects exactly that extra policy here.
 */
export const ASSIGNED_SITE_TABLES: readonly string[] = Object.freeze([
  "bricx.sites",
]);

/**
 * Tenant tables with an owner-side SELECT policy over every row (P5-05,
 * owner condition 4, ADR 0066): what app.mfa_state(), SECURITY DEFINER
 * and owned by bricx_owner (which FORCE binds), reads across every org.
 * Each is listed by name in migration 0006, in ADR 0066 and, with SELECT
 * only, in the guard's OWNER_POLICY_TABLES (rls-guard.ts). bricx_app
 * gets nothing from them: the policies name bricx_owner alone.
 */
export const OWNER_READ_TABLES: readonly string[] = Object.freeze([
  "bricx.roles",
  "bricx.role_permissions",
  "bricx.memberships",
  "bricx.project_memberships",
  // P5-06 (ADR 0067): app.mfa_state() v2 and app.access_grants_due().
  "bricx.access_grants",
]);

/** The organisation columns bricx_app may UPDATE (P6-02, ADR 0072). */
export const ORGANIZATION_APP_COLUMNS: readonly string[] = Object.freeze([
  "legal_name",
  "country",
  "default_currency",
  "default_language",
  "timezone",
  "units",
  "brand_color",
  "logo_object_key",
  "updated_at",
  "archived_at",
]);

/** The region configuration columns bricx_app may UPDATE (P6-03, ADR 0073). */
export const REGION_CONFIG_APP_COLUMNS: readonly string[] = Object.freeze([
  "currency",
  "reporting_currency",
  "language",
  "timezone",
  "format_locale",
  "units",
  "tax_profile_id",
  "payment_adapters",
  "accounting_adapter",
  "rate_library",
  "session_idle_seconds",
  "updated_at",
]);

/** The project columns bricx_app may UPDATE (P6-05, ADR 0075). */
export const PROJECT_APP_COLUMNS: readonly string[] = Object.freeze([
  "code",
  "name",
  "client_name",
  "status",
  "currency",
  "reporting_currency",
  "timezone",
  "start_date",
  "end_date",
  "contract_value_minor",
  "contract_value_currency",
  "updated_at",
  "archived_at",
]);

/** The site columns bricx_app may UPDATE (P6-05, ADR 0075). */
export const SITE_APP_COLUMNS: readonly string[] = Object.freeze([
  "name",
  "geom",
  "address",
  "geofence_radius_m",
  "updated_at",
  "archived_at",
]);

/** A site assignment is ended, never changed (P6-05, ADR 0075). */
export const PROJECT_MEMBERSHIP_SITE_APP_COLUMNS: readonly string[] =
  Object.freeze(["removed_at"]);

/**
 * Tenant tables whose rows bricx_app may UPDATE only in the listed columns
 * (PR #71 review, amendment 1, ADR 0067): the migration appends
 * restrictTenantUpdate() after enableTenantRls(), so bricx_app keeps the
 * tenant UPDATE policy but loses the table-level privilege. A trigger in
 * the same migration makes the columns set-once and every other column
 * fixed. The RLS integration test expects no table-level UPDATE here.
 */
export const TENANT_UPDATE_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = Object.freeze({
  "bricx.access_grants": Object.freeze([
    "revoked_at",
    "revoked_by",
    "expired_at",
  ]),
  // P6-02 (ADR 0072): the editable columns and the set-once archive; never
  // slug, data_region or created_at (trigger organizations_immutable binds
  // every role besides).
  "bricx.organizations": Object.freeze(ORGANIZATION_APP_COLUMNS),
  // P6-03 (ADR 0073): the fields and updated_at; never id, org_id,
  // project_id or created_at.
  "bricx.region_configs": Object.freeze(REGION_CONFIG_APP_COLUMNS),
  // P6-05 (ADR 0075): never id, org_id, project_id, created_by or
  // created_at (the guard triggers bind every role besides).
  "bricx.projects": Object.freeze(PROJECT_APP_COLUMNS),
  "bricx.sites": Object.freeze(SITE_APP_COLUMNS),
  "bricx.project_membership_sites": Object.freeze(
    PROJECT_MEMBERSHIP_SITE_APP_COLUMNS,
  ),
});

/**
 * The roles each policy applies to (an explicit TO clause on every
 * policy). bricx_owner is listed because FORCE binds it too: a data
 * migration sets its own context (ADR 0054). powersync_repl is never
 * listed: it has BYPASSRLS, and sync streams scope what it replicates.
 */
export const POLICY_ROLES = Object.freeze({
  select: Object.freeze(["bricx_owner", "bricx_app", "bricx_readonly"]),
  insert: Object.freeze(["bricx_owner", "bricx_app"]),
  update: Object.freeze(["bricx_owner", "bricx_app"]),
});

/** Statement separator drizzle-kit's migrations use. */
const BREAKPOINT = "\n--> statement-breakpoint\n";

// bricx.<name>: lower case, so it never needs quoting, and short enough
// that <name>_select fits Postgres's 63-byte identifier limit.
const TABLE_NAME = /^bricx\.([a-z][a-z0-9_]{0,55})$/;

const policies: ReadonlyMap<string, RlsPolicy> = new Map(
  rlsPolicies(DEFAULT_MODEL).map((p) => [p.subject, p]),
);

/** The RLS expressions of `resource` (a permissions subject type). */
export function tenantPolicy(resource: string): RlsPolicy {
  const policy = policies.get(resource);
  if (policy === undefined) {
    throw new Error("enableTenantRls: unknown resource");
  }
  return policy;
}

/**
 * The SQL that makes `table` (bricx.<name>) a tenant table for
 * `resource`, as drizzle-kit migration statements.
 */
export function enableTenantRls(table: string, resource: string): string {
  const name = TABLE_NAME.exec(table)?.[1];
  if (name === undefined) {
    throw new Error("enableTenantRls: invalid table name");
  }
  const policy = tenantPolicy(resource);
  const on = `"bricx"."${name}"`;
  const to = (roles: readonly string[]) => roles.join(", ");
  const statements = [
    `-- RLS for ${table}: resource ${resource} (pnpm db:rls, ADR 0054)\nALTER TABLE ${on} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${on} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY "${name}_select" ON ${on} AS PERMISSIVE FOR SELECT TO ${to(POLICY_ROLES.select)} USING (${policy.select});`,
    `CREATE POLICY "${name}_insert" ON ${on} AS PERMISSIVE FOR INSERT TO ${to(POLICY_ROLES.insert)} WITH CHECK (${policy.insert});`,
    policy.update === undefined
      ? `REVOKE UPDATE, DELETE ON ${on} FROM bricx_app;`
      : `CREATE POLICY "${name}_update" ON ${on} AS PERMISSIVE FOR UPDATE TO ${to(POLICY_ROLES.update)} USING (${policy.update}) WITH CHECK (${policy.update});`,
  ];
  return statements.join(BREAKPOINT);
}

/**
 * The SQL that narrows bricx_app's UPDATE on tenant table `table` to
 * `columns` (PR #71 review, amendment 1, ADR 0067): REVOKE the table-level
 * privilege, GRANT the column-level one. Never the id or the org column,
 * so a row neither changes identity nor moves to another org.
 */
export function restrictTenantUpdate(
  table: string,
  columns: readonly string[],
): string {
  const name = TABLE_NAME.exec(table)?.[1];
  if (name === undefined) {
    throw new Error("restrictTenantUpdate: invalid table name");
  }
  if (
    columns.length === 0 ||
    new Set(columns).size !== columns.length ||
    columns.some((c) => !COLUMN_NAME.test(c) || c === "id" || c === "org_id")
  ) {
    throw new Error("restrictTenantUpdate: invalid columns");
  }
  const on = `"bricx"."${name}"`;
  return [
    `-- bricx_app may UPDATE only the listed columns of ${table} (restrictTenantUpdate, ADR 0067)\nREVOKE UPDATE ON ${on} FROM bricx_app;`,
    `GRANT UPDATE (${columns.join(", ")}) ON ${on} TO bricx_app;`,
  ].join(BREAKPOINT);
}

/**
 * Tenant tables written by the system, not by a permissions resource
 * (P4-06, ADR 0056), with the helper that makes each one. Every row still
 * carries org_id and the table is ENABLE + FORCE; its policies are its
 * own. The RLS integration test counts these among schema bricx's tables;
 * packages/db/test/outbox.int.test.ts proves the outbox's policies.
 */
export const SYSTEM_TENANT_TABLES: Readonly<Record<string, string>> =
  Object.freeze({
    "bricx.outbox": "outbox",
    "bricx.idempotency_keys": "idempotency",
    // P5-07 (ADR 0068, owner condition 2): the SoD history.
    "bricx.sod_actions": "sod",
  });

/**
 * The append-only tables among SYSTEM_TENANT_TABLES (CLAUDE.md rule 2):
 * no catalogue resource marks them, so they are listed here, and
 * test/rls.test.ts keeps rls-guard.ts's APPEND_ONLY_TABLES equal to the
 * append-only resources' tables plus these.
 */
export const SYSTEM_APPEND_ONLY_TABLES: readonly string[] = Object.freeze([
  "bricx.sod_actions",
]);

/** The only outbox columns bricx_relay may UPDATE (ADR 0056, D12). */
export const OUTBOX_RELAY_COLUMNS = Object.freeze([
  "published_at",
  "attempts",
  "next_attempt_at",
  "last_error",
  "dead_at",
] as const);

// bricx.<name>, short enough that <name>_relay_select fits in 63 bytes.
const OUTBOX_TABLE_NAME = /^bricx\.([a-z][a-z0-9_]{0,49})$/;

/**
 * The SQL that makes `table` (bricx.<name>) the transactional outbox:
 * ENABLE and FORCE ROW LEVEL SECURITY; bricx_app may INSERT rows for its
 * own org (columns id, org_id, topic, payload) and nothing else, so its
 * inserts use no RETURNING and no ON CONFLICT; bricx_relay may SELECT
 * every row and UPDATE the delivery columns only (policies TO bricx_relay
 * USING (true): the role stays NOBYPASSRLS). No DELETE policy for anyone,
 * and no policy for bricx_owner or bricx_readonly: under FORCE they see
 * nothing. ENABLE and FORCE come first, as for enableTenantRls().
 */
export function enableOutboxRls(table: string): string {
  const name = OUTBOX_TABLE_NAME.exec(table)?.[1];
  if (name === undefined) {
    throw new Error("enableOutboxRls: invalid table name");
  }
  const on = `"bricx"."${name}"`;
  const statements = [
    `-- RLS for ${table}: system tenant table (enableOutboxRls, ADR 0056)\nALTER TABLE ${on} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${on} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY "${name}_app_insert" ON ${on} AS PERMISSIVE FOR INSERT TO bricx_app WITH CHECK (org_id = app.current_org());`,
    `CREATE POLICY "${name}_relay_select" ON ${on} AS PERMISSIVE FOR SELECT TO bricx_relay USING (true);`,
    `CREATE POLICY "${name}_relay_update" ON ${on} AS PERMISSIVE FOR UPDATE TO bricx_relay USING (true) WITH CHECK (true);`,
    `REVOKE ALL ON ${on} FROM bricx_app, bricx_readonly;`,
    `GRANT INSERT (id, org_id, topic, payload) ON ${on} TO bricx_app;`,
    `GRANT SELECT ON ${on} TO bricx_relay;`,
    `GRANT UPDATE (${OUTBOX_RELAY_COLUMNS.join(", ")}) ON ${on} TO bricx_relay;`,
  ];
  return statements.join(BREAKPOINT);
}

/**
 * The SQL that makes `table` (bricx.<name>) the idempotency-key store
 * (P4-07, ADR 0057, owner condition 2): ENABLE and FORCE ROW LEVEL
 * SECURITY; bricx_app may SELECT, INSERT and UPDATE rows of its own org
 * AND its own user (org_id = app.current_org() AND user_id =
 * app.current_user_id()), and nothing else: no DELETE policy, no policy
 * for bricx_owner, bricx_readonly or bricx_relay (under FORCE they see
 * nothing). The claim is INSERT ... ON CONFLICT DO UPDATE, which needs
 * SELECT and UPDATE on the conflicting row. Expired rows are reused in
 * place; the purge is P13's.
 */
// bricx.<name>, short enough that <name>_app_update fits in 63 bytes.
const IDEMPOTENCY_TABLE_NAME = /^bricx\.([a-z][a-z0-9_]{0,48})$/;

export function enableIdempotencyRls(table: string): string {
  const name = IDEMPOTENCY_TABLE_NAME.exec(table)?.[1];
  if (name === undefined) {
    throw new Error("enableIdempotencyRls: invalid table name");
  }
  const on = `"bricx"."${name}"`;
  const scope =
    "(org_id = app.current_org() AND user_id = app.current_user_id())";
  const statements = [
    `-- RLS for ${table}: system tenant table (enableIdempotencyRls, ADR 0057)\nALTER TABLE ${on} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${on} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY "${name}_app_select" ON ${on} AS PERMISSIVE FOR SELECT TO bricx_app USING ${scope};`,
    `CREATE POLICY "${name}_app_insert" ON ${on} AS PERMISSIVE FOR INSERT TO bricx_app WITH CHECK ${scope};`,
    `CREATE POLICY "${name}_app_update" ON ${on} AS PERMISSIVE FOR UPDATE TO bricx_app USING ${scope} WITH CHECK ${scope};`,
    `REVOKE ALL ON ${on} FROM bricx_app, bricx_readonly;`,
    `GRANT SELECT, INSERT, UPDATE ON ${on} TO bricx_app;`,
  ];
  return statements.join(BREAKPOINT);
}

// bricx.<name>, short enough that <name>_app_insert fits in 63 bytes.
const SOD_TABLE_NAME = /^bricx\.([a-z][a-z0-9_]{0,48})$/;

/**
 * The SQL that makes `table` (bricx.<name>) the SoD history (P5-07, ADR
 * 0068, owner condition 2): ENABLE and FORCE ROW LEVEL SECURITY; bricx_app
 * may SELECT and INSERT rows of its own org (org_id = app.current_org()),
 * bricx_readonly may SELECT them; nothing else: no UPDATE or DELETE policy
 * or grant, no policy for bricx_owner, bricx_relay or powersync_repl. The
 * migration adds the append-only statement triggers (bricx.append_only(),
 * the owner included) and the generated conflict trigger by hand.
 */
export function enableSodActionsRls(table: string): string {
  const name = SOD_TABLE_NAME.exec(table)?.[1];
  if (name === undefined) {
    throw new Error("enableSodActionsRls: invalid table name");
  }
  const on = `"bricx"."${name}"`;
  const org = "(org_id = app.current_org())";
  const statements = [
    `-- RLS for ${table}: system tenant table (enableSodActionsRls, ADR 0068)\nALTER TABLE ${on} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${on} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY "${name}_select" ON ${on} AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING ${org};`,
    `CREATE POLICY "${name}_app_insert" ON ${on} AS PERMISSIVE FOR INSERT TO bricx_app WITH CHECK ${org};`,
    `REVOKE ALL ON ${on} FROM bricx_app, bricx_readonly;`,
    `GRANT SELECT, INSERT ON ${on} TO bricx_app;`,
    `GRANT SELECT ON ${on} TO bricx_readonly;`,
  ];
  return statements.join(BREAKPOINT);
}

/**
 * Global tables that hold one row per user and no org_id (P5-02, phase
 * ruling D8, ADR 0062), with the helper that makes each one. They are not
 * on GLOBAL_TABLES: they keep ENABLE + FORCE. The RLS integration test
 * counts these among schema bricx's tables; packages/db/test/
 * users.int.test.ts proves their policies.
 */
export const USER_TABLES: Readonly<Record<string, string>> = Object.freeze({
  "bricx.users": "users",
  "bricx.devices": "devices",
  // P6-02 (ADR 0072, owner ruling R4, condition C2): a user's attempts to
  // create an organisation, own rows only (enableOwnedRls).
  "bricx.org_create_attempts": "org_create_attempts",
});

/** The create-attempt columns bricx_app may UPDATE (P6-02, ADR 0072). */
export const ORG_CREATE_ATTEMPT_APP_COLUMNS: readonly string[] = Object.freeze([
  "state",
  "settled_at",
]);

/** The device columns bricx_app may UPDATE (P5-03, owner condition 1). */
export const DEVICE_APP_COLUMNS: readonly string[] = Object.freeze([
  "name",
  "last_seen_at",
  "revoked_at",
]);

// bricx.<name>, short enough that <name>_owner_insert fits in 63 bytes.
const USER_TABLE_NAME = /^bricx\.([a-z][a-z0-9_]{0,49})$/;
// A plain column name, as the migrations write them: never quoted.
const COLUMN_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** What bricx_app may write on an owned table (enableOwnedRls). */
export interface OwnedWrites {
  /** The columns bricx_app may UPDATE on its own rows; never the owner column. */
  readonly update: readonly string[];
}

/**
 * The statements of an owned table (P5-02's users, P5-03's devices):
 * ENABLE and FORCE, the own-row policies, then the grants. `extra` are
 * policies placed right after the own-row SELECT (the users table's
 * owner-side ones).
 */
function ownedStatements(
  helper: string,
  header: string,
  name: string,
  column: string,
  writes: OwnedWrites | undefined,
  extra: readonly string[],
): string {
  const on = `"bricx"."${name}"`;
  const self = `${column} = app.current_user_id()`;
  const statements = [
    `-- RLS for bricx.${name}: ${header} (${helper})\nALTER TABLE ${on} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${on} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY "${name}_self_select" ON ${on} AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (${self});`,
    ...extra,
    ...(writes === undefined
      ? []
      : [
          `CREATE POLICY "${name}_self_insert" ON ${on} AS PERMISSIVE FOR INSERT TO bricx_app WITH CHECK (${self});`,
          `CREATE POLICY "${name}_self_update" ON ${on} AS PERMISSIVE FOR UPDATE TO bricx_app USING (${self}) WITH CHECK (${self});`,
        ]),
    `REVOKE ALL ON ${on} FROM bricx_app, bricx_readonly;`,
    `GRANT SELECT ON ${on} TO bricx_app, bricx_readonly;`,
    ...(writes === undefined
      ? []
      : [
          `GRANT INSERT ON ${on} TO bricx_app;`,
          `GRANT UPDATE (${writes.update.join(", ")}) ON ${on} TO bricx_app;`,
        ]),
  ];
  return statements.join(BREAKPOINT);
}

/**
 * The SQL that makes `table` (bricx.<name>) an owned table (P5-03, ADR
 * 0063): ENABLE and FORCE ROW LEVEL SECURITY; bricx_app and bricx_readonly
 * SELECT the rows whose `column` is app.current_user_id(), in any org;
 * with `writes`, bricx_app may also INSERT such rows and UPDATE the listed
 * columns of them, and never the owner column, so a row never moves to
 * another user. No DELETE or TRUNCATE for anyone, no policy for
 * bricx_owner (FORCE binds it: a data migration sets its own context).
 */
export function enableOwnedRls(
  table: string,
  column: string,
  writes?: OwnedWrites,
): string {
  const name = USER_TABLE_NAME.exec(table)?.[1];
  if (name === undefined) {
    throw new Error("enableOwnedRls: invalid table name");
  }
  if (!COLUMN_NAME.test(column)) {
    throw new Error("enableOwnedRls: invalid column");
  }
  if (
    writes !== undefined &&
    (writes.update.length === 0 ||
      new Set(writes.update).size !== writes.update.length ||
      writes.update.some((c) => c === column || !COLUMN_NAME.test(c)))
  ) {
    throw new Error("enableOwnedRls: invalid update columns");
  }
  return ownedStatements(
    "enableOwnedRls, ADR 0063",
    "user table, own rows",
    name,
    column,
    writes,
    [],
  );
}

// bricx.<name>, short enough that <name>_own_select fits in 63 bytes.
const OWN_ROW_TABLE_NAME = /^bricx\.([a-z][a-z0-9_]{0,51})$/;

/** Options of enableOwnRowPolicies(). */
export interface OwnRowOptions {
  /** Also an own-row UPDATE for bricx_app (default true; P5-05: false). */
  readonly update?: boolean;
}

/**
 * The own-row policies a tenant table carries besides enableTenantRls()'s
 * (P5-03, owner condition 3, ADR 0063): bricx_app and bricx_readonly
 * SELECT, and (unless `update` is false) bricx_app UPDATE, the rows whose
 * `column` is app.current_user_id(), whatever their org. Grants nothing:
 * the tenant grants already cover SELECT and UPDATE.
 */
export function enableOwnRowPolicies(
  table: string,
  column: string,
  options: OwnRowOptions = {},
): string {
  const name = OWN_ROW_TABLE_NAME.exec(table)?.[1];
  if (name === undefined) {
    throw new Error("enableOwnRowPolicies: invalid table name");
  }
  if (!COLUMN_NAME.test(column)) {
    throw new Error("enableOwnRowPolicies: invalid column");
  }
  const on = `"bricx"."${name}"`;
  const self = `${column} = app.current_user_id()`;
  return [
    `-- Own-row policies for ${table}: ${self} in any org (enableOwnRowPolicies, ADR 0063)\nCREATE POLICY "${name}_own_select" ON ${on} AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (${self});`,
    ...(options.update === false
      ? []
      : [
          `CREATE POLICY "${name}_own_update" ON ${on} AS PERMISSIVE FOR UPDATE TO bricx_app USING (${self}) WITH CHECK (${self});`,
        ]),
  ].join(BREAKPOINT);
}

/**
 * The extra SELECT policy of an ASSIGNED_SITE_TABLES table (P6-05, ADR
 * 0075, C4): bricx_app and bricx_readonly read, in the context's org, the
 * sites the current user is assigned to (an open project_membership_sites
 * row) or an open elevation names (access_grants.site_id), whatever their
 * project list. Both subqueries run under those tables' own-row policies.
 * Grants nothing.
 */
export function enableAssignedSitePolicy(table: string): string {
  if (!ASSIGNED_SITE_TABLES.includes(table)) {
    throw new Error("enableAssignedSitePolicy: not an assigned-site table");
  }
  const name = table.slice("bricx.".length);
  const on = `"bricx"."${name}"`;
  return `-- Assigned-site read for ${table}: the user's assigned and elevated sites (enableAssignedSitePolicy, ADR 0075)\nCREATE POLICY "${name}_assigned_select" ON ${on} AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (org_id = app.current_org() AND (EXISTS (SELECT 1 FROM bricx.project_membership_sites a WHERE a.org_id = ${name}.org_id AND a.site_id = ${name}.id AND a.user_id = app.current_user_id() AND a.removed_at IS NULL) OR EXISTS (SELECT 1 FROM bricx.access_grants g WHERE g.org_id = ${name}.org_id AND g.site_id = ${name}.id AND g.user_id = app.current_user_id() AND g.revoked_at IS NULL AND g.expired_at IS NULL)));`;
}

// bricx.<name>, short enough that <name>_owner_select fits in 63 bytes.
const OWNER_READ_TABLE_NAME = /^bricx\.([a-z][a-z0-9_]{0,49})$/;

/**
 * The owner-side SELECT policy of an OWNER_READ_TABLES table (P5-05,
 * owner condition 4, ADR 0066): bricx_owner reads every row, so the
 * SECURITY DEFINER app.mfa_state() it owns can judge a user across every
 * org. Nothing for any other role, no write, no grant. The migrator's
 * guard refuses such a policy on a table (or for a command) not listed
 * in OWNER_POLICY_TABLES.
 */
export function enableOwnerReadPolicy(table: string): string {
  const name = OWNER_READ_TABLE_NAME.exec(table)?.[1];
  if (name === undefined) {
    throw new Error("enableOwnerReadPolicy: invalid table name");
  }
  return `-- Owner read policy for ${table}: every row, for app.mfa_state() (enableOwnerReadPolicy, ADR 0066; listed in OWNER_POLICY_TABLES)\nCREATE POLICY "${name}_owner_select" ON "bricx"."${name}" AS PERMISSIVE FOR SELECT TO bricx_owner USING (true);`;
}

/**
 * The SQL that makes `table` (bricx.<name>) a user table: ENABLE and
 * FORCE ROW LEVEL SECURITY; bricx_app and bricx_readonly may SELECT only
 * the row whose id is app.current_user_id() and write nothing (SELECT is
 * their only grant); bricx_owner, which FORCE binds too, may SELECT,
 * INSERT and UPDATE every row, so the SECURITY DEFINER provisioning
 * function it owns can insert and upsert (for architect review). No
 * DELETE policy for anyone.
 */
export function enableUsersRls(table: string): string {
  const name = USER_TABLE_NAME.exec(table)?.[1];
  if (name === undefined) {
    throw new Error("enableUsersRls: invalid table name");
  }
  const on = `"bricx"."${name}"`;
  return ownedStatements(
    "enableUsersRls, ADR 0062",
    "user table, own-row reads",
    name,
    "id",
    undefined,
    [
      `CREATE POLICY "${name}_owner_select" ON ${on} AS PERMISSIVE FOR SELECT TO bricx_owner USING (true);`,
      `CREATE POLICY "${name}_owner_insert" ON ${on} AS PERMISSIVE FOR INSERT TO bricx_owner WITH CHECK (true);`,
      `CREATE POLICY "${name}_owner_update" ON ${on} AS PERMISSIVE FOR UPDATE TO bricx_owner USING (true) WITH CHECK (true);`,
    ],
  );
}
