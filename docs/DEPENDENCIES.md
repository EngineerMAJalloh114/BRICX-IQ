# BRICX IQ — Dependency List

Source of truth for every package allowed in the repo, per workspace and per phase.
Anything not listed here needs an ADR before it is added (CLAUDE.md rule: no duplicate tools).

## Version policy

- **Pin exact versions** in `package.json` (`save-exact=true` in `.npmrc`). Dependabot raises upgrades (ADR 0033). `check:workspace` fails on any non-exact version and on any dependency name not listed in this file (ADR 0031).
- **Runtime baselines:** Node.js 24 LTS · pnpm 10.x · TypeScript 5.x (strict) · PostgreSQL 18 · Valkey 8.x.
- **Expo-managed packages** (`expo-*`, `react`, `react-native`, `react-native-*` in the Expo SDK) are installed with `npx expo install` so versions match the SDK. Never hand-pick their versions.
- **Compatibility checks at P1** (verify before locking, record in ADR):
  - Zod 4 + `nestjs-zod` + `orval`. If any lags, use Zod 3.x repo-wide. Never mix majors. **Done in P2-03 (ADR 0039):** Zod 4, `zod` 4.6.5 exact repo-wide (`nestjs-zod` 5.5.0 and `orval` 8.40.0 accept Zod 4).
  - NativeWind stable ↔ Tailwind major. Pin Tailwind to exactly what NativeWind's stable release requires.
  - PowerSync SDK ↔ Expo SDK / New Architecture: use the adapter PowerSync documents for your Expo SDK.

Legend: **P** = phase the dependency is first needed · `dev` = devDependency.

---

## 1. Root (monorepo tooling) — all `dev`

| Package | Purpose | P |
|---|---|---|
| `turbo` | Task pipeline, caching | P1 |
| `typescript` | Compiler | P1 |
| `@types/node` (24.x, major matches Node 24 per ADR 0015; ADR 0024) | Node.js type definitions for `@bricx/tsconfig/node.json` | P1 |
| `eslint` (10, flat config; ADR 0029) | Linting | P1 |
| `typescript-eslint` | TS lint rules | P1 |
| `eslint-plugin-boundaries` | Package/module import boundaries | P1 |
| `eslint-config-prettier` | Disable style rules that fight Prettier | P1 |
| `@eslint/js` (same major as `eslint`, enforced by `check:workspace`; ADR 0027, ADR 0029) | ESLint core recommended rules, including for JS/.mjs files | P1 |
| `eslint-import-resolver-typescript` (ADR 0025) | Resolves workspace packages and `.js`→`.ts` imports for `eslint-plugin-boundaries` | P1 |
| `handlebars` (4.7.10, released 2026-10-05; pnpm override in `pnpm-workspace.yaml`, never a direct dependency; ADR 0038) | Transitive dependency of `eslint-plugin-boundaries` and `@boundaries/elements`, forced from 4.7.9 to the release that fixes GHSA-p8wg-vrv2-v86f, GHSA-8r5x-fm3f-whwj and GHSA-xw65-4hp5-5hc7 | P1 |
| `prettier` | Formatting | P1 |
| `prettier-plugin-tailwindcss` | Class ordering | P7 |
| `vitest` (5.x; ADR 0028) | Unit/integration test runner | P1 |
| `@vitest/coverage-v8` (same version as `vitest`) | Coverage + thresholds | P1 |
| `vite` (in `@bricx/vitest-config`; ADR 0028) | Vitest 5's peer; pinned so vitest runs on a known version | P1 |
| `unplugin-swc` (in `@bricx/vitest-config`; ADR 0028) | swc transform in Vitest: decorator metadata for NestJS tests | P1 |
| `@swc/core` (in `@bricx/vitest-config`; ADR 0028) | Compiler used by `unplugin-swc` | P1 |
| `fast-check` (4.10.2, released 2026-09-19; `devDependency` of `packages/money` since P3-02 (ADR 0045) of `packages/i18n` since P3-03 (ADR 0046) and of `packages/validation` since P3-04 (ADR 0047) of `packages/permissions` since P3-05 (ADR 0048) and of `packages/domain` and `tooling/xstate-mirror` since P3-06 (ADR 0049), never of the root; its one dependency `pure-rand` 8.4.2, released 2026-07-10) | Property tests (money, ledger, allocation) | P3 |
| `husky` (9) | Git hooks; `prepare` installs them | P1 |
| `lint-staged` (17) | Pre-commit lint/format | P1 |
| `@commitlint/cli`, `@commitlint/config-conventional` (21, same version) | Conventional commits | P1 |
| `tsx` | Run TS scripts (seed, generators, CLIs) | P2 |

