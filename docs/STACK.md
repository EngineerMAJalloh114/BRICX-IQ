# BRICX IQ — Corrected Tech Stack (v2)

Prepared for: Mohamed Abass Jalloh · Revision: 28 September 2026
Supersedes: *BRICX IQ — Recommended Tech Stack* (v1, same date)

This revision keeps every constraint and direction from v1 (TypeScript end-to-end, one Expo client, NestJS modular monolith, PostgreSQL, explicit offline sync, double-entry append-only finance). It **removes every "X or Y" that would block a build**, fixes technical conflicts between chosen tools, and adds the missing plumbing (outbox, tenancy context, sync scoping) that v1 implied but did not specify.

Spec section references (2.1–2.12) follow v1.

---

## 1. Corrections log (what changed and why)

| # | v1 said | v2 decision | Reason |
|---|---------|-------------|--------|
| C1 | PowerSync **or** custom outbox/inbox | **PowerSync (self-hosted Open Edition)**, writes uploaded through the NestJS API | Ships faster, keeps Postgres as source of truth, self-hosting satisfies owner control (2.9). Custom protocol stays a documented fallback only. |
| C2 | Postgres RLS "enforces isolation" for sync too | **RLS does not apply to logical replication.** PowerSync reads via a replication role that bypasses RLS. Tenant/project scoping for downloads must be duplicated in **PowerSync Sync Streams/sync rules**, generated from the same permission catalogue and covered by tests. | Otherwise a sync-rule bug leaks another tenant's data to devices, with RLS never consulted. |
| C3 | Drizzle + RLS (unspecified) | Every request runs inside a transaction that executes `SET LOCAL app.org_id / app.user_id / app.project_ids`; RLS policies read `current_setting(...)`. App connects as a **non-owner, non-BYPASSRLS** role. PgBouncer/RDS Proxy in **transaction** mode. | RLS is useless if the app role owns the tables or if session variables leak across pooled connections. |
| C4 | Keycloak **or** Auth0/Cognito | **Keycloak** (self-hosted) | Spec 2.9 owner control, no per-user SaaS cost at emerging-market scale, full session/device revocation. |
| C5 | Redis | **Valkey** (Redis-compatible, BSD licence; ElastiCache for Valkey) | Licence clarity and lower managed cost; BullMQ, ioredis work unchanged. |
| C6 | Enqueue BullMQ jobs directly | **Transactional outbox** table written in the same DB transaction; a relay publishes to BullMQ | A job enqueued outside the transaction can fire for a rolled-back payment, or be lost after a commit. Unacceptable for money. |
| C7 | Dinero.js / decimal library | Own `@bricx/money` package: amounts as **`bigint` minor units** (Postgres `BIGINT`), FX rates as **`NUMERIC(24,12)`** handled with **decimal.js**, minor-unit exponents from the ISO 4217 table (JPY 0, BHD 3, SLE 2, …) | Dinero.js v2 has sat in pre-release for years; money is core and must be owned. Never hard-code "2 decimals". |
| C8 | Tamagui **or** NativeWind | **NativeWind (Tailwind)** + React Native Reusables-style primitives in `packages/ui` | One styling system; Tailwind knowledge transfers to web-only screens. |
| C9 | i18next **or** FormatJS | **i18next + react-i18next + i18next-icu** (ICU MessageFormat), Intl for numbers/dates; **Tolgee** (self-hostable) for translation management | One runtime; ICU plurals/genders; self-host keeps owner control. |
| C10 | PDF.js for 2D drawings (all platforms) | **Web/desktop:** PDF.js. **Native (iOS/Android):** `react-native-pdf` for rendering + **react-native-skia** markup layer. Markups stored as a platform-neutral vector JSON in page coordinates. | PDF.js does not run natively in React Native without a WebView; field tablets need smooth native rendering offline. |
| C11 | That Open Engine + Three.js everywhere | BIM viewer is **web/desktop (PWA/Tauri) only**; tablets open it via browser/PWA. Native app shows linked element metadata, not the 3D model. | web-ifc (WASM) + WebGL is not a supported path inside React Native; BIM is optional per v1. |
| C12 | tus **or** S3 multipart | **S3 multipart with presigned part URLs**, resumable from a local upload queue | No extra tus server; works with any S3-compatible store. |
| C13 | Maestro **or** Detox | **Maestro** (mobile E2E), **Playwright** (web E2E) | One choice; Maestro handles flaky field-network scenarios simply. |
| C14 | Turborepo **or** Nx | **Turborepo + pnpm workspaces** | Lighter, first-class Expo monorepo support. |
| C15 | Node.js LTS (unversioned) | **Node.js 24 LTS**, pinned via `.nvmrc` and `engines`; **PostgreSQL 18** (native `uuidv7()`), fall back to 17 + app-side UUIDv7 only if the managed provider lags | Explicit versions make builds reproducible for Claude Code. |
| C16 | OpenAPI client (unspecified) | **nestjs-zod** (Zod → DTO + OpenAPI) and **orval** (OpenAPI → typed fetch client + TanStack Query hooks) into `packages/api-client` | Zod stays the single source of validation truth; client never drifts from server. |
| C17 | Hash chaining "optional" | **Required for `audit_events` and `journal_entries`**, one chain per organization, appended under `pg_advisory_xact_lock(org)` | Financial auditability (2.12). Concurrency must be serialized per chain or the chain forks. |
| C18 | Webhooks (generic) | Store **raw payload + headers** in `payment_webhook_events` before processing; verify signature; dedupe by provider event id; process via outbox | Payments are only "confirmed" by verified evidence; replay must be possible. |
| C19 | Terraform | **OpenTofu** (Terraform-compatible) — Terraform acceptable if the team already licenses it | Open licence, same HCL. |
| C20 | "Multi-region" | **Region cells**: one full stack per residency region (start: `af-south-1` Cape Town + `eu-west-1`), a thin global **directory service** routes an organization to its cell. No cross-region replication of tenant data. | Data residency (3.1) without distributed transactions. |
| C21 | Tauri later (vague) | PWA only until a named trigger: offline model storage > browser quota, or native file-system watch. Then **Tauri 2** wrapping the same web build. | Avoids a second build target without a reason. |
| C22 | Search: Postgres FTS first | Keep; add **pg_trgm** for fuzzy supplier/material names; **Meilisearch** only in Release 3 | Unchanged direction, explicit trigger. |

