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