Since P1-03, `eslint` and `prettier` are root devDependencies, and the ESLint plugins and configs (`@eslint/js`, `typescript-eslint`, `eslint-plugin-boundaries`, `eslint-config-prettier`, `eslint-import-resolver-typescript`) are exact-pinned `dependencies` of `@bricx/eslint-config` (`tooling/eslint`), the package that imports them. `unrs-resolver` (a native dependency of `eslint-import-resolver-typescript`) has a postinstall script that stays unapproved in pnpm (ADR 0025).

Since P1-04, `vitest` and `@vitest/coverage-v8` are root devDependencies (the root runs the `vitest` binary). `vite`, `unplugin-swc` and `@swc/core` are exact-pinned `dependencies` of `@bricx/vitest-config` (`tooling/vitest`), the package that holds the presets; `apps/api` and `apps/worker` consume `unplugin-swc` and `@swc/core` through its `swcPreset` from P4, not as their own dependencies. `@swc/core` has a postinstall script that stays unapproved in pnpm; the native binary comes from its platform optional dependency (ADR 0028).

### `tooling/db-bootstrap` (P2-02; ADR 0035) — all `dev`

Integration tests for the Postgres bootstrap roles and PowerSync's replication healthcheck (Testcontainers, Docker required). Each version is the newest release at least 7 days old when added (2026-10-02); bumped 2026-10-13 (maint).

| Package | Purpose | P |
|---|---|---|
| `testcontainers` (12.2.0, released 2026-09-28) | Starts compose.yml's images in integration tests | P2 |
| `@testcontainers/postgresql` (12.2.0, released 2026-09-28; same version as `testcontainers`) | Postgres container with an init-aware wait strategy | P2 |
| `pg` (8.23.1, released 2026-09-30; the driver `packages/db` uses from P4) | Postgres client for the tests | P2 |
| `@types/pg` (8.23.1, released 2026-08-17) | Types for `pg` | P2 |

`testcontainers` pulls in `dockerode`, whose tree has three install scripts that stay unapproved in pnpm: `ssh2` (optional native crypto), `cpu-features` (node-gyp, optional dependency of `ssh2`) and `protobufjs` (postinstall version check). The integration tests pass without them (ADR 0035). Testcontainers' cleanup container image, `testcontainers/ryuk`, is pinned by digest in `@bricx/vitest-config` and listed in section 8.

### `tooling/xstate-mirror` (P3-06; ADR 0049) — all `dev`

Equivalence tests between `@bricx/domain`'s `toXStateConfig` output and XState v5 (132 tests over the fixture machines and fast-check random machines). The only place `xstate` is installed until P9-06; `apps/client` must install the same exact version or amend ADR 0049.

| Package | Purpose | P |
|---|---|---|
| `xstate` (5.33.2, released 2026-09-15; MIT, no dependencies, no install script) | The reference engine the domain machines are checked against | P3 |
| `fast-check` `dev` (4.10.2; see section 1) | Random machines and walks | P3 |

```bash
pnpm add -Dw turbo typescript eslint typescript-eslint eslint-plugin-boundaries eslint-config-prettier \
  prettier vitest @vitest/coverage-v8 fast-check husky lint-staged \
  @commitlint/cli @commitlint/config-conventional tsx
```

---

## 2. Shared packages

### `packages/ids`
| Package | Purpose |
|---|---|
| *(none)* | UUIDv7 (RFC 9562) is written in-house: `uuid` was dropped in P3-01 (ADR 0041), because with the injected clock it would only pack bytes, its monotonic path reads the real clock, and its Node entry loads `node:crypto`. No runtime or dev dependency beyond the workspace `@bricx/tsconfig` and `@bricx/vitest-config`. |

### `packages/money`
| Package | Purpose |
|---|---|
| `decimal.js` (10.6.0, released 2025-07-06; no dependencies, no install script; ADR 0045) | Exact FX rate math, rounding modes, allocation ratios; used through a private `Decimal.clone`, never the global configuration. Imported as a namespace and narrowed with `decimalConstructor()` since P4-08 (ADR 0058): its single CommonJS-typed `decimal.d.ts` types a default import as the whole module under `nodenext`, which `apps/api` uses |
| `zod` (4.6.5, ADR 0039) | Money schema (amount serialized as string) |
| `fast-check` `dev` (4.10.2; see section 1) | Property tests |

No Dinero.js (ADR C7). ISO 4217 data is a committed JSON file, not a package: `packages/money/data/iso4217.json`, generated by `packages/money/scripts/generate-iso4217.mjs` from a committed snapshot of `datasets/currency-codes` (ODC-PDDL-1.0, built from the SIX list-one and list-three files), pinned by commit and SHA-256 (ADR 0045). The owner cross-checks it against SIX with `--source six` before a refresh. Its import carries `with { type: "json" }` from P4-07 (ADR 0057), so Node loads the package as source.

### `packages/validation`
| Package | Purpose |
|---|---|
| `zod` (4.6.5, ADR 0039; ADR 0047) | Shared boundary schemas; `MoneySchema` is re-exported from `@bricx/money`, never redefined |
| `fast-check` `dev` (4.10.2; see section 1) | Property tests (error envelope never echoes input) |

