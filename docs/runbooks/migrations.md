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

## The global directory (P6-01, [ADR 0071](../adr/0071-global-directory-service.md))

The directory has its own database, `bricx_directory`, its own migration folder, `packages/db/directory-migrations/` (hand-written SQL and `meta/_journal.json`, no Drizzle snapshot), and its own history table, `directory_migrations.applied`.

- `pnpm db:migrate` migrates the cell database, then the directory when `DIRECTORY_MIGRATION_DATABASE_URL` is set (`directory_owner`; `.env.example` sets it for development). It prints a second line, `db:migrate directory: applied N (tags)` or `db:migrate directory: 0 applied`; a refusal is `db:migrate directory: migration refused: <code>`.
- A directory migration is written by hand: add `NNNN_name.sql` and append its journal entry. Every table needs `ENABLE` and `FORCE ROW LEVEL SECURITY`, one policy per role and command, and explicit grants (schema `directory` has no default privileges). The migrator refuses a table without RLS (`tenant_rls_missing`), any `SECURITY DEFINER` function (`definer_forbidden`) and any table privilege for `PUBLIC` (`public_table_privilege`). The same immutability rules apply: `check:workspace` and `migrations-immutable` check both folders.
- Roles: `directory_owner` (migrations and deployment data), `directory_reader` (`SELECT` only; the API's `DIRECTORY_DATABASE_URL`), `directory_writer` (`INSERT` on `org_directory` only; P6-02's registration). No cell role may connect to `bricx_directory` and no directory role to the cell database.
- Cells are deployment data, not migration data. Add one as `directory_owner`: `INSERT INTO directory.cells (id, api_base_url, keycloak_url) VALUES ('af-south-1', 'https://api…', 'https://id…/realms/bricx');`. An organisation's `cell_id` and `org_id` can never be changed (trigger, SQLSTATE `P6001`), by any role.
- **Existing local volumes need `pnpm dev:reset`.** Postgres runs `infrastructure/docker/postgres/init/02-directory.sh` only on an empty volume, so a volume created before P6-01 has no `bricx_directory` and no directory roles. `pnpm dev:up` stops and says so; run `pnpm dev:reset` (deletes all local stack data), then `pnpm dev:up` and `pnpm db:migrate`. `pnpm dev:up` also appends the new `.env.example` keys to an existing `.env`.


## Organisations (P6-02, [ADR 0072](../adr/0072-organizations.md))

- **Dev cells.** `pnpm db:migrate` prints a third line, `db:migrate dev cells: applied 2 (af-south-1, eu-west-1)` (`db:migrate dev cells: 0 applied` on a second run), after the directory journal. It inserts the two launch cells, both pointing at the local stack, only for `NODE_ENV=development` and a local directory host; otherwise it prints `db:migrate dev cells: skipped`. A cell row with other URLs stops the run with `cell_drift (<cell id>)` and is left as it is: fix or delete the row as `directory_owner`, then run again.
- **Existing local databases need `pnpm dev:reset`.** Migration 0009 adds foreign keys from `memberships.org_id` and `roles.org_id` to `bricx.organizations`. A local database where `pnpm membership:bootstrap` ran before P6-02 has membership and role rows for an organisation with no row, so the migration fails (23503). Run `pnpm dev:reset`, then `pnpm dev:up` and `pnpm db:migrate`. No production database exists yet. From P6-02 on, `membership:bootstrap` refuses an organisation that does not exist (`org_missing`).

### Releasing an abandoned reservation (D4)

A create attempt that never committed keeps its slug reserved in the directory. There is no automatic release. To release one:

1. In the cell, confirm that no organisation has the id and that its attempt is not still being retried (see the query below; a user who retries with the same key resumes it).
2. Accept that the directory's 200 answers for that slug are cached for up to a day (ADR 0071 D5): a client may still be sent to this cell for a day.
3. As `directory_owner`, delete the reservation. The foreign key from `directory.org_email_domains` keeps a reservation that has a domain (23503), so this deletes only one with none:

```sql
DELETE FROM directory.org_directory
 WHERE org_id = '<org id>'
   AND NOT EXISTS (SELECT 1 FROM directory.org_email_domains d WHERE d.org_id = '<org id>')
 RETURNING org_id;
```

The released slug can be reserved again. The attempt stays `pending` and counts toward the user's cap; it is not deleted.

### Pending create attempts older than 24 hours (C2)

Read-only; no automatic action. `bricx.org_create_attempts` is a user table under FORCE RLS with no `bricx_owner` policy, so the database administrator runs it:

<!-- runbook:pending-attempts -->
```sql
SELECT user_id, org_id, slug, created_at
  FROM bricx.org_create_attempts
 WHERE state = 'pending'
   AND created_at < now() - interval '24 hours'
 ORDER BY created_at;
```

A pending attempt usually means the directory was unreachable or the cell transaction failed after the reservation. The user's retry with the same Idempotency-Key finishes it.

### Restoring an archived organisation (D16)

There is no restore route. As `bricx_owner`, in one transaction with the organisation in the context (the trigger lets only `bricx_owner` clear `archived_at`, and RLS shows the row only in its organisation):

```sql
BEGIN;
SELECT set_config('app.org_id', '<org id>', true);
UPDATE bricx.organizations SET archived_at = NULL, updated_at = now() WHERE id = '<org id>' AND archived_at IS NOT NULL;
COMMIT;
```

The `UPDATE` reports one row. The restore writes no audit event (architect-reviewed 2026-11-06); record the ticket.
