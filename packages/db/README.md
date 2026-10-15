# @bricx/db

The only package that talks to Postgres (CLAUDE.md rule 4, [ADR 0040](../../docs/adr/0040-rehome-seed-framework.md)). P4-01 adds the minimal pool; P4-02 adds Drizzle and migrations, P4-03 `withTx()`.

```ts
import { openDatabase, DatabaseUnavailableError } from "@bricx/db/database";

const db = openDatabase(config.database.url, { timeoutMs: 2000, maxConnections: 2 });
await db.ping(); // SELECT 1, or DatabaseUnavailableError
await db.close(); // idempotent
```

- The URL is a `Secret`: `reveal()` is called once, inside `openDatabase`, and nowhere else.
- Every failure is `DatabaseUnavailableError` with the fixed message `database unavailable` and no `cause`, so no URL, user, host or password can reach a log or a response.
- Connection and query timeouts default to 2 s; idle-client errors are swallowed by the pool so a dropped connection cannot crash the process.
