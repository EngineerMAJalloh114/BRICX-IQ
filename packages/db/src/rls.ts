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
  "bricx.audit_events": "org.audit",
  // new-module: TENANT_TABLES (pnpm new-module adds a line above, P4-09)
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
  });

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

/**
 * Global tables that hold one row per user and no org_id (P5-02, phase
 * ruling D8, ADR 0062), with the helper that makes each one. They are not
 * on GLOBAL_TABLES: they keep ENABLE + FORCE. The RLS integration test
 * counts these among schema bricx's tables; packages/db/test/
 * users.int.test.ts proves their policies.
 */
export const USER_TABLES: Readonly<Record<string, string>> = Object.freeze({
  "bricx.users": "users",
});

// bricx.<name>, short enough that <name>_owner_insert fits in 63 bytes.
const USER_TABLE_NAME = /^bricx\.([a-z][a-z0-9_]{0,49})$/;

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
  const statements = [
    `-- RLS for ${table}: user table, own-row reads (enableUsersRls, ADR 0062)\nALTER TABLE ${on} ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE ${on} FORCE ROW LEVEL SECURITY;`,
    `CREATE POLICY "${name}_self_select" ON ${on} AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (id = app.current_user_id());`,
    `CREATE POLICY "${name}_owner_select" ON ${on} AS PERMISSIVE FOR SELECT TO bricx_owner USING (true);`,
    `CREATE POLICY "${name}_owner_insert" ON ${on} AS PERMISSIVE FOR INSERT TO bricx_owner WITH CHECK (true);`,
    `CREATE POLICY "${name}_owner_update" ON ${on} AS PERMISSIVE FOR UPDATE TO bricx_owner USING (true) WITH CHECK (true);`,
    `REVOKE ALL ON ${on} FROM bricx_app, bricx_readonly;`,
    `GRANT SELECT ON ${on} TO bricx_app, bricx_readonly;`,
  ];
  return statements.join(BREAKPOINT);
}
