// The global-table allowlist of the migrator's RLS guard (P4-04, ADR
// 0054; the guard itself is guardProblem() in migrate.ts, the one file
// besides database.ts that may query, per Semgrep's
// bricx-db-query-outside-withtx). Deny-by-default: every table in schemas
// bricx and app needs ENABLE and FORCE ROW LEVEL SECURITY unless it is
// listed here; a materialized view or foreign table (which cannot carry
// RLS) is refused unless it is listed here. Imports nothing, so the migrate entry point never loads
// @bricx/permissions.

/**
 * Tables that hold no tenant data and so carry no RLS (schema.table).
 * Ships empty; each entry needs a line in an ADR saying why it is global.
 */
export const GLOBAL_TABLES: readonly string[] = Object.freeze([]);

/**
 * Tenant tables whose resource is append-only (CLAUDE.md rule 2): the
 * guard refuses any migration after which bricx_app may UPDATE (any
 * column), DELETE or TRUNCATE one that exists (P4-09, ADR 0059, owner
 * condition 1). The guard reads the catalog; packages/db/test/rls.test.ts
 * keeps this list equal to the TENANT_TABLES and SYSTEM_TENANT_TABLES
 * entries whose resource @bricx/permissions marks append-only, plus
 * SYSTEM_APPEND_ONLY_TABLES (listed here because this file imports
 * nothing).
 */
export const APPEND_ONLY_TABLES: readonly string[] = Object.freeze([
  "bricx.audit_events",
  // P5-07 (ADR 0068): the SoD history, a system tenant table
  // (rls.ts SYSTEM_APPEND_ONLY_TABLES).
  "bricx.sod_actions",
]);

/**
 * Tables that may carry a policy for bricx_owner whose expression is
 * `true`, and the commands it may cover (P5-05, owner condition 4, ADR
 * 0066). FORCE binds bricx_owner, so such a policy is what lets a
 * SECURITY DEFINER function it owns read or write across every org: the
 * guard refuses one anywhere else (owner_policy_unlisted). bricx.users:
 * app.provision_user() (P5-02, ADR 0062). The four P5-05 tables: SELECT
 * only, for app.mfa_state() (rls.ts OWNER_READ_TABLES; test/rls.test.ts
 * keeps the two equal, since this file imports nothing). bricx.access_grants
 * (P5-06, ADR 0067): SELECT only, for app.mfa_state() v2 and
 * app.access_grants_due(); the expiry itself is written by bricx_app in
 * the grant's org, never by an owner policy.
 */
export const OWNER_POLICY_TABLES: Readonly<Record<string, readonly string[]>> =
  Object.freeze({
    "bricx.users": Object.freeze(["SELECT", "INSERT", "UPDATE"]),
    "bricx.roles": Object.freeze(["SELECT"]),
    "bricx.role_permissions": Object.freeze(["SELECT"]),
    "bricx.memberships": Object.freeze(["SELECT"]),
    "bricx.project_memberships": Object.freeze(["SELECT"]),
    "bricx.access_grants": Object.freeze(["SELECT"]),
  });
