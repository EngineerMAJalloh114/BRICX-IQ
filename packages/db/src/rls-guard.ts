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
 * entries whose resource @bricx/permissions marks append-only (listed
 * here because this file imports nothing).
 */
export const APPEND_ONLY_TABLES: readonly string[] = Object.freeze([
  "bricx.audit_events",
]);
