# @bricx/config

Zod-validated environment config for each app (P2-03, ADR 0039). Call the loader first thing on boot: it throws a `ConfigError` listing every bad key, by name and code only, never a value.

```ts
import { loadApiConfig } from "@bricx/config/api"; // apps/api
import { loadWorkerConfig } from "@bricx/config/worker"; // apps/worker
import { loadClientPublicConfig } from "@bricx/config/client-public"; // apps/client
```

- **Only declared keys are read**; anything else in the environment is ignored. An empty value counts as missing.
- **Secrets** (`database.url`, `valkey.url`, `s3.secretAccessKey`) are `Secret` objects: they print, stringify and inspect as `[redacted]`. Call `.reveal()` only where the value is used (creating the pool or client), never to log.
- **Production** (`NODE_ENV=production`) rejects any `dev-only` value, a local `DATABASE_URL` host and `*` in `CORS_ORIGINS`.
- **Loaders never read a file.** Locally, a dev-only entry point loads `.env` first (`process.loadEnvFile(".env")` or `node --env-file=.env`). `check:workspace` fails if anything under `packages/` loads an env file, or if any file that does names the production env file.
- **Client:** list every key by name, because Expo inlines `EXPO_PUBLIC_*` only when read that way:

  ```ts
  const config = loadClientPublicConfig({
    EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL,
  });
  ```

  Client keys are public: never put a secret in an `EXPO_PUBLIC_*` key.

## Adding a key

1. Add it to the schema in `src/shared.ts` (api and worker), `src/api.ts`, `src/worker.ts` or `src/client-public.ts`.
2. Add it to `.env.example` under "Application config" with a fake `dev-only` value if it is secret, and wrap it in `Secret` in the returned config.
3. `pnpm --filter @bricx/config test` fails until both are done.