From P4-07 (ADR 0057) `apps/api` consumes `@bricx/validation` as source: the package's JSON data imports carry `with { type: "json" }` so Node 24 loads them, and the api allows `.ts` import extensions (Metro/Hermes: must confirm at P7).

`libphonenumber-js` is **not** added: phone is a hand-written, format-only E.164 check (ADR 0047, ruling 1); it is deferred to P7 input formatting, which needs its own ADR and row (1.13.14 of 2026-09-24 was the newest version meeting the 7-day rule on 2026-10-14). Country and time-zone data are committed JSON files, not packages: `packages/validation/data/countries.json` (datasets/country-list `d214094`, ODC-PDDL-1.0) and `data/time-zones.json` (tzdb 2026e, public domain), generated by committed scripts from SHA-256-pinned snapshots (ADR 0047).

### `packages/i18n`
| Package | Purpose |
|---|---|
| `i18next` (26.4.2, released 2026-09-03; no dependencies, no preinstall/install/postinstall script, a `prepare` script registry installs never run; ADR 0046) | Translation runtime (`createInstance`, no global instance) |
| `i18next-icu` (2.5.0, released 2026-10-06; no install script; ADR 0046) | ICU MessageFormat plugin |
| `intl-messageformat` (12.1.3, released 2026-10-05; peer of i18next-icu, also imported directly for `i18n:check`; its dependencies `@formatjs/icu-messageformat-parser` 3.5.21, `@formatjs/icu-skeleton-parser` 2.1.12 and `@formatjs/fast-memoize` 3.1.7, released 2026-10-05, 2026-09-15 and 2026-07-11; ADR 0046) | ICU parser and formatter |
| `fast-check` `dev` (4.10.2; see section 1) | Property tests (resolveLocale and ICU signature oracles) |

### `packages/permissions`
| Package | Purpose |
|---|---|
| `@casl/ability` (7.0.1, released 2026-07-06; MIT, no install script; its dependency `@ucast/mongo2js` 2.0.0 pins `@ucast/core` 2.0.0, `@ucast/js` 4.0.1 and `@ucast/mongo` 3.0.0, Apache-2.0, released 2026-04-24; ADR 0048) | Ability engine (API + client) behind the fail-closed `can` and `accessibleQuery` |
| `fast-check` `dev` (4.10.2; see section 1) | Property tests (CASL against a hand-written grant evaluator) |

`zod` is **not** used by `packages/permissions` (ADR 0048, ruling 8): grants, context and records are checked by bounded hand-written guards, and nothing here parses a wire format. Internal edges: `@bricx/ids` (values) and `@bricx/i18n` (type-only `MessageKey`).

### `packages/domain`
| Package | Purpose |
|---|---|
| `fast-check` `dev` (4.10.2; see section 1) | Property tests (machine transitions against a list-scan oracle, bigint rounding oracle, no input in errors) |

`zod` is **not** used by `packages/domain` (ADR 0049, D13): the package parses no wire format, and its guards are bounded and hand-written. `xstate` is **not** installed here: `toXStateConfig` returns plain data, proved equivalent in `tooling/xstate-mirror` (below, section 1). Internal edges: `@bricx/money/rounding` (value: the `Rounding` enum) and `@bricx/i18n/keys` (type-only `MessageKey`); `@bricx/ids` is a devDependency for one type test. Unit factors and CLDR region defaults are committed data (`src/units-data.ts`; `data/region-units.json` generated from a SHA-256-pinned CLDR 48.2 `measurementData` snapshot, Unicode License V3), not packages.

### `packages/db`
| Package | Purpose |
|---|---|
| `drizzle-orm` (0.45.4, released 2026-10-08; installed in P4-02 for the schema helpers, ADR 0052; an `apps/api` devDependency from P4-03 for its integration test, ADR 0053, and a dependency of `apps/api` from P4-05 for `AuditService`, ADR 0055) | ORM / query builder |
| `pg` (8.23.1, released 2026-09-30; installed in P4-01 for `openDatabase`, ADR 0051; also the P4-02 migrator) | Postgres driver |
| `drizzle-kit` `dev` (0.31.11, released 2026-09-21; ADR 0052; brings `tsx`, `esbuild` and the deprecated `@esbuild-kit/*`, dev-only, esbuild build scripts ignored) | Migration generation |
| `@types/pg` `dev` (8.23.1, released 2026-08-17) | Types |

Internal edge (P4-04, ADR 0054): `@bricx/permissions` (workspace) for `rlsPolicies()`, imported only by `src/rls.ts`; `@bricx/permissions` never imports `@bricx/db` (tested). No new npm package.

### `packages/sync-schema`
| Package | Purpose |
|---|---|
| `drizzle-orm` | SQLite table definitions |
| `@powersync/common` | Schema types |
| `@powersync/drizzle-driver` | Drizzle ↔ PowerSync bridge |

