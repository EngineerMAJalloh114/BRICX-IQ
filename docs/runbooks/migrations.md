# Database migrations (P4-02, ADR 0052)

Migrations are **forward-only**. There is no down migration and no rollback command: a mistake is fixed by a new migration, and a risky change is split with the expand/contract pattern so every step can stay deployed while the next one is prepared.

## Commands

```bash
pnpm db:generate   # drizzle-kit generate: writes packages/db/migrations/NNNN_name.sql from src/schema/tables.ts (offline)
pnpm db:migrate    # builds the api, then applies every pending migration as bricx_owner (MIGRATION_DATABASE_URL from .env)
```

- `db:migrate` prints `db:migrate: applied N (tags)` or `db:migrate: 0 applied`. Running it again is always safe.
- It exits 1 with a code and no secret: `wrong_role` (the URL is not `bricx_owner`), `missing_schema` (the database lacks `bricx_migrations`: run `pnpm dev:reset`, then `pnpm dev:up`), `database_unavailable` (the server cannot be reached), `database_error` (the server rejected a query outside a migration, with its SQLSTATE and message, e.g. `42501` permission denied), a refusal below, or `migration_failed` with the tag, statement number, SQLSTATE and server message.
- drizzle-kit exits 0 even when it writes nothing or fails, so read its output and `git status packages/db/migrations` after `db:generate`.

## Writing a migration

1. Change or add tables in `packages/db/src/schema/` (every table is exported from `tables.ts`). Use the column helpers from `columns.ts`. Never export a `pgSchema()` from `tables.ts`: drizzle-kit would emit `CREATE SCHEMA`, which `bricx_owner` may not run (the bootstrap creates `bricx`).
2. Run `pnpm db:generate --name <what_it_does>` (from `packages/db`: `pnpm generate --name …`).
3. **Hand-review the SQL** before committing. Check every statement:
   - Tables are in `"bricx"`; tenant tables have `org_id`, `ENABLE` and `FORCE ROW LEVEL SECURITY` and their policies (CLAUDE.md rule 3).
   - Money is `bigint` minor units plus a currency code; FX rates `NUMERIC(24,12)`; timestamps `timestamptz` (rules 1 and 7).
   - Ledger and audit tables get no `UPDATE`/`DELETE` for the app role (rule 2).
   - A table published for sync gets `GRANT SELECT … TO powersync_repl` and `ALTER PUBLICATION powersync ADD TABLE …` in the same migration, plus its sync-stream scope and leak test. Never `CREATE`, `DROP`, rename or re-own a publication: `check:workspace` rejects it, and rows written while `powersync` is missing never replicate.
   - No destructive change to a column or table that deployed code still reads (see expand/contract).
4. You may edit the generated SQL **before it is merged** (add RLS, grants, a backfill). Keep drizzle-kit's `--> statement-breakpoint` markers between statements.
   - **RLS (P4-04, [ADR 0054](../adr/0054-rls-policy-framework.md))**: for each new table run `pnpm db:rls bricx.<table> <resource>` (a `@bricx/permissions` subject type such as `project.task`) and append its output to the same migration, after the `CREATE TABLE`. Add the table to `TENANT_TABLES` in `packages/db/src/rls.ts`; the RLS integration test then proves its policies and fails if `bricx` holds an unregistered table. The migrator refuses (`tenant_rls_missing`) any table, materialized view or foreign table in `bricx` or `app` without ENABLE + FORCE, and (`definer_search_path`) any SECURITY DEFINER function without a pinned `SET search_path` (only `pg_catalog`, `pg_temp`, `bricx`, `app`), and (`definer_public_execute`) one that PUBLIC may execute. A per-user table with no `org_id` (P5-02: `bricx.users`) goes on `USER_TABLES` with `enableUsersRls()` instead. A table with no tenant data needs an entry in `GLOBAL_TABLES` (`packages/db/src/rls-guard.ts`) and an ADR line.
   - **Backfills**: FORCE binds `bricx_owner` too, so a data migration sees no tenant row until it sets a context: `SELECT set_config('app.org_id', '<org uuid>', true);` before its `UPDATE`, one org at a time; a project- or site-scoped table also needs `SELECT set_config('app.project_ids', '{<project uuid>,…}', true);` (ADR 0054).
5. Run `pnpm db:migrate` locally, then `pnpm --filter @bricx/db test:integration` (it applies the real journal to an empty database and through each prefix).

## After merge: never edit

Once a migration is on `main` it is immutable. CI's `migrations-immutable` step fails a PR that edits, deletes or renames a merged `NNNN_*.sql` or `meta/NNNN_snapshot.json` (P4-05), or changes `_journal.json` other than by appending entries. The migrator also refuses, before running anything:

| Code | Meaning | Fix |
|---|---|---|
| `applied_migration_changed` | an applied file's SHA-256 changed | restore the file; put the change in a new migration |
| `applied_migration_removed` | an applied tag left the journal | restore the file and its journal entry |
| `applied_migration_reordered` | an applied tag moved to another `idx` | restore the journal order |
| `tenant_rls_missing` | a table in `bricx` or `app` lacks ENABLE or FORCE ROW LEVEL SECURITY (the migration rolled back) | append `pnpm db:rls` output, or list a truly global table in `GLOBAL_TABLES` with an ADR line |
| `definer_search_path` | a SECURITY DEFINER function has no `SET search_path`, or names a schema other than `pg_catalog`, `pg_temp`, `bricx`, `app` (such as `public` or `"$user"`) (rolled back) | add `SET search_path = pg_catalog, pg_temp` (plus the schemas it needs), or use SECURITY INVOKER |
| `definer_public_execute` | a SECURITY DEFINER function may be executed by PUBLIC (an explicit grant, or the default ACL) (rolled back) | `REVOKE ALL ON FUNCTION … FROM PUBLIC` and grant EXECUTE to the one role that calls it |
| `gap_fill` | a new migration sits below the highest applied `idx` | regenerate it after the latest one (two branches that both generated migrations: merge `main`, delete your unmerged migration and its snapshot and journal entry, run `db:generate` again) |

## Expand/contract

A change that would break running code is split across releases:

1. **Expand**: add the new column or table (nullable or with a default), and write to both old and new shapes in code.
2. **Migrate data**: backfill in a migration, or in a batched job for large tables (the outbox, from P4-06).
3. **Switch reads** to the new shape in code and deploy.
4. **Contract**: a later migration drops the old column or table, once no deployed code reads it.

Renames are expand/contract too: add the new name, copy, switch, drop the old one.

## When a migration fails

- **Locally**: the failed migration rolled back in full (statements and history row commit together). Fix it (it is not merged yet, so editing is allowed), then run `pnpm db:migrate` again. If an earlier unmerged migration of yours was applied and you want to change it, run `pnpm dev:reset` and `pnpm dev:up` to start from an empty database.
- **In a deploy** (P13-03): the failing migration rolled back; the ones before it in the same run stay applied, and the previous application version keeps running against them (expand/contract keeps it compatible). Ship a new migration that fixes forward. Never edit the history table by hand.
- Concurrent runs are serialised by a session advisory lock held for the whole run: the second waits, then applies nothing. Point `MIGRATION_DATABASE_URL` at Postgres directly, never at a transaction-mode pooler.

## Roles

Migrations run only as `bricx_owner` (`MIGRATION_DATABASE_URL`). The history lives in `bricx_migrations.applied`, readable by `bricx_owner` alone. The api and worker never see the owner URL.
