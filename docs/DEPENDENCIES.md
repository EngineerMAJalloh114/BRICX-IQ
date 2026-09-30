# BRICX IQ — Dependency List

Source of truth for every package allowed in the repo, per workspace and per phase.
Anything not listed here needs an ADR before it is added (CLAUDE.md rule: no duplicate tools).

## Version policy

- **Pin exact versions** in `package.json` (`save-exact=true` in `.npmrc`). Renovate raises upgrades.
- **Runtime baselines:** Node.js 24 LTS · pnpm 10.x · TypeScript 5.x (strict) · PostgreSQL 18 · Valkey 8.x.
- **Expo-managed packages** (`expo-*`, `react`, `react-native`, `react-native-*` in the Expo SDK) are installed with `npx expo install` so versions match the SDK. Never hand-pick their versions.
- **Compatibility checks at P1** (verify before locking, record in ADR):
  - Zod 4 + `nestjs-zod` + `orval`. If any lags, use Zod 3.x repo-wide. Never mix majors.
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
| `eslint` (9, flat config) | Linting | P1 |
| `typescript-eslint` | TS lint rules | P1 |
| `eslint-plugin-boundaries` | Package/module import boundaries | P1 |
| `eslint-config-prettier` | Disable style rules that fight Prettier | P1 |
| `@eslint/js` (same version as `eslint`) | ESLint core recommended rules, including for JS/.mjs files | P1 |
| `eslint-import-resolver-typescript` (ADR 0025) | Resolves workspace packages and `.js`→`.ts` imports for `eslint-plugin-boundaries` | P1 |
| `prettier` | Formatting | P1 |
| `prettier-plugin-tailwindcss` | Class ordering | P7 |
| `vitest` | Unit/integration test runner | P1 |
| `@vitest/coverage-v8` | Coverage + thresholds | P1 |
| `fast-check` | Property tests (money, ledger, allocation) | P3 |
| `husky` | Git hooks | P1 |
| `lint-staged` | Pre-commit lint/format | P1 |
| `@commitlint/cli`, `@commitlint/config-conventional` | Conventional commits | P1 |
| `tsx` | Run TS scripts (seed, generators, CLIs) | P2 |

Since P1-03, `eslint` and `prettier` are root devDependencies, and the ESLint plugins and configs (`@eslint/js`, `typescript-eslint`, `eslint-plugin-boundaries`, `eslint-config-prettier`, `eslint-import-resolver-typescript`) are exact-pinned `dependencies` of `@bricx/eslint-config` (`tooling/eslint`), the package that imports them. `unrs-resolver` (a native dependency of `eslint-import-resolver-typescript`) has a postinstall script that stays unapproved in pnpm (ADR 0025).

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
| `uuid` (v11+) | UUIDv7 generation (`v7()`) |

### `packages/money`
| Package | Purpose |
|---|---|
| `decimal.js` | Exact FX rate math, rounding modes |
| `zod` | Money schema (amount serialized as string) |

No Dinero.js (ADR C7). ISO 4217 data is a committed JSON file, not a package.

### `packages/validation`
| Package | Purpose |
|---|---|
| `zod` | Shared schemas |
| `libphonenumber-js` | E.164 phone validation/formatting |

### `packages/i18n`
| Package | Purpose |
|---|---|
| `i18next` | Translation runtime |
| `i18next-icu` | ICU MessageFormat plugin |
| `intl-messageformat` | Peer of i18next-icu |

### `packages/permissions`
| Package | Purpose |
|---|---|
| `@casl/ability` | Ability engine (API + client) |
| `zod` | Catalogue validation |

### `packages/domain`
| Package | Purpose |
|---|---|
| `zod` | Domain schemas |
| *(internal)* `@bricx/ids`, `@bricx/money` | Only allowed deps |

### `packages/db`
| Package | Purpose |
|---|---|
| `drizzle-orm` | ORM / query builder |
| `pg` | Postgres driver |
| `drizzle-kit` `dev` | Migration generation |
| `@types/pg` `dev` | Types |

### `packages/sync-schema`
| Package | Purpose |
|---|---|
| `drizzle-orm` | SQLite table definitions |
| `@powersync/common` | Schema types |
| `@powersync/drizzle-driver` | Drizzle ↔ PowerSync bridge |