### `packages/api-client`
| Package | Purpose |
|---|---|
| `@tanstack/react-query` (peer; installed at P7-01 with the hooks output, phase plan D9) | Generated hooks |
| `orval` `dev` (8.41.0, released 2026-10-08, installed in P4-08; MIT; peers `typedoc`, `typedoc-plugin-markdown` and `prettier` optional, not installed; its `undici` 7.29.1 has a `prepare` script pnpm never runs; ADR 0058) | OpenAPI → typed fetch client (hooks at P7-01) |
| `zod` (4.6.5, ADR 0039), `@bricx/validation` (workspace) | `src/fetcher.ts` re-parses a non-2xx body with `ErrorEnvelopeSchema` (ADR 0047) |

`src/generated/client.ts` is written by `pnpm gen:api` from the committed `openapi.json` (ADR 0058); both are ESLint- and Prettier-ignored, and CI fails when they are stale.

### `packages/config`
| Package | Purpose |
|---|---|
| `zod` | Env schema validation |

### `packages/ui`
| Package | Purpose |
|---|---|
| `nativewind` | Tailwind for React Native |
| `tailwindcss` `dev` | Version pinned to NativeWind's requirement |
| `@rn-primitives/*` (slot, portal, dialog, select, tabs, …) | Accessible headless primitives (React Native Reusables pattern) |
| `class-variance-authority` | Component variants |
| `clsx`, `tailwind-merge` | Class composition |
| `lucide-react-native` | Icons |

### `packages/adapters`
| Package | Purpose |
|---|---|
| `zod` | Validate provider payloads |
| *(no provider SDKs by default)* | Adapters call provider REST APIs with `fetch` — fewer transitive deps, full control of signatures and idempotency |

---

## 3. `apps/client` (Expo: iOS, Android, web PWA)

### Core (install with `npx expo install`)
| Package | Purpose | P |
|---|---|---|
| `expo`, `react`, `react-dom`, `react-native`, `react-native-web` | Platform | P7 |
| `expo-router` | File-based routing | P7 |
| `react-native-screens`, `react-native-safe-area-context` | Navigation deps | P7 |
| `react-native-gesture-handler`, `react-native-reanimated` | Gestures/animation (NativeWind, sheets) | P7 |
| `react-native-svg` | Icons, charts, web markups | P7 |
| `expo-dev-client` | Custom dev builds (native modules) | P7 |
| `expo-constants`, `expo-device`, `expo-application` | Device/app info, `X-Device-Id` | P7 |
| `expo-localization` | Device locale, timezone | P7 |
| `expo-linking` | Deep links | P7 |
| `expo-splash-screen`, `expo-status-bar`, `expo-font` | Shell | P7 |
| `expo-image` | Cached image display | P10 |
| `expo-updates` | OTA updates (EAS Update) | P13 |

### Auth & security
| Package | Purpose | P |
|---|---|---|
| `expo-auth-session`, `expo-web-browser`, `expo-crypto` | OIDC + PKCE with Keycloak | P7 |
| `expo-secure-store` | Token + device id storage | P7 |
| `expo-local-authentication` | Biometric app unlock | P7 |

### State, data, forms
| Package | Purpose | P |
|---|---|---|
| `@tanstack/react-query` | Server state | P7 |
| `zustand` | UI state | P7 |
| `xstate` (exactly the version pinned in `tooling/xstate-mirror`, 5.33.2, or ADR 0049 is amended in the same PR), `@xstate/react` | Approval / financial flows, built from `@bricx/domain`'s `toXStateConfig` | P9 |
| `react-hook-form`, `@hookform/resolvers` | Forms + Zod | P7 |
| `zod` | Validation | P7 |
| `react-i18next` (+ `@bricx/i18n`) | i18n bindings | P7 |
| `date-fns`, `@date-fns/tz` | Date math in project/user timezone | P7 |

### Offline sync
| Package | Purpose | P |
|---|---|---|
| `@powersync/react-native` | Native sync SDK | P8 |
| `@powersync/op-sqlite` + `@op-engineering/op-sqlite` | Native SQLite adapter (or the adapter PowerSync documents for your SDK) | P8 |
| `@powersync/web` + `@journeyapps/wa-sqlite` | Web sync SDK, SQLite WASM (OPFS/IndexedDB) | P8 |
| `@powersync/react` | React hooks over local DB | P8 |
| `@powersync/drizzle-driver`, `drizzle-orm` | Typed local queries | P8 |
| `@react-native-community/netinfo` | Connectivity state | P8 |

