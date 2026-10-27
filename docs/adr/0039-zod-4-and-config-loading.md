# 0039. Zod 4 repo-wide, and how `@bricx/config` loads configuration

- Status: Accepted
- Date: 2026-10-13
- Deciders: Mohamed Abass Jalloh
- Source: P2-03 (plan approved 2026-10-13 with A1 Zod 4, B1 `API_PORT=4000`, C1 only the keys needed now, D1 `DATABASE_URL` as `bricx_app` only, and conditions 1–9; production-guard hardening requested in review 2026-10-13 01:15Z); ADR 0016 (nestjs-zod + orval, "confirm Zod 4 at P1"); ADR 0023 (dependency policy); ADR 0035 (database roles). Numbered 0039 because 0038 went to P1-06c.

## Context

ADR 0016 and DEPENDENCIES.md asked for a check at P1 that Zod 4 works with `nestjs-zod` and `orval`, falling back to Zod 3.x repo-wide if either lagged. No task ran it. P2-03 adds `zod` for the first time, so the major is fixed here.

P2-03 also defines how every app gets its configuration. The API, the worker and the client each need a typed, validated config at boot, and the values include credentials, so the loader is where secrets can leak into logs, error reports or the client bundle.

## Decision

### Zod 4.6.5, exact, repo-wide

- `zod` **4.6.5**, pinned exactly, in `packages/config` only for now. Every later workspace uses the same version (never mixed majors).
- **Compatibility (npm registry, 2026-10-06 and again 2026-10-13T00:48Z):** `nestjs-zod` 5.5.0 (latest both days) peers `zod ^3.25.0 || ^4.0.0`; `orval` 8.40.0 (2026-10-06) and 8.41.0 (2026-10-13) depend on `@orval/zod` of the same version, which peers `zod >=3`. Neither lags, so the Zod 3 fallback does not apply. Their own versions are chosen when they are added (P4).
- **7-day rule.** 4.6.5 is the **newest version at least 7 days old**, not "latest": the npm `latest` tag is 4.6.7, and both newer releases were under 7 days old at install time.
  - 4.6.5 published **2026-09-13T23:25:14.644Z**.
  - 4.6.6 published 2026-10-11T16:18:23.878Z (1 day 8 hours old at install); 4.6.7 published 2026-10-12T16:29:37.778Z (8 hours old at install). Both rejected.
  - Registry re-checked and `pnpm --filter @bricx/config add zod@4.6.5` run at **2026-10-13T00:41:09Z**: 4.6.5 was 29 days 1 hour old.
  - Integrity (registry `dist.integrity`, equal to the `pnpm-lock.yaml` resolution): `sha512-v5l/aFXZQeai4awLbOpSoHecE9UiMrnfx75tEXLjNonXVARxQ5mOeipTjROUchszUNCqnE+hqAMujRsRHsut2Q==`; tarball `https://registry.npmjs.org/zod/-/zod-4.6.5.tgz`, shasum `e3af3edbdc260239c52f73caad05dbbffe6e82cd`.
  - No dependencies and no install scripts (`build`/`postbuild` are publish-time only), so no build-script approval is needed.

### `@bricx/config`

- **One package, three entry points:** `@bricx/config/api`, `@bricx/config/worker`, `@bricx/config/client-public`. There is no root barrel, so importing the client entry can never pull in a server schema.
- **Loaders are pure functions of the environment they are given** (`loadApiConfig(env = process.env)`, `loadWorkerConfig(env = process.env)`, `loadClientPublicConfig(env)`):
  - they read exactly the declared keys, one property read each; other variables are ignored, never enumerated or probed (a Proxy test proves it);
  - an empty string counts as missing;
  - every problem is reported at once in one `ConfigError`, thrown on boot;
  - they **never read a file**. `src/` imports only `zod` and its own files, and never names an env file (tested). `.env` reaches the environment only through a dev entry point (`process.loadEnvFile(".env")` or `node --env-file=.env`, at P4). `check:workspace` fails if anything under `packages/` uses Node's env-file loading, or if any file that loads env files names `.env.production` anywhere (6 fixtures).
- **No value ever reaches an error.** Messages are built from the key name and the issue code only, never from zod's own messages; zod runs with `reportInput: false`; `ConfigError` holds only `app` and `problems: { key, code }[]`, and no `cause`. Tests put a unique sentinel into each failing value (wrong type, invalid URL, wrong URL scheme, too short, enum mismatch, out of range, bad origin, and the production guards: `dev-only`, `bricx-dev`, local database, local cache) and check that it appears in neither `message`, `stack`, `JSON.stringify(error)` nor `util.inspect(error)`, including `showHidden` and `customInspect: false`.
- **Secrets are a `Secret`, not a string:** `DATABASE_URL`, `VALKEY_URL` and `S3_SECRET_ACCESS_KEY`. `toString`, `toJSON`, `Symbol.toPrimitive` and `util.inspect.custom` all return `"[redacted]"`; the value sits in a private field and comes out only through `.reveal()`. A test logs the whole api and worker config (`console.log`, `%o`, `JSON.stringify`, `inspect` with `customInspect: false`) and finds no secret.
- **Production guards (`NODE_ENV=production`):**
  - any declared value containing `dev-only` fails (`dev_only_value_in_production`);
  - any declared value containing `bricx-dev`, the dev S3 key id and bucket in `.env.example`, fails with its own code (`bricx_dev_value_in_production`). Both markers match case-insensitively;
  - a local host in `DATABASE_URL`, `VALKEY_URL` or `S3_ENDPOINT` fails (`local_host_in_production`): `localhost`, `*.localhost`, `127.0.0.0/8`, `::1`, `::` or `0.0.0.0`. `OTEL_EXPORTER_OTLP_ENDPOINT` is deliberately exempt, because a local collector sidecar is legitimate in production (tested);
  - any `*` in `CORS_ORIGINS` fails (`wildcard_in_production`).
  - Development and test accept all of these (tested). One test per rule, plus a test that a normal production config (with a local OTel sidecar) passes, plus sentinel tests for the new codes.
