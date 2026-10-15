# @bricx/db

The only package that talks to Postgres (CLAUDE.md rule 4, [ADR 0040](../../docs/adr/0040-rehome-seed-framework.md)). P4-01 adds the minimal pool; P4-02 the Drizzle schema helpers and the migrator ([ADR 0052](../../docs/adr/0052-drizzle-migrations-own-migrator.md)); P4-03 `withTx()`.

```ts
import { openDatabase, DatabaseUnavailableError } from "@bricx/db/database";

const db = openDatabase(config.database.url, { timeoutMs: 2000, maxConnections: 2 });
await db.ping(); // SELECT 1, or DatabaseUnavailableError
await db.close(); // idempotent
```

- The URL is a `Secret`: `reveal()` is called once, inside `openDatabase`, and nowhere else.
- Every failure is `DatabaseUnavailableError` with the fixed message `database unavailable` and no `cause`, so no URL, user, host or password can reach a log or a response.
- Connection and query timeouts default to 2 s; idle-client errors are swallowed by the pool so a dropped connection cannot crash the process.

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