### Field capture & files
| Package | Purpose | P |
|---|---|---|
| `expo-camera` | Photo capture | P10 |
| `expo-image-picker` | Gallery import | P10 |
| `expo-image-manipulator` | Pre-upload resize/compress | P10 |
| `expo-location` | GPS, heading, geofence check | P10 |
| `expo-file-system` | Local files, upload tasks | P8 |
| `expo-background-task`, `expo-task-manager` | Background uploads/sync | P8 |
| `expo-document-picker` | Attach PDFs/docs | P10 |
| `expo-sharing`, `expo-print` | Share/print reports | P20 |
| `@turf/boolean-point-in-polygon`, `@turf/helpers` | On-device geofence check | P10 |

### Drawings, maps, charts
| Package | Purpose | P |
|---|---|---|
| `react-native-pdf` + `react-native-blob-util` | Native PDF rendering (ADR C10) | P10 |
| `@shopify/react-native-skia` | Native markup layer | P10 |
| `pdfjs-dist` | Web PDF rendering (`*.web.tsx` only) | P10 |
| `@maplibre/maplibre-react-native` | Native maps | P10 |
| `maplibre-gl` | Web maps (`*.web.tsx`) | P10 |
| `@tanstack/react-table` | Desktop data grids (web only) | P11 |
| `victory-native` | Native charts | P11 |
| `echarts` + `echarts-for-react` | Web/desktop dashboards | P11 |

### Notifications, realtime, monitoring
| Package | Purpose | P |
|---|---|---|
| `expo-notifications` | Push | P12 |
| `socket.io-client` | Live updates | P12 |
| `@sentry/react-native` | Crash/error reporting | P7 |

### Client dev
| Package | Purpose |
|---|---|
| `workbox-cli` `dev` | PWA service worker generation |
| `@storybook/react-native-web-vite` + `storybook` `dev` | Component catalogue (web) |
| `eas-cli` (global or `npx`) | Builds, submit, updates |

---

## 4. `apps/api` (NestJS modular monolith)