---

## 2. Final stack (no open choices)

| Layer | Choice |
|-------|--------|
| Language | TypeScript (strict) everywhere; Python only in the BIM worker (Release 3) |
| Client | Expo (latest stable SDK, New Architecture) + Expo Router + React Native Web; PWA for desktop |
| Styling / UI | NativeWind + `packages/ui` primitives; web-only heavy grids with **TanStack Table** (`*.web.tsx`) |
| Client state | TanStack Query (server), Zustand (UI), XState (financial/approval flows) |
| Forms | React Hook Form + Zod resolver |
| Offline | PowerSync SDK (`@powersync/react-native`, `@powersync/web`) + `@powersync/drizzle-driver`; OP-SQLite/expo-sqlite adapter on native, wa-sqlite (OPFS) on web |
| Backend | Node.js 24 LTS + NestJS (modular monolith), Fastify adapter |
| Validation | Zod (shared), nestjs-zod |
| API | REST + OpenAPI 3.1, WebSockets (Socket.IO gateway) for live updates, signed outbound webhooks |
| DB | PostgreSQL 18 + PostGIS + pg_trgm + JSONB; RDS/Aurora; RDS Proxy (transaction pooling) |
| ORM | Drizzle ORM + drizzle-kit migrations (SQL reviewed and committed) |
| Jobs | Valkey + BullMQ, fed by transactional outbox relay |
| Files | S3 + CloudFront; presigned multipart; ClamAV scan worker; Sharp thumbnails; EXIF extraction |
| Identity | Keycloak (OIDC, PKCE, MFA/TOTP, passkeys/WebAuthn) |
| Authorization | Permission catalogue `resource.action.scope` → CASL abilities (API + client) → Postgres RLS (data) → PowerSync sync streams (device data) |
| i18n | i18next + i18next-icu, Intl APIs, Tolgee; RTL from day one |
| Money | `@bricx/money` (bigint minor units, decimal.js FX), ISO 4217, append-only `exchange_rates` |
| Ledger | Double-entry, append-only, hash-chained, balance enforced by deferred constraint trigger |
| Maps | MapLibre GL (web) / `@maplibre/maplibre-react-native`; PostGIS geofences |
| Notifications | Expo Notifications (FCM/APNs), SMS via adapter (Africa's Talking / Twilio), e-mail via Amazon SES |
| Reports/PDF | React-PDF for templated documents; Playwright/Chromium for complex HTML reports (worker) |
| BIM | R1: none. R2: none. R3: That Open Engine (web-ifc, @thatopen/components) web-only + IfcOpenShell Python worker |
| Analytics | Postgres read-models (materialized views) → ClickHouse in Release 3 |
| Infra | Docker, AWS (ECS Fargate, RDS, ElastiCache Valkey, S3, CloudFront, WAF, KMS, Secrets Manager), OpenTofu |
| CI/CD | GitHub Actions, Turborepo remote cache, Expo EAS Build/Submit/Update |
| Observability | OpenTelemetry → Grafana (Tempo/Loki/Prometheus or Grafana Cloud), Sentry (client + API) |
| Testing | Vitest (+ unplugin-swc for Nest decorators), Testcontainers, Playwright, Maestro, k6 |
| Security tooling | Dependabot/Renovate, gitleaks, Semgrep, OWASP ZAP baseline, Trivy (images) |

---

## 3. Architecture (unchanged shape, corrected wiring)

```
 Mobile/Tablet (Expo)   Web + Desktop PWA   Client & Owner Portals
          \                    |                    /
           ---- CloudFront / WAF / ALB --------------
                               |
      Global Directory (org → region cell)  ── Keycloak (per cell)
                               |
   NestJS API (modular monolith, per cell)
   identity | tenancy | projects | field | inventory | procurement
   finance/ledger | boq | documents | quality-safety | rfis
   messaging | localization | audit | sync-upload | files
                               |
   PostgreSQL (RLS) ── outbox ──> relay ──> BullMQ (Valkey)
        |  logical replication                  |
   PowerSync Service ──> devices (SQLite)   Workers: payments, FX,
                                            files/AV/thumbs, notifications,
                                            reports, (R3) BIM, analytics ETL
                               |
   Adapters: mobile money, gateways, banks, accounting, SMS, e-mail, FX
```

Write path for offline data: device SQLite → PowerSync upload queue → **`POST /sync/upload` on NestJS** (validation, CASL, RLS, conflict rules, audit) → Postgres → replicated back down. Devices never write to Postgres directly.

---

## 4. Non-negotiable rules (encode these in CLAUDE.md)

1. No floating-point for money, ever. `bigint` minor units + currency code.
2. Ledger and audit tables: app role has `INSERT, SELECT` only. Corrections are reversing entries.
3. Every tenant table has `org_id`, an RLS policy, and a sync-stream scoping test.
4. Every write that triggers side effects writes an outbox row in the same transaction.
5. IDs are UUIDv7, generated client-side for syncable entities.
6. All timestamps `timestamptz` in UTC; render in user/project zone.
7. No user-facing string without an i18n key; no hard-coded currency, unit, or date format.
8. Financial records never auto-merge on sync conflict.
9. Segregation of duties enforced server-side (requester ≠ approver).
10. Payments are confirmed only by verified webhook or server-to-server verification.
