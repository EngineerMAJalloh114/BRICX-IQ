# @bricx/config

Zod-validated environment config for each app (P2-03, ADR 0039). Call the loader first thing on boot: it throws a `ConfigError` listing every bad key, by name and code only, never a value.

```ts
import { loadApiConfig } from "@bricx/config/api"; // apps/api
import { loadWorkerConfig } from "@bricx/config/worker"; // apps/worker
import { loadClientPublicConfig } from "@bricx/config/client-public"; // apps/client
import { loadMigrateConfig } from "@bricx/config/migrate"; // pnpm db:migrate only (P4-02)
import { loadDirectoryConfig } from "@bricx/config/directory"; // the directory module alone (P6-01)
```

- **Only declared keys are read**; anything else in the environment is ignored. An empty value counts as missing.
- **Migrations** read `MIGRATION_DATABASE_URL` (`bricx_owner`, ADR 0052) through `@bricx/config/migrate` only; the api and worker never declare it.
- **The global directory** (P6-01, ADR 0071): the api reads `DIRECTORY_DATABASE_URL` (`directory_reader`) as an optional key, set only where the API serves the directory; `@bricx/config/directory` reads `NODE_ENV`, `LOG_LEVEL` and `DIRECTORY_DATABASE_URL` and nothing else, so the directory module can be built from it alone; the migrator reads the optional `DIRECTORY_MIGRATION_DATABASE_URL` (`directory_owner`); the client reads `EXPO_PUBLIC_DIRECTORY_URL`.
- **Secrets** (`database.url`, `valkey.url`, `s3.secretAccessKey`, `migrationDatabase.url`, `directory.url`, `directoryMigrationDatabase.url`) are `Secret` objects: they print, stringify and inspect as `[redacted]`. Call `.reveal()` only where the value is used (creating the pool or client), never to log.
- **Production** (`NODE_ENV=production`) rejects any `dev-only` or `bricx-dev` value, a local host in `DATABASE_URL`, `MIGRATION_DATABASE_URL`, `RELAY_DATABASE_URL`, `DIRECTORY_DATABASE_URL`, `DIRECTORY_MIGRATION_DATABASE_URL`, `VALKEY_URL` or `S3_ENDPOINT` (a local OTel collector is allowed) and `*` in `CORS_ORIGINS`.
- **Loaders never read a file.** Locally, a dev-only entry point loads `.env` first (`process.loadEnvFile(".env")` or `node --env-file=.env`). `check:workspace` fails if anything under `packages/` loads an env file, or if any file that does names the production env file.
- **Client:** list every key by name, because Expo inlines `EXPO_PUBLIC_*` only when read that way:

  ```ts
  const config = loadClientPublicConfig({
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
    EXPO_PUBLIC_DIRECTORY_URL: process.env.EXPO_PUBLIC_DIRECTORY_URL,
  });
  ```

  Client keys are public: never put a secret in an `EXPO_PUBLIC_*` key.

## Adding a key

1. Add it to the schema in `src/shared.ts` (api and worker), `src/api.ts`, `src/worker.ts` or `src/client-public.ts`.
2. Add it to `.env.example` under "Application config" with a fake `dev-only` value if it is secret, and wrap it in `Secret` in the returned config.
3. `pnpm --filter @bricx/config test` fails until both are done.
