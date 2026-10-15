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
 * and that schema bricx holds no other table. Empty until P4-05 adds the
 * first one.
 */
export const TENANT_TABLES: Readonly<Record<string, string>> = Object.freeze(
  {},
);

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