| Package | Purpose | P |
|---|---|---|
| `@nestjs/core`, `@nestjs/common` (11.2.7, released 2026-09-30; Nest 11, not 12, because `nestjs-zod` 5.5.0 peers `@nestjs/common` ^10 \|\| ^11; ADR 0051) | Framework | P4 |
| `@nestjs/platform-fastify` (11.2.7, released 2026-09-30; ADR 0051) | Fastify adapter | P4 |
| `fastify` (5.12.5, released 2026-09-16; pnpm override in `pnpm-workspace.yaml`, never a direct dependency; ADR 0051) | Transitive dependency of `@nestjs/platform-fastify` 11.2.7, which pins 5.11.3; forced to the release that fixes GHSA-667r-xxjv-c9mm, GHSA-p68q-wchp-6fh7, GHSA-hwr6-493r-vm6h, GHSA-9q9j-q6p8-xq58, GHSA-w2qp-rph6-63g4, GHSA-3m5p-2c4r-xxw2 and GHSA-4mh8-r7rc-xpvc | P4 |
| `reflect-metadata`, `rxjs` (0.2.2, released 2024-03-29; 7.8.2, released 2025-02-22) | Nest runtime deps | P4 |
| `@fastify/helmet`, `@fastify/cors`, `@fastify/cookie` (`@fastify/helmet` 13.1.1, released 2026-08-19, installed in P4-01; `@fastify/cors` is not a direct dependency: `app.enableCors` uses the 11.3.0 that `@nestjs/platform-fastify` depends on; `@fastify/cookie` waits for the P5 web BFF; ADR 0051) | Security headers, CORS, web BFF cookie | P4 |
| `@nestjs/terminus` (11.1.1, released 2026-02-18; ADR 0051) | Health checks | P4 |
| `@nestjs/throttler` | Rate limiting | P5 |
| `nestjs-pino`, `pino`, `pino-http` (5.3.1, released 2026-10-02; 10.4.0, released 2026-10-02; 11.0.0, released 2025-10-04, a `nestjs-pino` peer; ADR 0051) | Structured logging | P4 |
| `@nestjs/swagger` (11.4.7, released 2026-08-17, installed in P4-08; MIT; 12.x peers Nest 12; ADR 0058). Its `swagger-ui-dist` 5.32.13 and `lodash` are unused (no UI is served), and `swagger-ui-dist` depends on `@scarf/scarf` 1.4.0, an install-time telemetry `postinstall` that pnpm never runs (no dependency build script is allow-listed) and that CI also disables with `SCARF_ANALYTICS=false`; `@nestjs/mapped-types` 2.1.1 (`prepare`, never run) comes with it | OpenAPI document (built in `createApp()`, served at `GET /openapi.json`) | P4 |
| `js-yaml` (5.4.3, released 2026-10-05, for `@nestjs/swagger` only; scoped pnpm override `@nestjs/swagger>js-yaml` in `pnpm-workspace.yaml`, never a direct dependency; ADR 0058) | Transitive dependency of `@nestjs/swagger` 11.4.7, which pins 5.3.0; forced to the release that fixes GHSA-r3ph-w7gj-g6xm. `orval` and `cosmiconfig` keep their own `js-yaml` 4.3.2 | P4 |
| `nestjs-zod`, `zod` (`nestjs-zod` 5.5.0, released 2026-07-25, installed in P4-08, MIT, ADR 0058: `createZodDto` DTOs, `ZodResponse`, `ZodSerializerInterceptor`, `cleanupOpenApiDoc`; its validation pipe is not used, the api's `ZodValidationPipe` parses DTOs through `@bricx/validation`'s `parseAtBoundary()`. `zod` 4.6.5, ADR 0039, an `apps/api` dependency from P4-07, ADR 0057) | Zod DTOs → OpenAPI, response serialization | P4 |
| `@bricx/money` (workspace, from P4-08, ADR 0058) | The `Money` codec DTO (`MoneySchema`); the api type-checks the package's sources under `nodenext`, which is why `decimal.ts` narrows `decimal.js`'s default export | P4 |
| `@bricx/permissions` (workspace, from P4-09, ADR 0059) | `can()`, `accessibleQuery()`, `buildAbility()` and `grantsForRole()` for module policies and the pre-P5 `abilityFor()` stand-in (`src/common/auth/ability.ts`) | P4 |
| `drizzle-orm`, `pg` (via `@bricx/db`) | Database | P4 |
| `ioredis` (6.0.0, released 2026-07-31, installed in P4-01 for the Valkey readiness probe; ADR 0051). `@nestjs/bullmq` and `bullmq` are not API dependencies: the API writes outbox rows in the request's transaction and the worker's relay is the only queue producer (P4-06, ADR 0056; Semgrep `bricx-bullmq-outside-worker`) | Valkey readiness probe | P4 |
| `jose` | JWT/JWKS verification; PowerSync token signing | P5 |
| `@keycloak/keycloak-admin-client` | Session revocation, user provisioning | P5 |
| `@casl/ability` (via `@bricx/permissions`) | Authorization | P5 |
| `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io` | Live updates | P12 |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` (`@aws-sdk/client-s3` 3.1147.0, released 2026-10-06, moved to P4 for the S3 readiness probe, ADR 0051; the presigner stays P8) | Multipart presigned uploads | P8 |
| `@aws-sdk/client-kms` | Envelope encryption for bank details/IDs | P16 |
| `@aws-sdk/client-secrets-manager` | Secrets at boot | P13 |
| `decimal.js` (via `@bricx/money`) | FX math | P9 |
| `canonicalize` (5.1.0, released 2026-09-18, installed in P4-05 for the audit hash chain, ADR 0055; Apache-2.0, no dependencies, no install scripts; the idempotency fingerprint from P4-07, ADR 0057) | RFC 8785 canonical JSON for audit/ledger hash chains and idempotency fingerprints | P4 |
| `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/exporter-metrics-otlp-proto` | Tracing/metrics | P13 |
| `@sentry/nestjs` | Error reporting | P4 |

Dev: `@nestjs/cli`, `@nestjs/testing`, `testcontainers`, `@testcontainers/postgresql`, `supertest`, `@types/supertest`. P4-01 installs only `testcontainers` (12.2.0, section 1) and the workspace packages `@bricx/db-bootstrap`, `@bricx/tsconfig`, `@bricx/vitest-config`; the integration tests reuse `@bricx/db-bootstrap`'s Postgres and S3 helpers, and Fastify's `inject` replaces `supertest` (ADR 0051). Vitest with `unplugin-swc` and `@swc/core` comes through `@bricx/vitest-config` (`swcPreset`; section 1, ADR 0028).

```bash
pnpm --filter api add @nestjs/core @nestjs/common @nestjs/platform-fastify reflect-metadata rxjs \
  @fastify/helmet @fastify/cors @fastify/cookie @nestjs/terminus @nestjs/throttler \
  nestjs-pino pino pino-http @nestjs/swagger nestjs-zod zod ioredis \
  jose @keycloak/keycloak-admin-client canonicalize @sentry/nestjs
pnpm --filter api add -D @nestjs/cli @nestjs/testing "@bricx/vitest-config@workspace:*" \
  testcontainers @testcontainers/postgresql supertest @types/supertest
