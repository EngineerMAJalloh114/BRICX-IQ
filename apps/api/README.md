# @bricx/api

The NestJS modular monolith (NestJS 11 on Fastify; P4-01, [ADR 0051](../../docs/adr/0051-api-skeleton-nest11-fastify.md)).

```bash
pnpm dev:api                          # from the repo root: build, load ../../.env, listen on 127.0.0.1:$API_PORT
curl localhost:4000/health/ready      # 200 when db, valkey and s3 answer
pnpm --filter @bricx/api test         # unit tests (fake probes, no Docker)
pnpm --filter @bricx/api test:integration   # Testcontainers: Postgres, Valkey, SeaweedFS
```

- `src/main.ts` calls `loadApiConfig()` from `@bricx/config/api` before anything else and exits 1 naming the bad keys (never their values). It reads no env file; only the `dev` script passes `--env-file`.
- `src/app.ts` (`createApp`): Fastify adapter with a 1 MiB body limit, Helmet, CORS allow-list from `config.http.corsOrigins`, URI versioning (`/v1/...`), `x-request-id` (kept if it matches `^[A-Za-z0-9._-]{1,128}$`, else a new UUIDv7) and JSON logs from one pino instance with credential headers redacted.
- `src/common/health`: `/health/live` and `/health/ready` (version-neutral). Each readiness probe (db, valkey, s3) is bounded at 2 s and reports only `up` or `down`, never an error text.
- `src/bootstrap.ts`: graceful shutdown on SIGTERM/SIGINT closes the probe clients, then exits 0 through `process.exit` so pino flushes its last log lines.
- `src/register.ts`: a resolve hook that lets Node load the TypeScript source of `@bricx/*` workspace packages (for architect review; see ADR 0051).