- **Codes beyond zod's:** `missing`, plus four production codes (`dev_only_value_in_production`, `bricx_dev_value_in_production`, `local_host_in_production`, `wildcard_in_production`). A `refine` here is only ever a format check, so its `custom` code is reported as `invalid_format`.
- **Keys (C1: only what P4-01 and the worker skeleton need):**
  - server (api and worker): `NODE_ENV` (development, test, production), `LOG_LEVEL` (pino levels), `DATABASE_URL` (`postgres:`/`postgresql:`, as `bricx_app`, D1), `VALKEY_URL` (`redis:`/`rediss:`), `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `OTEL_EXPORTER_OTLP_ENDPOINT`;
  - api only: `API_PORT` (integer 1–65535), `CORS_ORIGINS` (comma list of exact http(s) origins: the WHATWG origin must equal the text, so no path, trailing slash, query, credentials or upper case);
  - client: `EXPO_PUBLIC_API_URL`. Every client key starts with `EXPO_PUBLIC_`, matches no server key and contains no SECRET, PASSWORD, TOKEN or KEY (tested). `client-public.ts` reaches nothing from `shared.ts`, `api.ts`, `worker.ts` or `secret.ts`, and does not touch `process` at all (tested). Its `env` argument is required, because Expo inlines `EXPO_PUBLIC_*` only when read by name.
  - Later tasks add their own keys (P4-02 the `bricx_owner` migration URL, P5 Keycloak, P8 ClamAV, P12 SMTP).
- **`.env.example` is complete and consistent (tested):** every schema key is in it, its "Application config" section has no key the schemas do not declare, `DATABASE_URL`'s user, password and database match `bricx_app`, `BRICX_APP_PASSWORD` and `POSTGRES_DATABASE`, `VALKEY_URL`'s password matches `VALKEY_PASSWORD`, the client URL's port matches `API_PORT`, and the file loads in development and fails the production guards. The package's `turbo.json` adds `.env.example` to its test inputs, so a change there re-runs the tests. gitleaks 8.30.1 finds nothing in it.
- **`API_PORT=4000`** (B1): `grafana/otel-lgtm` binds 127.0.0.1:3000. The P4-01 Verify line moves to port 4000.
- Production values reach the process environment from the deployment's secret store (AWS Secrets Manager, P13). The loader never fetches them.

## Alternatives rejected

- **Zod 3.x:** only needed if `nestjs-zod` or `orval` lagged; neither does.
- **zod 4.6.7 (`latest`):** under 7 days old.
- **`dotenv` or `@t3-oss/env-core`:** Node 24 loads env files itself, and a loader that reads files is what condition 6 forbids. Neither is in DEPENDENCIES.md.
- **zod's issue messages, or attaching the `ZodError` as `cause`:** zod messages can quote expected and received values, and a `cause` travels into error reporters.
- **Plain strings plus a logger redaction list:** one missed path leaks the value; a `Secret` is safe by default everywhere.
- **One root export with all schemas:** a client import could drag server schemas into the bundle.

## Consequences

Positive:
- A missing or bad key stops boot with every problem listed and no value shown.
- A secret cannot reach a log, a JSON body or a crash report by accident; using one needs a visible `.reveal()`.
- A production deploy with a dev placeholder, a `bricx-dev` value, a local database, cache or S3 endpoint, or a wildcard CORS origin fails at boot.

Negative:
- `.env.example` repeats two dev passwords (`BRICX_APP_PASSWORD` and `VALKEY_PASSWORD`) inside `DATABASE_URL` and `VALKEY_URL`; a test keeps them equal, and changing one still needs `pnpm dev:reset` (ADR 0035). (for architect review)
- Problems name only key and code, so a developer sees "DATABASE_URL: invalid_format", not what is wrong with the text. That is the price of never echoing a value. (for architect review)
- "No secret in the client bundle" is proven here only at the schema and import level; there is no bundle until P7-01, which must scan the built bundles (ROADMAP P7-01). (for architect review)
- The production guards are a denylist (the `dev-only` and `bricx-dev` markers, local hosts, `*`). A fake value without either marker, or a private-network host, still passes. A legitimate production name containing `bricx-dev` (for example a bucket `bricx-devices`) is also rejected and must be renamed. (for architect review)
- `packages/config` is a P2 package with `src/`, but ADR 0032's Semgrep trigger is the first **P3** package with `src/`, so there is still no SAST. (for architect review)

## Note (2026-10-24): zod 4.6.6

`pnpm audit:prod` reported GHSA-mrhx-c7xc-m3w5 (high: zod below 4.6.6 can exhaust memory while validating an oversized array). With the owner's approval of 2026-10-24, `zod` moves from 4.6.5 to 4.6.6, still exact and repo-wide, in every `package.json` that lists it: `packages/money`, `packages/config`, `packages/validation`, `packages/api-client` and `apps/api`. 4.6.6 was published 2026-10-11T16:18:23.878Z, so it passes the 7-day rule (ADR 0023). Its integrity is `sha512-4UmzQUF5…I/UhA==`, and it has no install scripts. Peers still accept it: `nestjs-zod` 5.5.0 peers `zod` `^3.25.0 || ^4.0.0`, and `@orval/zod` 8.41.0 (under `orval` 8.41.0) peers `zod` `>=3`. The decision above is unchanged: Zod 4, one exact version repo-wide.
