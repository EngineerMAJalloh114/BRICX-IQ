# 0051. `apps/api` skeleton: NestJS 11 on Fastify, bounded readiness probes, minimal `packages/db`

- Status: Accepted; amended by [0057](0057-error-model-idempotency.md) (every error leaves as `application/problem+json` through `ProblemFilter`, the health routes excepted; Fastify's `text/plain` parser is removed; `openDatabase()` installs a per-client error listener) and by [0058](0058-openapi-document-generated-client.md) (the document is built in `createApp()` and served at version-neutral `GET /openapi.json`; a global nestjs-zod validation pipe and response serializer; the health routes are documented with the `HealthReport` DTO)
- Date: 2026-10-15
- Deciders: Mohamed Abass Jalloh
- Source: P4-01 (P4 phase plan approved 2026-10-15 11:06Z with all ★ options and changes 1–5; decisions D1, D2, D5, D6 and D7 apply here); CLAUDE.md rules 4, 6 and 7; ADR 0023 (dependency policy), ADR 0028 (Vitest + SWC), ADR 0035 (database roles, Testcontainers), ADR 0036 (`s3-init`), ADR 0039 (`@bricx/config`), ADR 0040 (`withTx()` lives in `packages/db`), ADR 0041 (ids), ADR 0050 (hybrid execution).

## Override

- Override: `fastify` 5.12.6
- Remove when: a `@nestjs/platform-fastify` 11.x release depends on `fastify` 5.12.6 or later (it pins `fastify` exactly). Drop this override and these two lines in that bump; `pnpm audit:prod` then proves the lockfile still holds no vulnerable `fastify`.
- Bumped 2026-10-23 (owner-approved chore, ADR 0023/0038): 5.12.5 → 5.12.6, the lowest release that clears [GHSA-389g-gv7q-r4x8](https://github.com/advisories/GHSA-389g-gv7q-r4x8) (low; header validation bypass via case-sensitive `propertyNames`; vulnerable `>=5.12.2 <5.12.6`). 5.12.6: published 2026-10-13T06:50:58.498Z (10 days before the bump), MIT, no install scripts, the same dependency ranges as 5.12.5, `sha512-XeErl1DDsxdbhE9RPRJ05iNnfMhHRHHewVNNAJXaGTOaCY4wHb6rEizphhgzBq5YQe4JyqQWPpGd+hLh2PXXJA==`. The Context and Decision below describe the 5.12.5 pin as first made.

## Context

ROADMAP P4-01 asks for the NestJS app skeleton: Fastify adapter, Helmet, CORS allow-list from config, `nestjs-pino` structured logs with a correlation id (`x-request-id`), graceful shutdown, `/health/live` and `/health/ready` (db, valkey, s3), URI versioning `/v1`; `main.ts` calls `loadApiConfig()` first and `.env` is read only by a dev-only entry point (ADR 0039). Verify: `curl localhost:4000/health/ready` → 200.

Evidence (Node 24.22.0, raw output in the PR and in the proofs folder):

- STACK.md names NestJS without a major version (`grep -n -i "nest" docs/STACK.md`: lines 6, 16, 31, 51, 52, 71, 85, 99; none names a version), so change 1 of the approved plan (amend STACK.md if it names a Nest major) needs no edit.
- `nestjs-zod` 5.5.0 (the latest, 2026-07-25), chosen for P4-08 in DEPENDENCIES.md, declares peers `@nestjs/common ^10.0.0 || ^11.0.0` and `@nestjs/swagger ^7.4.2 || ^8.0.0 || ^11.0.0`. Nest 12 (12.1.2, 2026-09-30) would break that peer range, so the API stays on Nest 11 (D7).
- Registry facts for every direct dependency added (publish time, age at install, licence, integrity, install scripts), run at 2026-10-15T11:29:38Z:

| Package | Version | Published | Licence | Integrity |
|---|---|---|---|---|
| `@nestjs/core` | 11.2.7 | 2026-09-30T09:22:35.520Z | MIT | `sha512-ynMkVOAEykJMtls1X+MQV3TNY6hrnMkyHowU8XY8R6UqM3tdqT4WNVtemQOmFrqHw3f85lbe765fcpZyjBOcqA==` |
| `@nestjs/common` | 11.2.7 | 2026-09-30T09:23:56.483Z | MIT | `sha512-CGOa0I/5Ac43ydfpjztozOrvgDWYBdY9ktkO0OrRqRo1d8n5cphtrTGYHOwKLMIel0BpSYZoQymJ9Dywv/BzLw==` |
| `@nestjs/platform-fastify` | 11.2.7 | 2026-09-30T09:22:35.946Z | MIT | `sha512-MdkxncTAQiuw5F9KJKUI1qgBRRGl+WAC+66NlAR63iFXVwH6OzVMlcTXdAB4luelUscpoEPMhB6djrAJ7Jc+Sw==` |
| `@nestjs/terminus` | 11.1.1 | 2026-02-18T21:56:36.763Z | MIT | `sha512-Ssql79H+EQY/Wg108eJqN4NiNsO/tLrj+qbzOWSQUf2JE4vJQ2RG3WTqUOrYjfjWmVHD3+Ys0+azed7LSMKScw==` |
| `@fastify/helmet` | 13.1.1 | 2026-08-19T10:02:18.430Z | MIT | `sha512-bSat5DTq8geASv8G6P0KW1UbltZ+xGD/zyd9S72pT7ogAHehcsWL85GdjMRCjDsExJvaEvgEZ52qU/2HXirVCw==` |
| `nestjs-pino` | 5.3.1 | 2026-10-02T20:02:11.200Z | MIT | `sha512-tL3fFSY38Wuv3VS4dCo+zlHVt1xU7+RSXnlgenyTvfy74GLBLgisqvG+76983ilf2C2uFkPe68qUapXCYnoSoA==` |
| `pino` | 10.4.0 | 2026-10-02T18:18:54.863Z | MIT | `sha512-bk1ZMTwG/Vymx+zPoa28MhNzucFvXJWp3csrSuxuHPSMeUettaCoQ5Jvg07mtC4JGNpcfTwz41oVCnNgBK9+vA==` |
| `pino-http` | 11.0.0 | 2025-10-04T15:03:47.740Z | MIT | `sha512-wqg5XIAGRRIWtTk8qPGxkbrfiwEWz1lgedVLvhLALudKXvg1/L2lTFgTGPJ4Z2e3qcRmxoFxDuSdMdMGNM6I1g==` |
| `reflect-metadata` | 0.2.2 | 2024-03-29T01:38:46.117Z | Apache-2.0 | `sha512-urBwgfrvVP/eAyXx4hluJivBKzuEbSQs9rKWCrCkbSxNv8mxPcUZKeuoF3Uy4mJl3Lwprp6yy5/39VWigZ4K6Q==` |
| `rxjs` | 7.8.2 | 2025-02-22T03:00:42.711Z | Apache-2.0 | `sha512-dhKf903U/PQZY6boNNtAGdWbG85WAbjT/1xYoZIC7FAY0yWapOBQVsVrDl58W86//e1VpMNBtRV4MaXfdMySFA==` |
| `ioredis` | 6.0.0 | 2026-07-31T15:03:15.489Z | MIT | `sha512-f+Dtubxfpf6KYFq7WVXJoOLn0bk4TJrMrN9SzeE+jrWrCWj7XX3fA6vkryafhADX+GMymRxgDJDOI33COkJc0w==` |
| `@aws-sdk/client-s3` | 3.1147.0 | 2026-10-06T22:58:25.000Z | Apache-2.0 | `sha512-uTrcJxnJKPr8bc1z7cMxopYSQyAm2dPfiMK+UiBr51L8MzimDxHbW/d9GR6X/LFbWDpMzfFPLhB4UohDrCSaPQ==` |
| `pg` | 8.23.1 | 2026-09-30T15:39:58.489Z | MIT | `sha512-aL96AHANtWjPLDOLqnhx+ngp9+UK7ETEU8VJrDCGvsSSi/mGLcWYsS6Herg7lmaBJe4uwrfqsa7gTEFaSizDoQ==` |
| `@types/pg` `dev` | 8.23.1 | 2026-08-17T20:10:18.296Z | MIT | `sha512-fKVHpikPdg4GKks3JuLEhvwSyvwzF23hnabPy6DD8ljVbC7+6J5dQzdv4arV6jqq57djnMgs1HKBxX4P8aBI3A==` |
| `testcontainers` `dev` | 12.2.0 | 2026-09-28T15:46:04.029Z | MIT | `sha512-Pd0c2eU0DdIuK+Pb3c+vmBUdKjDLgxZmPecQGESFAKyn5LTqSaSw8l7htfMlLwabb/QsUILe6XkxMJw8Ly/ThA==` |

Every version is at least 7 days old (the youngest, `@aws-sdk/client-s3`, 8.5 days), none has an install script, and the install ran with `pnpm install --config.minimumReleaseAge=10080`. No new build script appeared in the lockfile (still ignored: `@swc/core`, `cpu-features`, `protobufjs`, `ssh2`, `unrs-resolver`).

- `@nestjs/platform-fastify` 11.2.7, the latest 11.x release, pins `fastify` **exactly** at 5.11.3. `pnpm audit --prod` at the first P4-01 commit (`c7b1ebf`) reported seven `fastify` advisories against 5.11.3, four high ([GHSA-667r-xxjv-c9mm](https://github.com/advisories/GHSA-667r-xxjv-c9mm) body replacement via an async validation result, [GHSA-p68q-wchp-6fh7](https://github.com/advisories/GHSA-p68q-wchp-6fh7) authentication bypass via malformed URLs reaching encapsulated routes, [GHSA-hwr6-493r-vm6h](https://github.com/advisories/GHSA-hwr6-493r-vm6h) and [GHSA-9q9j-q6p8-xq58](https://github.com/advisories/GHSA-9q9j-q6p8-xq58) validation bypasses; patched in 5.12.2) and three moderate ([GHSA-w2qp-rph6-63g4](https://github.com/advisories/GHSA-w2qp-rph6-63g4), [GHSA-3m5p-2c4r-xxw2](https://github.com/advisories/GHSA-3m5p-2c4r-xxw2), patched in 5.12.1; [GHSA-4mh8-r7rc-xpvc](https://github.com/advisories/GHSA-4mh8-r7rc-xpvc) HTTP/2 trailer DoS, patched in 5.12.5). `fastify` 5.12.5: published 2026-09-16T07:37:06.302Z (29 days before install), MIT, no install scripts, the same dependency ranges as 5.11.3 except `process-warning` `^5.1.0`, `sha512-OB2k1dlxs5/NAABqeKV2FUHkSD2BbENsCak8yULVcymn3fHIPDVa9TI3SDnJSWYSllZmSYuZXy2gTnsT+Sut1A==`. 5.12.6 and 5.12.7 (2026-10-13) fail the 7-day rule.

## Decision

### Framework and HTTP surface

- **NestJS 11.2.7 with `@nestjs/platform-fastify`** (D7). `createApp(config)` in `apps/api/src/app.ts` builds the app; `bootstrap(config)` adds shutdown hooks and listens; `main.ts` only loads config and calls `bootstrap`.
- **Helmet** via `@fastify/helmet` 13.1.1, registered on the Fastify instance.
- **CORS** via `app.enableCors({ origin: config.http.corsOrigins })`, an allow-list. Nest uses the `@fastify/cors` 11.3.0 that `@nestjs/platform-fastify` already depends on, so `@fastify/cors` is **not** a direct dependency.
- **URI versioning**, default version `1`: business routes live under `/v1/…`. The health routes are `VERSION_NEUTRAL` (`/health/live`, `/health/ready`), because the ROADMAP Verify command and load balancers call them unversioned.
- **Body limit 1 MiB** (`bodyLimit: 1_048_576`, D5; the ADR 0047 follow-up): a larger body gets 413 before any handler runs.
- **Listen host**: `0.0.0.0` when `NODE_ENV=production` (a container needs it), otherwise `127.0.0.1`, like every dev-stack port (README). (For architect review.)

- **`fastify` override 5.12.5** in `pnpm-workspace.yaml` (ADR 0038's rules: global, exact, recorded here, listed in DEPENDENCIES.md, the only `fastify` in the lockfile), because no `@nestjs/platform-fastify` release lets a normal update move it. No audit ignore. Added after the first commit, when the audit ran; the unit and integration suites re-ran green on it. (For architect review: a minor-version jump under Nest's adapter that Nest itself has not released.)

### Correlation id and logging

- `x-request-id`: an incoming value is kept only if it matches `^[A-Za-z0-9._-]{1,128}$`; otherwise, or when missing, the API generates a UUIDv7 with `@bricx/ids/uuid-v7` and an injected `Clock` (`systemClock` lives in `apps/api/src/common/clock.ts`; rule 7). The id is Fastify's request id, appears on every request log line as `reqId`, and is returned in the response header.
- **One pino instance** (`pino` 10.4.0) is Fastify's `loggerInstance`, and `nestjs-pino` 5.3.1 reuses it (`LoggerModule.forRoot({ pinoHttp: { logger }, useExisting: true })`), so Nest's own log lines and Fastify's request lines are the same JSON stream. Request logging comes from Fastify, not from nestjs-pino's middleware: that middleware is bound to versioned routes and skipped `VERSION_NEUTRAL` health routes once a versioned controller existed, and binding it with `VERSION_NEUTRAL` crashed `path-to-regexp`. `pino-http` 11.0.0 is a direct dependency because `nestjs-pino` peers it.
- Redaction (`censor: "[redacted]"`): `req.headers.authorization`, `req.headers.cookie`, `req.headers["x-api-key"]`, `res.headers["set-cookie"]`. Log level comes from `config.logLevel`.

### Health

- `@nestjs/terminus` 11.1.1 with `HealthIndicatorService`. `/health/live` checks nothing (the process answers). `/health/ready` checks `db`, `valkey` and `s3`; a failed check is reported as `{ status: "down" }` with **no message, host, URL or error text** (503).
- Probes (`apps/api/src/common/health/probes.ts`), each bounded at 2 s (`PROBE_TIMEOUT_MS`) and each with its own long-lived client:
  - `db`: `openDatabase(config.database.url, { maxConnections: 2 })` from `@bricx/db/database`, `SELECT 1`.
  - `valkey`: `ioredis` 6.0.0 with `lazyConnect`, connect and command timeouts, no retries and no offline queue, `PING`.
  - `s3`: `@aws-sdk/client-s3` 3.1147.0 `HeadBucket` on `config.s3.bucket` (path style, one attempt, `AbortSignal.timeout`).
- Graceful shutdown: `app.enableShutdownHooks(["SIGTERM", "SIGINT"], { useProcessExit: true })`; on shutdown each probe client is closed once (`allSettled`), the API logs `readiness probes closed`, and the process exits 0 through `process.exit`. Nest's default re-raises the signal instead, which skips the `exit` event on which pino flushes its asynchronous stdout writes: the first full integration run lost that last line under load, and a 30-run reproduction lost it every time (`process.kill` 0/30, `process.exit` 30/30). The integration test asserts exit code 0 and the log line.

### `packages/db` (D1, minimal)

P4-01 creates `@bricx/db` with one subpath, `./database`: `openDatabase(url: SecretUrl, options)` returns `{ ping(), close() }` around a `pg` 8.23.1 pool (connection and query timeout 2 s by default, `max` 10 by default, pool `error` events swallowed so an idle disconnect cannot crash the process). `config.database.url.reveal()` is called only inside `openDatabase` (ADR 0039). Every failure is `DatabaseUnavailableError` with the fixed message `database unavailable` and no `cause`, so no URL, user, host or password reaches a log or response. P4-02 adds Drizzle and P4-03 `withTx()` to this package (ADR 0040); nothing outside `packages/db` imports `pg`.

### Running the API (D2, D6)

- `pnpm dev:api` (root) runs `apps/api`'s `dev` script: `tsc -p tsconfig.build.json && node --env-file=../../.env --import ./dist/register.js dist/main.js`. The dev script is the only place the env-file flag appears; `main.ts` never reads an environment file and never names `.env.production` (a unit test reads the source and `package.json`). `start` is the same without the env file.
- The API is compiled with `tsc` (Nest needs `emitDecoratorMetadata`, which Node's type stripping does not do). The workspace packages it imports (`@bricx/config`, `@bricx/db`, `@bricx/ids`) ship TypeScript source, so `dist/register.js` installs a `module.registerHooks` resolve hook that, only for relative `.js` imports from files under `packages/` that fail to resolve, retries the same path with `.ts`; Node 24 then strips the types (every package already passes `--erasableSyntaxOnly`). **(For architect review: P13-02 may bundle or pre-compile the packages for the image instead.)**
- The API and (from P4-06) the worker run as host processes against the compose stack (D6). The `depends_on: s3-init: condition: service_completed_successfully` step from ADR 0036 therefore moves to P13-02 (container images), as recorded on P4-01 and P13-02 in ROADMAP.md and in `compose.yml`'s comment; the P4 exit report states it.

### Tests and tooling

- Unit tests (`swcPreset`) use fake probes and a captured log stream; integration tests (`integrationPreset` plus the SWC plugins) start Postgres, Valkey and SeaweedFS with Testcontainers, reusing `@bricx/db-bootstrap`, which gains an `exports` map (`./stack`, `./s3`) for that.
- ESLint: a new `bricx/nest-modules` block turns on `no-extraneous-class` with `allowWithDecorator: true` for `apps/{api,worker}/**`, so Nest's decorated module classes pass while an undecorated static-only class still fails (two eslint-smoke fixtures).

## Consequences

- P4-02…P4-09 build on `createApp`, `AppModule.forRoot` and `@bricx/db`; P4-03 adds `withTx()` next to `openDatabase`.
- Nest 12 waits for `nestjs-zod` to accept it; moving needs a new ADR.
- The resolve hook is a runtime shim that production images must either keep or replace at P13-02.
- Not installed in P4-01, though listed for P4 in DEPENDENCIES.md: `@fastify/cors` (bundled), `@fastify/cookie` (P5 web BFF), `@nestjs/swagger`, `nestjs-zod`, `zod` (P4-07/P4-08), `drizzle-orm`, `drizzle-kit` (P4-02), `@nestjs/bullmq`, `bullmq` (P4-06), `canonicalize` (P4-05), `@sentry/nestjs`, `@nestjs/cli`, `@nestjs/testing`, `@testcontainers/postgresql` (in `apps/api`), `supertest`, `@types/supertest` (Fastify's `inject` replaces supertest). `@aws-sdk/client-s3` moves from P8 to P4 for the readiness probe.

## Negatives (for architect review)

- Health routes are unversioned while everything else is under `/v1`.
- The readiness probes keep three small long-lived clients open (2 Postgres connections, 1 Valkey, 1 S3 client) for the life of the process.
- `pnpm dev:api` compiles before starting and does not watch files.
