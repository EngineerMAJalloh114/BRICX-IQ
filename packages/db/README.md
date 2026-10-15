# @bricx/db

The only package that talks to Postgres (CLAUDE.md rule 4, [ADR 0040](../../docs/adr/0040-rehome-seed-framework.md)). P4-01 adds the minimal pool; P4-02 the Drizzle schema helpers and the migrator ([ADR 0052](../../docs/adr/0052-drizzle-migrations-own-migrator.md)); P4-03 `withTx()` ([ADR 0053](../../docs/adr/0053-request-context-withtx.md)); P4-04 the RLS framework ([ADR 0054](../../docs/adr/0054-rls-policy-framework.md)).

```ts
import { openDatabase, DatabaseUnavailableError } from "@bricx/db/database";

const db = openDatabase(config.database.url, { timeoutMs: 2000, maxConnections: 2 });
await db.ping(); // SELECT 1, or DatabaseUnavailableError
await db.close(); // idempotent
```

- The URL is a `Secret`: `reveal()` is called once, inside `openDatabase`, and nowhere else.
- Every failure is `DatabaseUnavailableError` with the fixed message `database unavailable` and no `cause`, so no URL, user, host or password can reach a log or a response.
- Connection and query (read) timeouts default to 2 s (`timeoutMs`, `queryTimeoutMs`); a pool that runs `withTx()` sets `queryTimeoutMs` above `statementTimeoutMs`. Idle-client errors are swallowed by the pool so a dropped connection cannot crash the process.

## Transactions (`withTx`, P4-03, [ADR 0053](../../docs/adr/0053-request-context-withtx.md))

```ts
const rows = await db.withTx({ orgId, userId, projectIds }, async (tx) => {
  const r = await tx.execute(sql`SELECT id FROM bricx.projects WHERE org_id = ${orgId}`);
  return r.rows;
});
```

- The only way to run SQL on the pool. One transaction as the pool's role (`bricx_app`), after `set_config(…, true)` of `app.org_id`, `app.user_id`, `app.project_ids` (a `{…}` array literal) and `statement_timeout` (30 s by default): nothing outlives the transaction.
- The context is validated and frozen at the call: canonical lower-case UUIDs, at most 1000 unique project ids. A bad one is `InvalidTxContextError` (names the field, never the value) before any connection.
- A connection or context failure is `DatabaseUnavailableError` and `fn` never runs; `fn`'s own error rolls back and is rethrown unchanged; a nested `withTx()` is `NestedTransactionError`.
- Never `sql.raw()` and never the client under `tx` (`$client`, `session.client`): Semgrep `bricx-raw-sql-outside-withtx`. In this package only `database.ts` and `migrate.ts` call `query()`/`connect()` (`bricx-db-query-outside-withtx`).
- After COMMIT a session reads these settings as `''`, not NULL: policies use `NULLIF(current_setting('app.org_id', true), '')`.

## Schema (`@bricx/db/schema`, P4-02)

```ts
import { bricx, id, orgId, createdAt, updatedAt, createdBy, version, deletedAt } from "@bricx/db/schema";

export const projects = bricx.table("projects", {
  id: id(), orgId: orgId(), createdAt: createdAt(), updatedAt: updatedAt(),
  createdBy: createdBy(), version: version(), deletedAt: deletedAt(),
});
```

- Tables go in `src/schema/tables.ts` (drizzle-kit's entry). Never export a `pgSchema()` from it: drizzle-kit would emit `CREATE SCHEMA`, which `bricx_owner` may not run.
- `id()` defaults to Postgres 18's `uuidv7()`; timestamps are `timestamptz` read as ISO strings.

## Migrations (`@bricx/db/migrate`, P4-02)

- `pnpm db:generate` writes `migrations/NNNN_name.sql`; review the SQL by hand ([runbook](../../docs/runbooks/migrations.md)).
- `pnpm db:migrate` applies them as `bricx_owner` (`MIGRATION_DATABASE_URL`), one transaction each, history in `bricx_migrations.applied`.
- `migrate()` refuses a non-owner role, and a removed, reordered or edited applied migration or a gap fill, before running anything. Errors are `MigrationError` codes; only `migration_failed` adds the statement number, SQLSTATE and server message.

## Row-level security (`@bricx/db/rls`, P4-04, [ADR 0054](../../docs/adr/0054-rls-policy-framework.md))

```bash
pnpm db:rls bricx.sites project.task   # prints the SQL to append to the migration that creates bricx.sites
```

- `enableTenantRls(table, resource)` turns `@bricx/permissions`' expressions for `resource` (`rlsPolicies()`, the data `rls.sql` renders) into ENABLE + FORCE ROW LEVEL SECURITY and one policy per command, each with an explicit TO clause (`POLICY_ROLES`): SELECT for `bricx_owner, bricx_app, bricx_readonly`; INSERT and UPDATE for `bricx_owner, bricx_app`. No DELETE policy. An append-only resource gets no UPDATE policy and `REVOKE UPDATE, DELETE … FROM bricx_app`.
- The policies call `app.current_org()`, `app.current_user_id()` and `app.has_project(uuid)` (migration `0000_rls_functions`): SECURITY INVOKER, NULLIF on every setting, so no context means no rows.
- Register every tenant table in `TENANT_TABLES`; `test/rls.int.test.ts` proves each one's policies against a real database, with the fixture tables in `test/fixtures/rls` (one per policy shape, never in the production journal).
- `migrate()` refuses any table in `bricx` or `app` without ENABLE + FORCE, and any materialized view or foreign table there (`tenant_rls_missing`), unless it is on `GLOBAL_TABLES` (empty; each entry needs an ADR line), and any SECURITY DEFINER function without a `search_path` (`definer_search_path`).
- `bricx_owner` is bound by FORCE: a data migration sets `app.org_id` itself (ADR 0054).
