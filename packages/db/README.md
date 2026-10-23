# @bricx/db

The only package that talks to Postgres (CLAUDE.md rule 4, [ADR 0040](../../docs/adr/0040-rehome-seed-framework.md)). P4-01 adds the minimal pool; P4-02 the Drizzle schema helpers and the migrator ([ADR 0052](../../docs/adr/0052-drizzle-migrations-own-migrator.md)); P4-03 `withTx()` ([ADR 0053](../../docs/adr/0053-request-context-withtx.md)); P4-04 the RLS framework ([ADR 0054](../../docs/adr/0054-rls-policy-framework.md)); P4-06 the outbox and the relay's transaction ([ADR 0056](../../docs/adr/0056-transactional-outbox.md)).

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
- Register every tenant table in `TENANT_TABLES`; `test/rls.int.test.ts` proves each one's policies against a real database, with the fixture tables in `test/fixtures/rls` (one per policy shape, never in the production journal). It seeds foreign-key parents first (`users` → `devices` → `sessions`, `SEED_PARENTS`) and proves a child seeded first is refused.
- Per-user global tables (`USER_TABLES`: `bricx.users`, `bricx.devices`; P5-02 and P5-03, [ADR 0063](../../docs/adr/0063-devices-sessions.md)) use `enableOwnedRls(table, column, { update })`: ENABLE + FORCE, own rows only (`column = app.current_user_id()`), SELECT for `bricx_app` and `bricx_readonly`, INSERT and a column-level `GRANT UPDATE (…)` for `bricx_app` when `update` is given, no DELETE. `enableUsersRls()` is the `users` shape of it.
- `enableOwnRowPolicies(table, column)` adds own-row SELECT and UPDATE policies (any org) to a tenant table; `OWN_ROW_TABLES` registers them (`bricx.sessions`, so a user sees and ends their own sessions across organisations). Triggers `bricx.forbid_unrevoke()` and `bricx.sessions_immutable()` in migration `0005` keep `revoked_at` final and the session keys fixed.
- `migrate()` refuses any table in `bricx` or `app` without ENABLE + FORCE, and any materialized view or foreign table there (`tenant_rls_missing`), unless it is on `GLOBAL_TABLES` (empty; each entry needs an ADR line), and any SECURITY DEFINER function without a `search_path` (`definer_search_path`).
- `bricx_owner` is bound by FORCE: a data migration sets `app.org_id` itself (ADR 0054).

## Outbox (`@bricx/db/outbox`, P4-06, [ADR 0056](../../docs/adr/0056-transactional-outbox.md))

- `insertOutbox(tx, topic, payload, id, { notBefore })` writes one row in a `withTx()` transaction as `bricx_app`: the topic must be in `OUTBOX_TOPICS`, the id a UUIDv7, the payload a bounded object of registered keys holding ids (never personal data); the org is the transaction's. No RETURNING: `bricx_app` may only INSERT. Refusals are `OutboxError` with a code.
- `claimOutboxBatch`, `markOutboxPublished` and `markOutboxFailed` are the relay's statements, run as `bricx_relay`.
- `openRelayDatabase(url).withRelayTx(fn)` (`@bricx/db/database`) is the documented exception to `withTx()`: it asserts `current_user = 'bricx_relay'`, sets a 30 s `statement_timeout` and no tenant context. Semgrep allows it only in `apps/worker/src/relay/`, `apps/worker/src/mfa/` and `apps/worker/src/access/`.
- `enableOutboxRls()` (`@bricx/db/rls`) emits the outbox's policies; the table is in `SYSTEM_TENANT_TABLES`, not `TENANT_TABLES`.

## Temporary elevations (`@bricx/db/access-grants`, P5-06, [ADR 0067](../../docs/adr/0067-temporary-elevated-access.md))

- `accessGrantsDue(tx, limit)`: the sweep's cross-org read, `app.access_grants_due()` (SECURITY DEFINER, EXECUTE `bricx_relay` only), inside `withRelayTx()`; open grants past `expires_at`, oldest first, at most `MAX_DUE` 1000. It writes nothing.
- `expireAccessGrant(tx, grantId)`: inside `withTx()` as `bricx_app` in the grant's organisation; sets `expired_at = now()` (the database clock) on an open grant past `expires_at` and answers the row before and after, else the row's state (`pending`, `open`, `revoked`, `expired`) and no change; `undefined` for a row the transaction cannot see. The caller records the audit event and the `users.mfa_check` row in the same transaction. The reason is never read here.
- `bricx.outbox.not_before`: a row with it is claimed with `delayMs` from the database clock (0 when unset or past) and published by the relay as a delayed job.

## Audit recorder (`@bricx/db/audit`, P4-05 moved here at P5-06, [ADR 0055](../../docs/adr/0055-audit-log-hash-chain.md), [ADR 0067](../../docs/adr/0067-temporary-elevated-access.md))

- `recordAuditEvent(tx, { clock, ids, actor }, event, origin)` appends one row to the organisation's chain inside `withTx()`: the event and origin validated (`AuditEventError` names the field, never a value), a per-org advisory lock (`AUDIT_LOCK_NAMESPACE`), READ COMMITTED required, the chain head read, `hash = sha256(prev_hash ‖ JCS(row))` over `HASHED_COLUMNS`, the INSERT. `actor` is `user` (`actor_id = app.current_user_id()`, the API) or `system` (`actor_type 'system'`, `actor_id NULL`, the worker's expiry consumer). `AuditContextError` without a tenant context.
- The API's `AuditService.record()` and the worker's expiry both call it: one chain, one recorder, no chain logic in SQL.
