# Architecture Decision Records

Decisions 0001–0022 map 1:1 to the corrections log (C1–C22) in [`docs/STACK.md`](../STACK.md). 0023 records the dependency policy from [`docs/DEPENDENCIES.md`](../DEPENDENCIES.md); later ADRs record decisions made during ROADMAP tasks.
Format: MADR (Status, Date, Deciders, Context, Decision, Consequences, Alternatives rejected). Superseding a decision needs a new ADR; accepted ADRs are not rewritten.

Open business decisions: [`pending.md`](pending.md).

| # | Title | Status | Decision |
|---|-------|--------|----------|
| [0001](0001-offline-sync-powersync.md) | Offline sync: PowerSync | Accepted | Self-hosted PowerSync Open Edition; device writes go through the NestJS API. |
| [0002](0002-sync-streams-scope-device-data.md) | Sync streams duplicate tenant scoping | Accepted | RLS does not cover replication; sync streams are generated from the permission catalogue and leak-tested. |
| [0003](0003-rls-transaction-context-and-pooling.md) | RLS context and pooling | Accepted | `SET LOCAL` context per transaction, non-owner non-BYPASSRLS app role, transaction-mode pooling. |
| [0004](0004-identity-keycloak.md) | Identity: Keycloak | Accepted | Self-hosted Keycloak (OIDC, PKCE, MFA, passkeys). |
| [0005](0005-cache-queue-store-valkey.md) | Cache and queues: Valkey | Accepted | Valkey instead of Redis; BullMQ and ioredis unchanged. |
| [0006](0006-transactional-outbox.md) | Transactional outbox | Accepted | Side effects are written to an outbox in the same transaction; a relay publishes to BullMQ. |
| [0007](0007-money-bigint-minor-units.md) | Money: `@bricx/money` | Accepted | `bigint` minor units + ISO 4217 code; FX `NUMERIC(24,12)` with decimal.js. |
| [0008](0008-styling-nativewind.md) | Styling: NativeWind | Accepted | NativeWind (Tailwind) with Reusables-style primitives in `packages/ui`. |
| [0009](0009-i18n-i18next-icu-tolgee.md) | i18n: i18next + ICU, Tolgee | Accepted | i18next + i18next-icu, Intl APIs, self-hosted Tolgee; RTL from day one. |
| [0010](0010-drawings-pdfjs-web-native-pdf.md) | 2D drawings | Accepted | PDF.js on web; react-native-pdf + Skia on native; vector JSON markups. |
| [0011](0011-bim-viewer-web-desktop-only.md) | BIM viewer web/desktop only | Accepted | BIM viewer only on web/desktop; native shows linked metadata. |
| [0012](0012-uploads-s3-multipart.md) | Uploads: S3 multipart | Accepted | Presigned multipart uploads, resumable from a local queue. |
| [0013](0013-e2e-maestro-playwright.md) | E2E: Maestro + Playwright | Accepted | Maestro for mobile, Playwright for web. |
| [0014](0014-monorepo-turborepo-pnpm.md) | Monorepo: Turborepo + pnpm | Accepted | Turborepo with pnpm workspaces. |
| [0015](0015-runtime-node24-postgres18.md) | Runtimes: Node 24, Postgres 18 | Accepted | Node.js 24 LTS and PostgreSQL 18; Postgres 17 fallback only if the provider lags. |
| [0016](0016-api-contract-nestjs-zod-orval.md) | API contract: nestjs-zod + orval | Accepted | Zod → OpenAPI via nestjs-zod; orval generates the typed client. |
| [0017](0017-hash-chained-audit-and-journal.md) | Hash-chained audit and journal | Accepted | Required per-org hash chain on `audit_events` and `journal_entries` under an advisory lock. |
| [0018](0018-payment-webhook-evidence.md) | Payment webhook evidence | Accepted | Store raw payload + headers, verify signature, dedupe, process via outbox. |
| [0019](0019-iac-opentofu.md) | IaC: OpenTofu | Accepted | OpenTofu; Terraform only if already licensed. |
| [0020](0020-region-cells-data-residency.md) | Region cells | Accepted | One stack per residency region, global directory routes orgs; no cross-region tenant data. |
| [0021](0021-desktop-pwa-until-tauri-trigger.md) | Desktop: PWA until Tauri trigger | Accepted | PWA only; Tauri 2 when a named trigger is met. |
| [0022](0022-search-postgres-fts-pg-trgm.md) | Search: Postgres FTS + pg_trgm | Accepted | Postgres FTS + pg_trgm; Meilisearch only in Release 3. |
| [0023](0023-dependency-policy.md) | Dependency policy | Accepted | DEPENDENCIES.md is the allow-list; exact pins; `npx expo install`; new dependency needs an ADR. |
| [0024](0024-types-node-24.md) | `@types/node` 24.x | Accepted | Root devDependency; major tracks the Node 24 runtime; loaded only by `node.json`. |
| [0025](0025-eslint-import-resolver-typescript.md) | `eslint-import-resolver-typescript` | Accepted | Import resolver for eslint-plugin-boundaries; `unrs-resolver` postinstall stays unapproved. |
| [0026](0026-typescript-stays-on-5-9.md) | TypeScript stays on 5.9.x | Accepted | Stay on 5.9.3; typescript-eslint 8.71.0 rejects TS 7; revisit when typescript-eslint supports TS 7 (#10940). |
| [0027](0027-eslint-js-recommended.md) | `@eslint/js` recommended | Accepted | ESLint core recommended rules on TS and JS/.mjs; version tracks `eslint`. |