### `packages/api-client`
| Package | Purpose |
|---|---|
| `@tanstack/react-query` (peer) | Generated hooks |
| `orval` `dev` | OpenAPI → typed client + hooks |

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
| `xstate`, `@xstate/react` | Approval / financial flows | P9 |
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
| `@nestjs/core`, `@nestjs/common` | Framework | P4 |
| `@nestjs/platform-fastify` | Fastify adapter | P4 |
| `reflect-metadata`, `rxjs` | Nest runtime deps | P4 |
| `@fastify/helmet`, `@fastify/cors`, `@fastify/cookie` | Security headers, CORS, web BFF cookie | P4 |
| `@nestjs/terminus` | Health checks | P4 |
| `@nestjs/throttler` | Rate limiting | P5 |
| `nestjs-pino`, `pino`, `pino-http` | Structured logging | P4 |
| `@nestjs/swagger` | OpenAPI document | P4 |
| `nestjs-zod`, `zod` | Zod DTOs → OpenAPI | P4 |
| `drizzle-orm`, `pg` (via `@bricx/db`) | Database | P4 |
| `@nestjs/bullmq`, `bullmq`, `ioredis` | Queue producer (outbox relay lives in worker) | P4 |
| `jose` | JWT/JWKS verification; PowerSync token signing | P5 |
| `@keycloak/keycloak-admin-client` | Session revocation, user provisioning | P5 |
| `@casl/ability` (via `@bricx/permissions`) | Authorization | P5 |
| `@nestjs/websockets`, `@nestjs/platform-socket.io`, `socket.io` | Live updates | P12 |
| `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner` | Multipart presigned uploads | P8 |
| `@aws-sdk/client-kms` | Envelope encryption for bank details/IDs | P16 |
| `@aws-sdk/client-secrets-manager` | Secrets at boot | P13 |
| `decimal.js` (via `@bricx/money`) | FX math | P9 |
| `canonicalize` | RFC 8785 canonical JSON for audit/ledger hash chains | P4 |
| `@opentelemetry/sdk-node`, `@opentelemetry/auto-instrumentations-node`, `@opentelemetry/exporter-trace-otlp-proto`, `@opentelemetry/exporter-metrics-otlp-proto` | Tracing/metrics | P13 |
| `@sentry/nestjs` | Error reporting | P4 |

Dev: `@nestjs/cli`, `@nestjs/testing`, `unplugin-swc`, `@swc/core`, `testcontainers`, `@testcontainers/postgresql`, `supertest`, `@types/supertest`.

```bash
pnpm --filter api add @nestjs/core @nestjs/common @nestjs/platform-fastify reflect-metadata rxjs \
  @fastify/helmet @fastify/cors @fastify/cookie @nestjs/terminus @nestjs/throttler \
  nestjs-pino pino pino-http @nestjs/swagger nestjs-zod zod @nestjs/bullmq bullmq ioredis \
  jose @keycloak/keycloak-admin-client canonicalize @sentry/nestjs
pnpm --filter api add -D @nestjs/cli @nestjs/testing unplugin-swc @swc/core \
  testcontainers @testcontainers/postgresql supertest @types/supertest
```

---

## 5. `apps/worker` (BullMQ workers + outbox relay)

| Package | Purpose | P |
|---|---|---|
| `bullmq`, `ioredis` | Queue consumers | P4 |
| `drizzle-orm`, `pg` (via `@bricx/db`) | Outbox relay, job writes | P4 |
| `pino` | Logging | P4 |
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
| gitleaks | Secret scanning (pre-commit + CI) | P1 |
| Semgrep | SAST | P1 |
| Renovate (or Dependabot) | Dependency updates | P1 |
| Trivy | Container & IaC scanning | P13 |
| Syft | SBOM | P13 |
| cosign | Image signing | P13 |

---

## 8. Infrastructure & local services

### Local (Docker Compose, P2)
| Image | Purpose |
|---|---|
| `postgis/postgis:18-*` | Postgres 18 + PostGIS (`wal_level=logical`) |
| `valkey/valkey:8` | Cache, queues, revocation list |
| `minio/minio` (+ `minio/mc` init) | S3-compatible storage |
| `quay.io/keycloak/keycloak` | Identity |
| `journeyapps/powersync-service` | Sync service (Open Edition) |
| `axllent/mailpit` | E-mail capture |
| `clamav/clamav` | Virus scanning |
| `grafana/otel-lgtm` | Dev observability (OTel, Loki, Tempo, Prometheus, Grafana) |

Postgres extensions: `postgis`, `pg_trgm`, `btree_gist`, `pgcrypto`, `pg_stat_statements`; `vector` (pgvector) in Release 3.

### Cloud & delivery (P13)
| Tool | Purpose |
|---|---|
| OpenTofu | IaC (AWS provider) |
| AWS: ECS Fargate, RDS PostgreSQL 18, RDS Proxy, ElastiCache for Valkey, S3, CloudFront, WAF, KMS, Secrets Manager, SES | Runtime |
| GitHub Actions (`pnpm/action-setup`, `actions/setup-node`, `aws-actions/configure-aws-credentials`, `expo/expo-github-action`) | CI/CD |
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