```

---

## 5. `apps/worker` (BullMQ workers + outbox relay)

| Package | Purpose | P |
|---|---|---|
| `bullmq` (6.3.12, published 2026-10-09T08:06:08.682Z, 7-day rule met; MIT; integrity `sha512-zuPU+RbyiTzRtxVeokO0EotJ+PkHyAEXugEAYYyP+pm7bbJAbrvQR1SHW6MCUgA0e4C23/07dcOCymEe+GNGHw==`; installed in P4-06, ADR 0056) | The outbox relay publishes jobs (the only queue producer); queue consumers from P8 | P4 |
| `ioredis` (6.0.0, released 2026-07-31; same version as `apps/api`; ADR 0056) | The worker's Valkey connection, shared by BullMQ's queues; `CONFIG GET maxmemory-policy` at boot | P4 |
| `drizzle-orm`, `pg` (via `@bricx/db`) | Outbox relay (`openRelayDatabase().withRelayTx`, as `bricx_relay`), job writes | P4 |
| `pino` (10.4.0, released 2026-10-02; same version as `apps/api`; ADR 0056) | Structured logging | P4 |
| `@aws-sdk/client-s3` | Read/write objects | P8 |
| `sharp` | Thumbnails, image normalisation | P8 |
| `exifr` | EXIF time/GPS evidence extraction | P8 |
| `clamscan` | ClamAV daemon client (virus scan) | P8 |
| `@aws-sdk/client-ses` | E-mail | P12 |
| `expo-server-sdk` | Push delivery via Expo | P12 |
| `@react-pdf/renderer` | Templated PDF reports | P20 |
| `playwright` (Chromium only) | Complex HTML → PDF reports | P20 |
| OpenTelemetry packages (as API) | Tracing | P13 |
| `@sentry/node` | Error reporting | P4 |

`bullmq` 6.3.12 brings `tslib` 2.8.1, `semver` 7.8.5, `msgpackr` 2.1.0, `cron-parser` 5.10.1 and `node-abort-controller` 3.1.1; its peers `pg`, `redis`, `ioredis` and `bullmq-otel` are optional, and only `ioredis` is installed. `msgpackr`'s optional native accelerator `msgpackr-extract` 3.0.4 has an install script that stays unapproved in pnpm (precedent: `unrs-resolver`, `@swc/core`, `ssh2`); `msgpackr` falls back to pure JavaScript. The worker's devDependencies are `testcontainers` (section 1) and the workspace packages `@bricx/db-bootstrap`, `@bricx/ids`, `@bricx/tsconfig`, `@bricx/vitest-config` (P4-06, ADR 0056).

SMS and FX providers are called over HTTP from `packages/adapters` — no vendor SDKs.

---

## 6. Test & QA (outside Vitest)

| Tool | Purpose | How installed | P |
|---|---|---|---|
| `@playwright/test` | Web E2E | `dev` in `apps/client` | P7 |
| Maestro | Mobile E2E | CLI (curl installer), CI via Maestro action/cloud | P8 |
| k6 | Load tests | Binary / `grafana/k6` image | P14 |
| OWASP ZAP | DAST baseline | `zaproxy/action-baseline` in CI | P14 |

---

## 7. Security & supply chain (CI tools, not npm)

| Tool | Purpose | P |
|---|---|---|
| gitleaks (8.30.1; pinned Linux x64 binary + SHA-256, installed into `.tools/` by `pnpm tools:gitleaks`; ADR 0030) | Secret scanning (pre-commit + CI) | P1 |
| Semgrep (`semgrep/semgrep:1.179.0@sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b`, linux/amd64 `sha256:cab19964e6c93019934252a9cd591d9b27df1e5b5d1734b26f4069ae51c295f8`; published 2026-10-02, 7-day rule met; run by `scripts/semgrep.mjs` with `--network none`; rules written for this repo in `tooling/semgrep/rules`, no registry rules, `tooling/semgrep/MANIFEST.json` SHA-256 `c7290d5ad5f8a746c4375b9615ac37c8292c3067f49148801f5e6fe9c21068ea`; ADR 0032, ADR 0043) | SAST (CI security job: self-test, then scan) | P3 |
| Dependabot (`.github/dependabot.yml`; weekly, grouped, exact pins, never auto-merged, 7-day cooldown; ADR 0033, ADR 0044) | Dependency updates | P1 |
| Trivy | Container & IaC scanning | P13 |
| Syft | SBOM | P13 |
| cosign | Image signing | P13 |

---

## 8. Infrastructure & local services

### Local (Docker Compose, P2)
Exact `repo:tag` pins (ADR 0034). The sha256 digest of each lives next to it in `infrastructure/docker/compose.yml` (Ryuk's in `tooling/vitest/index.mjs`; Keycloak's in both stages of `infrastructure/docker/keycloak/Dockerfile`, which compose.yml builds, ADR 0060); `check:workspace` fails if a compose image is unpinned, tagged `latest`, or its `repo:tag` is not listed here.

| Image | Purpose |
|---|---|
| `postgis/postgis:18-3.6` | Postgres 18 + PostGIS (`wal_level=logical`; `pg_stat_statements` preloaded) |
| `valkey/valkey:8.1.10` | Cache, queues, revocation list |
| `chrislusf/seaweedfs:4.48` | S3-compatible storage, dev only (replaces `minio/minio` + `minio/mc`: community images no longer published; ADR 0034). Production is AWS S3. |
| `keycloak/keycloak:26.7.5` | Identity (Docker Hub copy of `quay.io/keycloak/keycloak`, published by the Keycloak project; ADR 0034). Base of the optimized dev and test image `infrastructure/docker/keycloak/Dockerfile` (`kc.sh build`), built by compose.yml and by `tooling/keycloak-realm`'s integration tests (ADR 0060) |
| `journeyapps/powersync-service:1.26.1` | Sync service (Open Edition) |
| `axllent/mailpit:v1.31.3` | E-mail capture |
| `clamav/clamav:1.4.6` | Virus scanning (1.4 LTS) |
| `grafana/otel-lgtm:0.34.0` | Dev observability (OTel Collector, Loki, Tempo, Prometheus, Grafana; no separate collector service) |
| `testcontainers/ryuk:0.14.0` | Testcontainers' cleanup container for integration tests, not a compose service (released 2025-09-26; pinned as `RYUK_IMAGE` in `@bricx/vitest-config`, which `check:workspace` checks is digest-pinned and listed here; mounts the Docker socket; ADR 0035) |

Postgres extensions: `postgis`, `pg_trgm`, `btree_gist`, `pgcrypto`, `pg_stat_statements`; `vector` (pgvector) in Release 3.

### Cloud & delivery (P13)
| Tool | Purpose |
|---|---|
| OpenTofu | IaC (AWS provider) |
| AWS: ECS Fargate, RDS PostgreSQL 18, RDS Proxy, ElastiCache for Valkey, S3, CloudFront, WAF, KMS, Secrets Manager, SES | Runtime |
| GitHub Actions (`actions/checkout`, `pnpm/action-setup`, `actions/setup-node`, `aws-actions/configure-aws-credentials`, `expo/expo-github-action`; every action pinned by full commit SHA with a version comment, ADR 0031. P1-06 pins: `actions/checkout` v7.0.1, `actions/setup-node` v7.0.0, `pnpm/action-setup` v6.1.0) | CI/CD |
| Expo EAS (Build, Submit, Update) | Mobile builds and OTA |
| Sentry | Error tracking |
| Grafana Cloud (or self-hosted LGTM) | Observability |
| Tolgee (self-hosted) | Translation management |

---

## 9. Release 2 additions

| Package | Where | Purpose | P |
|---|---|---|---|
| `xlsx` (SheetJS) | api, client web | BOQ import/export. **Install from the SheetJS CDN tarball** — the npm registry copy is outdated | P15 |
| `papaparse` | worker | Bank/mobile-money statement CSV import | P17 |
| `react-native-signature-canvas` | client | Inspection sign-off signatures | P19 |
| `ajv` | api | Validate versioned JSON-schema forms | P19 |

Payment gateways and mobile money (Orange Money, Afrimoney, Flutterwave, Paystack, Stripe, banks): **HTTP adapters, no SDKs**, each passing the adapter contract test kit (P17-01).

## 10. Release 3 additions

| Package | Where | Purpose | P |
|---|---|---|---|
| `xero-node` | adapters | Xero accounting | P21 |
| `intuit-oauth` (+ HTTP calls) | adapters | QuickBooks Online auth | P21 |
| `web-ifc` | client web | IFC parsing (WASM) | P22 |
| `@thatopen/components`, `@thatopen/components-front`, `@thatopen/fragments` | client web | BIM viewer | P22 |
| `three` | client web | 3D rendering (version pinned to That Open's requirement) | P22 |
| `ifcopenshell` (Python) | bim-worker | Quantity takeoff, model diff | P22 |
| `@clickhouse/client` | worker | Analytics writes/queries | P23 |
| PeerDB or Debezium | infra | Postgres → ClickHouse CDC | P23 |
| `meilisearch` | api | Search client (tenant tokens) | P23 |
| `pgvector` | api | Embeddings in Postgres | P23 |
| `@anthropic-ai/sdk` | api | Server-side LLM gateway | P23 |
| `@tauri-apps/cli`, `@tauri-apps/api` | apps/desktop | Only if ADR C21 trigger is met | P22 |

---

## 11. Explicitly banned (duplicates or conflicts)

| Banned | Use instead |
|---|---|
| `dinero.js`, `big.js`, `bignumber.js`, `currency.js` | `@bricx/money` + `decimal.js` |
| `moment`, `moment-timezone`, `dayjs`, `luxon` | `Intl` + `date-fns` + `@date-fns/tz` |
| `tamagui`, `styled-components`, `@emotion/*` | NativeWind |
| `redux`, `@reduxjs/toolkit`, `mobx`, `recoil`, `jotai` | Zustand + TanStack Query |
| `prisma`, `typeorm`, `sequelize`, `knex` | Drizzle |
| `formik`, `yup`, `joi`, `class-validator` | React Hook Form + Zod |
| `axios` | `fetch` (orval client) |
| `detox`, `jest` | Maestro, Vitest |
| `redis` (node-redis) | `ioredis` |
| `@react-native-async-storage/async-storage` for business data | PowerSync SQLite (secure store for secrets) |
| `formatjs`/`react-intl` | i18next + i18next-icu |
| `nx`, `lerna` | Turborepo |
