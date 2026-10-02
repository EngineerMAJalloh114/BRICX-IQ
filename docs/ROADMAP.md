# BRICX IQ — Master Implementation Roadmap

Built for Claude Code. Follow phase by phase, task by task, from an empty repository to production maintenance.
Stack source of truth: `docs/STACK.md` (v2). Working rules: `CLAUDE.md`.

---

## 0. How to use this roadmap with Claude Code

**One task = one Claude Code session = one branch = one PR.**

```
git switch -c <task-id>-<slug>          # e.g. p4-03-rls-context
claude                                   # start session at repo root
> /next-task                             # custom command: reads ROADMAP, finds first unchecked task
```

Per task, Claude Code must:

1. Read the task block, `CLAUDE.md`, and every file listed under **Touches**.
2. Enter plan mode, post the plan, wait for approval on tasks marked 🔒 (security, money, sync, migrations).
3. Write tests first for anything listed under **Done when**.
4. Implement. Run the **Verify** command until green.
5. Tick the checkbox in this file, append a line to `docs/PROGRESS.md`, commit with Conventional Commits (`feat(finance): …`).
6. Stop. Never start the next task in the same session.

**Task block format**

```
- [ ] ID — Title  🔒 (if gated)
  Goal:      one line
  Touches:   paths
  Steps:     numbered, concrete
  Done when: testable acceptance criteria
  Verify:    exact command(s)
```

**Legend:** 🔒 human review required before merge · ⛔ blocks everything after it · 🌍 affects data residency.

**Phase gates:** a phase is closed only when its **Exit criteria** pass in CI. Do not start a phase with an open gate behind it.

---

## Phase map

| Phase | Name | Release |
|-------|------|---------|
| P0 | Decisions & repository bootstrap | Foundations |
| P1 | Monorepo tooling, quality gates, CI skeleton | Foundations |
| P2 | Local development environment | Foundations |
| P3 | Shared domain packages (ids, money, i18n, validation, permissions) | Foundations |
| P4 | API foundation (DB, RLS context, audit, outbox, errors, OpenAPI) | Foundations |
| P5 | Identity, sessions, authorization | Foundations |
| P6 | Tenancy, region configuration, projects & sites | Foundations |
| P7 | Client foundation (Expo, UI, i18n, auth, shells) | Foundations |
| P8 | Offline sync & file pipeline | Foundations |
| P9 | Money, FX, double-entry ledger | Foundations |
| P10 | Field operations (tasks, daily logs, photos, attendance, 2D drawings) | MVP |
| P11 | Commercial core (material requests, inventory, budgets, expenditures) | MVP |
| P12 | Notifications & messaging basics | MVP |
| P13 | Cloud infrastructure & delivery pipeline | MVP |
| P14 | MVP hardening & launch | MVP |
| P15 | BOQ & estimating | Release 2 |
| P16 | Suppliers & procurement | Release 2 |
| P17 | Payment integrations & reconciliation | Release 2 |
| P18 | Change orders, RFIs, submittals | Release 2 |
| P19 | Quality, inspections, safety, punch lists | Release 2 |
| P20 | Client & owner portals, reporting | Release 2 |
| P21 | Accounting integrations | Release 3 |
| P22 | BIM phases 2–3 | Release 3 |
| P23 | Analytics, forecasting, AI-assisted search | Release 3 |
| P24 | Production operations & maintenance (continuous) | Ongoing |

---

## P0 — Decisions & repository bootstrap

- [x] **P0-01 — Record architecture decisions** ⛔
  Goal: freeze v2 decisions as ADRs so Claude Code never re-litigates them.
  Touches: `docs/adr/0001…0022-*.md`, `docs/STACK.md`
  Steps:
  1. Create one ADR per row of the STACK.md corrections log (C1–C22) using MADR format (Context, Decision, Consequences).
  2. Add `docs/adr/README.md` index.
  3. Add open business decisions as `docs/adr/pending.md`: launch regions, first 2–3 payment providers, launch languages, launch currencies.
  Done when: every C-row has an ADR with status `Accepted`; pending list exists.
  Verify: `ls docs/adr | wc -l` ≥ 23.

- [x] **P0-02 — Initialise repository**
  Goal: empty, reproducible repo.
  Touches: `.nvmrc`, `.npmrc`, `package.json`, `pnpm-workspace.yaml`, `.gitignore`, `.editorconfig`, `README.md`, `LICENSE`
  Steps:
  1. `git init`; `.nvmrc` = `24`; root `package.json` with `"packageManager": "pnpm@<latest 10.x>"`, `"engines": {"node": ">=24 <25"}`.
  2. `pnpm-workspace.yaml`: `apps/*`, `packages/*`, `tooling/*`.
  3. `.npmrc`: `auto-install-peers=true`, `strict-peer-dependencies=false` (Expo), `link-workspace-packages=true`, `save-exact=true`, `engine-strict=true`.
  4. Create empty dirs with `.gitkeep`: `apps/{client,api,worker}`, `packages/{domain,permissions,validation,i18n,money,ids,ui,api-client,adapters,db,sync-schema,config}`, `tooling/{eslint,tsconfig,vitest}`, `infrastructure/{tofu,docker,keycloak}`, `docs/{adr,runbooks}`.
  Done when: `pnpm install` succeeds on a clean clone.
  Verify: `pnpm install --frozen-lockfile`.

- [x] **P0-03 — Claude Code workspace**
  Goal: Claude Code has rules, commands, and guardrails.
  Touches: `CLAUDE.md`, `.claude/settings.json`, `.claude/commands/*.md`, `docs/PROGRESS.md`
  Steps:
  1. Commit `CLAUDE.md` from this kit.
  2. `.claude/settings.json`: allow `pnpm *`, `git status/diff/log/add/commit`, `docker compose *`; deny `git push --force`, `rm -rf /`, any `DROP`/`TRUNCATE` against non-local hosts, reading `.env.production*`.
  3. Commands: `/next-task`, `/verify` (runs `pnpm verify`), `/new-module <name>` (scaffolds a Nest module per P4 template), `/migration <name>`.
  4. `docs/PROGRESS.md` with a table: date, task id, PR, notes.
  Done when: `/next-task` in a fresh session returns P1-01.

---

## P1 — Monorepo tooling, quality gates, CI skeleton

- [x] **P1-01 — TypeScript base configs**
  Touches: `tooling/tsconfig/{base,node,react-native,web}.json`
  Steps: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `moduleResolution: bundler` (packages) / `nodenext` (api, worker). Packages export TS source via `exports` (`"types"` + `"default"` → `src/index.ts`) for internal consumption; compiled only for api/worker.
  Done when: an empty package extending base type-checks.
  Verify: `pnpm -r exec tsc --noEmit`.

- [x] **P1-02 — Turborepo pipeline**
  Touches: `turbo.json`, root `package.json` scripts
  Steps: tasks `build`, `typecheck`, `lint`, `test`, `test:integration`, `e2e`, `gen` (codegen); `dependsOn: ["^build"]` where needed; outputs declared; root script `verify = turbo run typecheck lint test`.
  Verify: `pnpm verify` (passes on empty packages).

- [x] **P1-03 — Lint, format, boundaries**
  Touches: `tooling/eslint/*`, `.prettierrc`, `eslint.config.mjs`
  Steps:
  1. ESLint flat config + typescript-eslint strict-type-checked; Prettier.
  2. `eslint-plugin-boundaries` (or `import/no-restricted-paths`) rules: `packages/*` never import `apps/*`; `packages/domain` imports nothing but `ids`, `money`; api modules import other modules only via their `public-api.ts`.
  3. Custom rules/bans: `no-restricted-syntax` banning `parseFloat`/`Number(` on identifiers named `*amount*|*price*|*total*` in `packages/money` consumers; ban `Date.now()` in domain (use injected `Clock`).
  Done when: a deliberate violation fails lint.
  Verify: `pnpm lint`.

- [x] **P1-03b — ESLint 10 migration**
  Touches: root `package.json`, `tooling/eslint/package.json`, `pnpm-lock.yaml`, `tooling/eslint-smoke/*`, `scripts/check-workspace-scripts.mjs`, `docs/adr/0029-*`, `docs/adr/pending.md`, `docs/DEPENDENCIES.md`
  Steps: evaluate ESLint 10 (latest `eslint` and `@eslint/js`, Node requirement, each plugin's declared `eslint` peer range, breaking changes, trial in a scratch clone); migrate only if every dependency supports it (GO), otherwise record ADR 0029 "Stay on ESLint 9 until <trigger>" (NO-GO). GO: exact pins, ADR 0029 (amends ADR 0027: `@eslint/js` major must equal `eslint` major, enforced by `check:workspace`), eslint-smoke fixture for a rule new in ESLint 10 recommended, DEPENDENCIES rows, pending.md ESLint row resolved.
  Done when: `pnpm verify` passes; eslint-smoke passes with every pre-existing fixture error unchanged; one real violation still fails verify; lint cache hits on a repeat run and an edit in `tooling/eslint` invalidates it; `pnpm install --frozen-lockfile` passes; `git status` clean.
  Verify: `pnpm verify`.

- [x] **P1-04 — Test harness**
  Touches: `vitest.config.mts` (root), `tooling/vitest/*` (`@bricx/vitest-config`), `tooling/vitest-smoke/*`
  Steps: Vitest projects in the root `vitest.config.mts` (`test.projects`; `vitest.workspace.ts` was deprecated in Vitest 3.2 and removed in 4); shared presets in `@bricx/vitest-config`: a default preset and an swc preset (`unplugin-swc`, decorator metadata) for api/worker; coverage via v8; thresholds keyed by path: `packages/money`, `packages/permissions`, `apps/api/src/modules/ledger` ≥ 95% lines; others ≥ 70%. `tooling/vitest-smoke` proves the thresholds, the swc preset and that zero tests fail. Every package under `apps/` and `packages/` needs a `test` script (`check:workspace`).
  Verify: `pnpm test`.

- [x] **P1-05 — Commit hygiene**
  Touches: `.husky/*`, `commitlint.config.cjs`, `.lintstagedrc`
  Steps: lint-staged (eslint --fix, prettier), commitlint conventional, gitleaks pre-commit.
  Verify: a commit with a fake AWS key is rejected.

- [x] **P1-06 — CI skeleton**
  Touches: `.github/workflows/ci.yml`, `.github/dependabot.yml` (or `renovate.json`), `.github/CODEOWNERS`, `.github/pull_request_template.md`
  Steps:
  1. Jobs: install (pnpm cache) → verify (`pnpm verify`, then `pnpm check:turbo-cache`), security (gitleaks self-test and full history, `pnpm audit --prod`) and pr-title, in parallel. Amended at P1-06 (ADR 0031): Turbo remote cache stays OFF; no integration job until the first Testcontainers test exists (add it with that test: P2-02 `db-roles.int.test.ts` or P4, whichever comes first); Semgrep deferred to the first P3 package with `src/` (ADR 0032).
  2. Required checks on `main`; squash merge only; CODEOWNERS requires owner review on `packages/money`, `apps/api/src/modules/{finance,ledger,identity,sync}`, `**/migrations/**`.
  3. PR template includes the task ID and the Done-when checklist.
  4. From P1-05 (ADR 0030): run gitleaks over the full git history with the pinned version and checksum, and check the PR title with commitlint (squash merges put the PR title on `main`, which the commit-msg hook never sees).
  Exit criteria P1: CI green on `main`; branch protection active.

---

## P2 — Local development environment

- [x] **P2-01 — Docker Compose stack** 🌍
  Touches: `infrastructure/docker/compose.yml`, `infrastructure/docker/*/`, `.env.example`
  Services: `postgres` (18 + PostGIS; `wal_level=logical`), `valkey`, `s3` (SeaweedFS, creates the dev bucket on startup; MinIO's community images are no longer published, ADR 0034), `keycloak` (dev mode, realm import), `powersync` (Open Edition, config mounted), `mailpit`, `clamav`, `grafana/otel-lgtm` (single-container dev observability, includes the OTel Collector).
  Steps: healthchecks on every service; named volumes; `pnpm dev:up` / `dev:down` / `dev:reset` scripts.
  Done when: all services healthy from cold start in < 3 min.
  Verify: `pnpm dev:up && docker compose ps --format json | jq -se 'length > 0 and all(.[]; .Health == "healthy")'` (`ps --format json` prints one object per line, hence `-s`; amended in P2-01).

- [x] **P2-02 — Database bootstrap roles** 🔒
  Touches: `infrastructure/docker/postgres/init/*` (the init script is `01-bootstrap.sh`, so role passwords come from the environment; amended in P2-02, ADR 0035)
  Steps: create roles `bricx_owner` (owns schema, runs migrations), `bricx_app` (LOGIN, NOBYPASSRLS, no DDL), `bricx_readonly` (reporting), `powersync_repl` (REPLICATION, SELECT on published tables); publication `powersync` (created empty, tables added by migrations); extensions `postgis`, `pg_trgm`, `btree_gist`, `pgcrypto`.
  Also (from P2-01, ADR 0034): remove the temporary superuser replication used by PowerSync; use `powersync_repl`. PowerSync health check must prove replication is streaming (replaces the liveness-only check).
  Done when: `bricx_app` cannot `CREATE TABLE` and cannot bypass RLS.
  Verify: integration test `db-roles.int.test.ts`. This is the first Testcontainers test: add the CI integration job with it (P1-06, ADR 0031); if P4 adds one first, add the job there.
  Done in P2-02 (ADR 0035): app tables in schema `bricx`, extensions in `extensions`; `powersync_repl` has BYPASSRLS; PowerSync storage as `powersync_storage_owner`; tests in `tooling/db-bootstrap` (`db-roles.int.test.ts`, `powersync-health.int.test.ts`), run by `pnpm test:integration` and the CI `integration` job.

- [ ] **P2-03 — Config & secrets loading**
  Touches: `packages/config/src/*`
  Steps: Zod-validated env schema per app (`api`, `worker`, `client-public`); fail fast on boot; `.env.example` complete; no secret in client bundle (only `EXPO_PUBLIC_*`).
  Verify: unit test: missing `DATABASE_URL` throws with a readable message.

- [ ] **P2-04 — Seed & fixtures framework**
  Touches: `packages/db/seed/*`
  Steps: deterministic seed (fixed UUIDv7s) creating 2 orgs in different regions, users for each system role, 1 project with 2 sites, currencies USD/EUR/SLE/NGN/KES/GHS, languages en/fr/ar (RTL test).
  Verify: `pnpm db:seed` twice is idempotent.
  Exit criteria P2: new developer (or Claude Code session) goes from clone to running API health check with `pnpm i && pnpm dev:up && pnpm db:migrate && pnpm db:seed`.

---

## P3 — Shared domain packages

- [ ] **P3-01 — `@bricx/ids`**
  Steps: UUIDv7 generator (`uuid` v7) with monotonic ordering per process; `Brand<'ProjectId'>` style branded types; parse/validate helpers.
  Done when: 1M ids generated in-process are strictly increasing and unique.

- [ ] **P3-02 — `@bricx/money`** 🔒 ⛔
  Touches: `packages/money/src/{currency,money,fx,allocate,format}.ts`, `data/iso4217.json`
  Steps:
  1. Generate `iso4217.json` (code, numeric, minor exponent, name) from the official list; include SLE (2) and keep SLL flagged historical.
  2. `Money { amount: bigint; currency: CurrencyCode }` immutable; `add/subtract` require same currency (throw otherwise); `multiply(ratio: Decimal, rounding)`; `allocate(ratios)` with largest-remainder so parts sum exactly.
  3. `convert(money, rate: Decimal, target, rounding = HALF_EVEN)` returns `{ money, rateUsed }`.
  4. `format(money, locale)` via `Intl.NumberFormat` with `maximumFractionDigits` from exponent.
  5. Zod schemas: `MoneySchema` serialises amount as **string** in JSON (bigint-safe).
  Done when: property tests (fast-check) prove `allocate` sums exactly, `add` is associative, round-trip JSON preserves value; JPY/BHD/SLE formatting tests pass.
  Verify: `pnpm --filter @bricx/money test -- --coverage`.

- [ ] **P3-03 — `@bricx/i18n`**
  Steps: key namespaces (`common`, `construction`, `finance`, `field`, `errors`, `validation`); glossary file `glossary.json` (`construction.change_order`, `finance.retention`, …) with definitions for translators; typed keys (i18next `CustomTypeOptions`); ICU enabled; `isRTL(locale)`; BCP 47 normalisation; fallback chain `project → user → device → en`.
  Done when: a missing key fails `pnpm i18n:check` (script compares all locale files against `en`).

- [ ] **P3-04 — `@bricx/validation`**
  Steps: Zod schemas for primitives (email, phone E.164, ISO country/currency, IANA zone, BCP 47, GeoPoint, `Money`), pagination/cursor, standard error envelope; `z.infer` types exported.

- [ ] **P3-05 — `@bricx/permissions`** 🔒 ⛔
  Touches: `packages/permissions/src/{catalogue,roles,ability,scopes}.ts`
  Steps:
  1. Catalogue as data: `resource.action.scope` where scope ∈ `own | site | project | org`; e.g. `finance.payment.approve.project`, `field.dailylog.create.site`.
  2. Default role bundles: Owner, Project Owner, Project Manager, Quantity Surveyor, Site Engineer, Foreman, Storekeeper, Accountant, Client, Consultant, Subcontractor, Auditor (read-only).
  3. `buildAbility(grants, context)` → CASL `MongoAbility` usable on API and client.
  4. Segregation-of-duties matrix: pairs that may not be held by the same actor on the same record (`request`/`approve`, `create PO`/`receive goods`, `record payment`/`reconcile`).
  5. Generator script outputs: RLS helper SQL fragments and PowerSync sync-stream fragments from the catalogue (consumed in P4-04, P8-02).
  Done when: snapshot test of the catalogue; ability tests for every default role × 10 sample actions.

- [ ] **P3-06 — `@bricx/domain` kernel**
  Steps: `Clock` interface, `Result` type, domain error classes, generic state-machine helper (`defineMachine({states, transitions, guards})`) used by server and mirrored by XState on client; units of measure (SI + imperial, conversion table, per-region default).
  Exit criteria P3: all packages ≥ coverage thresholds; zero `any`.

---

## P4 — API foundation

- [ ] **P4-01 — NestJS app skeleton**
  Touches: `apps/api/src/{main.ts,app.module.ts}`, `apps/api/src/common/*`
  Steps: Fastify adapter; Helmet; CORS allow-list from config; `nestjs-pino` structured logs with correlation id (`x-request-id`); graceful shutdown; `/health/live`, `/health/ready` (db, valkey, s3); URI versioning `/v1`.
  Verify: `curl localhost:3000/health/ready` → 200.

- [ ] **P4-02 — Drizzle & migrations** 🔒
  Touches: `packages/db/src/schema/*`, `packages/db/drizzle.config.ts`, `packages/db/migrations/*`
  Steps: schema split per module; shared column helpers (`id uuid default uuidv7()`, `orgId`, `createdAt/updatedAt timestamptz`, `createdBy`, `version integer`, `deletedAt`); migrations generated then **hand-reviewed**; `pnpm db:migrate` runs as `bricx_owner`; migration CI job applies to empty DB and to previous release snapshot.
  Also (from P2-02, ADR 0035): tables live in schema `bricx` (`pgSchema('bricx')`, drizzle-kit `schemaFilter: ['bricx']`; decide the migrations-table schema); the migration guard must reject `DROP PUBLICATION` and `CREATE PUBLICATION` (the `powersync` publication is never dropped or recreated: rows written while it is missing never replicate).
  Done when: rollback strategy documented (forward-only migrations; expand/contract pattern in `docs/runbooks/migrations.md`).

- [ ] **P4-03 — Request context & transactional unit of work** 🔒 ⛔
  Touches: `apps/api/src/common/db/{tx.ts,context.interceptor.ts}`
  Steps:
  1. `AsyncLocalStorage` request context: `userId, orgId, projectIds[], roles, deviceId, ip, geo?, correlationId`.
  2. `withTx(fn)` opens a transaction as `bricx_app`, runs `SET LOCAL app.org_id = …, app.user_id = …, app.project_ids = …` (use `set_config(..., true)`), then `fn(tx)`.
  3. All repositories receive `tx`; lint rule forbids importing the raw pool outside `common/db`.
  Done when: integration test proves a query with no context returns zero rows from tenant tables.

- [ ] **P4-04 — RLS policy framework** 🔒 ⛔
  Steps: SQL function `app.current_org()`, `app.has_project(uuid)`; migration helper `enableTenantRls(table, {projectScoped})` emitting `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY` + policies; CI script fails if any table with `org_id` lacks FORCE RLS.
  Done when: cross-tenant read/write attempts fail in tests for every table (parametrised test iterates information_schema).

- [ ] **P4-05 — Audit events** 🔒
  Touches: `modules/audit/*`, migration `audit_events`
  Steps: columns: `id, org_id, occurred_at, actor_id, actor_type, device_id, ip, geo, action, entity_type, entity_id, before jsonb, after jsonb, correlation_id, prev_hash, hash`; `REVOKE UPDATE, DELETE ON audit_events FROM bricx_app`; `AuditService.record()` inside the same tx, takes `pg_advisory_xact_lock(hashtext(org_id))`, computes `hash = sha256(prev_hash || canonical_json(row))`; `audit:verify` CLI walks a chain.
  Done when: tampering a row in test makes `audit:verify` fail at that row.

- [ ] **P4-06 — Transactional outbox** 🔒 ⛔
  Touches: `modules/outbox/*`, `apps/worker/src/relay/*`
  Steps: table `outbox(id, org_id, topic, payload jsonb, created_at, published_at, attempts)`; `OutboxService.enqueue(tx, topic, payload)`; relay in worker polls `FOR UPDATE SKIP LOCKED`, publishes to BullMQ with `jobId = outbox.id` (idempotent), marks published; dead-letter after N attempts with alert.
  Done when: test proves rolled-back transaction produces no job; committed one produces exactly one.

- [ ] **P4-07 — Error model & idempotency**
  Steps: RFC 9457 problem+json responses; error codes namespaced (`finance.approval.self_approval_forbidden`) and i18n-keyed; `Idempotency-Key` header middleware storing `(key, user, route, request_hash, response)` for 24h on all POST that create money or stock movements.
  Done when: replayed POST returns the identical response without a second write.

- [ ] **P4-08 — OpenAPI & client generation**
  Steps: nestjs-zod DTOs; `/openapi.json`; `pnpm gen:api` runs orval → `packages/api-client` (fetch + TanStack Query hooks, bigint amounts as strings); CI fails if generated client is stale.
  Verify: `pnpm gen:api && git diff --exit-code packages/api-client`.

- [ ] **P4-09 — Module template**
  Steps: reference module `modules/_template` (controller, service, repository, schema, policies, events, `public-api.ts`, tests); `/new-module` command copies it.
  Also (from P2-02, ADR 0035): pairing rule for synced tables: the migration that publishes a table runs `GRANT SELECT ON bricx.<table> TO powersync_repl` and `ALTER PUBLICATION powersync ADD TABLE bricx.<table>` together (unpublishing revokes in the same migration); `powersync_repl` never gets default privileges. Ledger and audit tables REVOKE the default UPDATE and DELETE from `bricx_app` (rule 2).
  Exit criteria P4: tenancy isolation, audit chain, outbox and idempotency integration suites green.

---

## P5 — Identity, sessions, authorization

- [ ] **P5-01 — Keycloak realm as code** 🔒
  Touches: `infrastructure/keycloak/realm-bricx.json`, `infrastructure/tofu/modules/keycloak/*`
  Steps: realm `bricx`; clients `bricx-client` (public, PKCE, redirect URIs for Expo scheme + web), `bricx-api` (bearer-only); access token TTL 5 min, refresh rotation on, refresh max 12h idle (configurable per org); MFA TOTP required for finance roles; WebAuthn passwordless enabled; brute-force detection; custom claims mapper `org_id` limited (authorisation data stays in BRICX DB, not tokens).
  Done when: realm import is reproducible from file.

- [ ] **P5-02 — API token validation**
  Steps: JWKS-cached verification (`jose`); map `sub` → `users` row (provisioned on first login); guard populates request context.
  Verify: expired, wrong-audience, and wrong-issuer tokens → 401 tests.

- [ ] **P5-03 — Devices & sessions**
  Steps: tables `devices(id, user_id, platform, name, last_seen, trusted, revoked_at)`, `sessions(id, user_id, device_id, keycloak_sid, created_at, revoked_at)`; client sends `X-Device-Id` (generated once, stored in secure store); endpoints: list my devices, revoke device, admin revoke user.
- [ ] **P5-04 — Immediate revocation** 🔒
  Steps: Valkey set `revoked:sid:*` and `revoked:user:*` with TTL ≥ access token TTL; guard checks on every request; revocation also calls Keycloak admin API to end sessions and emits `sync.revoke` so PowerSync credentials endpoint refuses new tokens.
  Done when: revoked user's next API call returns 401 within 1 s; next sync token request fails.

- [ ] **P5-05 — Grants, roles, project overrides** 🔒
  Steps: tables `roles` (org-editable bundles), `role_permissions`, `memberships(user, org, role)`, `project_memberships(user, project, role, overrides jsonb)`; API to edit bundles (permission `org.role.manage.org`); every change audited.
- [ ] **P5-06 — Temporary elevated access** 🔒
  Steps: `access_grants(user, permission, scope_id, reason, granted_by, starts_at, expires_at, revoked_at)`; ability builder includes only active grants; worker job expires and audits; UI shows countdown.
- [ ] **P5-07 — Authorization guard & SoD enforcement** 🔒 ⛔
  Steps: `@Can('finance.payment.approve', { scope: 'project', from: 'params.projectId' })` decorator → CASL check; `SodService.assert(actor, record, action)` in services; unit + integration tests for all SoD pairs.
  Exit criteria P5: security test suite (authn, revocation, RLS, SoD) green; 🔒 review by owner.

---

## P6 — Tenancy, region configuration, projects & sites

- [ ] **P6-01 — Global directory service** 🌍
  Steps: minimal table (in a separate `directory` DB per deployment) mapping `org_id → region_cell, api_base_url, keycloak_url`; public `GET /v1/directory/resolve?email_domain|org_slug`; client resolves cell before login.
- [ ] **P6-02 — Organizations** — CRUD, legal name, country (ISO 3166), default currency/language/timezone/units, data region (immutable after creation), branding.
- [ ] **P6-03 — Region configuration module**
  Steps: `region_configs` layered **org → project** overrides for: currency, reporting currency, language, timezone, date/number format, units, tax profile id, enabled payment adapters, accounting adapter, rate library; resolver returns effective config with provenance (which layer set each value).
- [ ] **P6-04 — Adapter registry**
  Steps: `packages/adapters/src/registry.ts` with interfaces `PaymentAdapter`, `TaxAdapter`, `AccountingAdapter`, `SmsAdapter`, `FxRateProvider`; each adapter declares supported countries/currencies; `NullAdapter` for development; registry validated at boot.
- [ ] **P6-05 — Projects & sites**
  Steps: `projects(code, name, client_org?, status, currency, reporting_currency, timezone, start/end, contract_value money)`, `sites(project_id, name, geom geography(Polygon), address, geofence_radius_m)`; PostGIS index; status machine `draft → active → on_hold → completed → archived`.
- [ ] **P6-06 — Members & invitations** — invite by e-mail/phone, accept flow creates Keycloak user, assigns role.
  Exit criteria P6: two orgs in two cells fully isolated; effective-config resolver tested for every overridable field.

---

## P7 — Client foundation

- [ ] **P7-01 — Expo app scaffold**
  Steps: `create-expo-app` into `apps/client` with Expo Router, TS, New Architecture; Metro monorepo defaults; `app.config.ts` reading env; bundle ids `com.bricxiq.app`; web output `static` + PWA manifest & service worker (Workbox) for installability.
  Verify: `pnpm --filter client start` runs on iOS sim, Android emulator, web.
- [ ] **P7-02 — Design system (`packages/ui`)**
  Steps: NativeWind config with tokens (colour, spacing, radius, typography) incl. dark mode; primitives: Button, Input, Select, Sheet, Dialog, Toast, Card, Badge, Tabs, DataList, MoneyText, DateText, EmptyState, SyncBadge; RTL-safe (`start/end` not `left/right`); Storybook for web.
- [ ] **P7-03 — Device-class shells**
  Steps: layout hook `useDeviceClass()` → `phone | tablet | desktop`; phone: bottom tabs with quick field actions; tablet: split view; desktop: sidebar + data-dense tables; route groups `(field)`, `(office)`, `(portal)`.
- [ ] **P7-04 — i18n runtime**
  Steps: i18next init with bundled `en` + runtime fetch of other locales from API/CDN (cached offline); language switcher; `I18nManager.forceRTL` handling with reload prompt on native; pseudo-locale for QA.
- [ ] **P7-05 — Auth flow**
  Steps: `expo-auth-session` OIDC PKCE against the resolved cell; tokens in `expo-secure-store` (native) / memory + refresh via httpOnly cookie through a thin BFF route on web; biometric app unlock option; logout clears local DB.
- [ ] **P7-06 — API client wiring** — TanStack Query provider, auth header injection, `X-Device-Id`, retries with backoff only for idempotent calls, problem+json → localized toast.
- [ ] **P7-07 — Error & crash reporting** — Sentry (`@sentry/react-native`) with release + dist tied to EAS build/update ids; PII scrubbing.
  Exit criteria P7: user logs in on all three platforms, sees org/project list in Arabic (RTL) and English.

---

## P8 — Offline sync & file pipeline

- [ ] **P8-01 — Sync schema package** 🔒 ⛔
  Touches: `packages/sync-schema/*`
  Steps: define which tables sync, as Drizzle SQLite schema via `@powersync/drizzle-driver`; every syncable row has `id (UUIDv7), org_id, project_id, version, updated_at, device_id, deleted_at`; generator checks each syncable table exists in Postgres publication `powersync`.
- [ ] **P8-02 — PowerSync service & sync streams** 🔒 ⛔
  Steps: self-hosted PowerSync config (bucket storage in Postgres or Mongo per their docs); streams scoped by `org_id` and the user's `project_ids` from a `user_project_access` view; streams generated from `@bricx/permissions` output; `GET /v1/sync/token` issues short-lived PowerSync JWT only for active, non-revoked sessions.
  Also (from P2-02, ADR 0035): initial sync must prove the row count equals the source count for each published table (RLS does not protect replication; `powersync_repl` has BYPASSRLS).
  Done when: **leak test** — user A's device never receives a row of org B or of a project A has no access to, across 1,000 randomised fixtures.
- [ ] **P8-03 — Upload endpoint & conflict engine** 🔒 ⛔
  Touches: `modules/sync-upload/*`
  Steps:
  1. `POST /v1/sync/upload` accepts a batch of CRUD ops (op id, table, row id, base version, patch).
  2. Per-table handler registry applies the **conflict strategy** (see matrix below), runs the same service + CASL + SoD + audit path as online writes.
  3. Response per op: `accepted | rejected(reason) | conflict(serverRow)`; rejected/conflict rows written to `sync_conflicts` for review.
  4. Idempotent by op id.
  Conflict matrix (encode as data, test each):
  | Entity | Strategy |
  |---|---|
  | Daily logs, inspections | Version check; on mismatch keep both, flag `needs_review` |
  | Attendance | Dedupe on `(worker, date, site)`; merge clock events |
  | Tasks | Accept only valid state transitions from current server state |
  | Punch-list items | Field-level merge; same-field clash → keep server, store client value in conflict |
  | Photos/files | Always keep both |
  | Anything financial | Never auto-merge; reject into `sync_conflicts`, notify approver |
- [ ] **P8-04 — Client sync integration**
  Steps: PowerSync DB init (native SQLite adapter, web wa-sqlite/OPFS with IndexedDB fallback); connector `fetchCredentials` → `/sync/token`, `uploadData` → `/sync/upload`; hooks `useQuery` over local DB; global `SyncStatus` (online/offline, pending ops count, last synced, conflicts); conflict review screen.
- [ ] **P8-05 — Site packages (offline documents)**
  Steps: user selects project/site → downloads drawings (PDF), current-revision docs, forms, rate libraries into app storage; manifest with checksums and size; storage quota check and eviction policy.
- [ ] **P8-06 — File pipeline** 🔒
  Also (from P2-01, ADR 0034): prove multipart + presigned URLs + CORS against SeaweedFS, the local S3 emulator; if it fails, swap the dev emulator (production is AWS S3).
  Steps:
  1. Local upload queue table (file path, sha256, size, mime, entity link, status, parts done).
  2. API: `POST /files/initiate` (multipart create + presigned part URLs), `POST /files/complete`; object key `org/{org}/proj/{proj}/{yyyy}/{mm}/{fileId}`.
  3. Resume by listing uploaded parts; background upload on native (`expo-background-task` + `expo-file-system` upload tasks) with Wi-Fi-only option.
  4. Worker on `file.uploaded`: ClamAV scan → quarantine or accept; Sharp thumbnails; EXIF (time, GPS) extracted and stored as evidence, compared to capture metadata.
  5. Immutable versions: new upload = new `file_versions` row.
- [ ] **P8-07 — Sync chaos tests**
  Steps: test harness toggling network, clock skew (±48h), app kill mid-upload, duplicate replay, 2 devices editing same record; Maestro flow on Android with airplane mode.
  Exit criteria P8: leak test, conflict matrix tests, and chaos suite green; 7-day offline capture of 500 records + 200 photos syncs with zero loss.

---

## P9 — Money, FX, double-entry ledger

- [ ] **P9-01 — Currency & money columns** 🔒
  Steps: every monetary field stored as `*_amount bigint, *_currency char(3)` plus, where reporting matters, `reporting_amount bigint, reporting_currency char(3), fx_rate_id uuid`; Drizzle custom type maps bigint ↔ `bigint`; lint/CI check forbids `numeric`/`real`/`double` columns named `*amount*`.
- [ ] **P9-02 — Exchange rates** 🔒
  Steps: `exchange_rates(id, base, quote, rate numeric(24,12), source, as_of timestamptz, fetched_at, created_by, is_manual, reason)`, append-only (no UPDATE/DELETE grant); FX worker (BullMQ repeatable, hourly) with provider adapters (start with one commercial feed + central-bank adapter for launch countries); manual override by Project Owner creates a new row with reason, audited; `FxService.rateAt(base, quote, t, policy)` where policy ∈ `spot_at_transaction | project_fixed | manual`.
- [ ] **P9-03 — Chart of accounts** — per org, templated by country; account types asset/liability/equity/income/expense; project and cost-code dimensions; system accounts (cash, bank, mobile-money wallets, AP, AR, retention payable/receivable, FX gain/loss).
- [ ] **P9-04 — Journal & ledger** 🔒 ⛔
  Steps:
  1. `journal_entries(id, org_id, project_id, entry_date, posted_at, source_type, source_id, memo, reverses_id, prev_hash, hash)`; `journal_lines(entry_id, account_id, cost_code_id, debit bigint, credit bigint, currency, reporting_debit, reporting_credit, fx_rate_id)`.
  2. Deferred constraint trigger: per entry and per currency, `sum(debit) = sum(credit)`; in reporting currency the difference must be booked to FX gain/loss line.
  3. `REVOKE UPDATE, DELETE` on both tables; `LedgerService.post(tx, entry)` only entry point; `reverse(entryId, reason)` creates mirror entry.
  4. Hash chain per org (same pattern as audit).
  5. Balance read-model: `account_balances` materialized per (account, project, currency), refreshed via outbox job; trial balance endpoint.
  Done when: property tests: random valid postings keep trial balance at zero; unbalanced post fails at commit; reversal nets to zero.
- [ ] **P9-05 — Approval state machine (server)** 🔒
  Steps: generic `approvals` engine: policies per org (amount thresholds in reporting currency, number of levels, role per level), `approval_steps` with actor/time/device/evidence; SoD enforced; transitions table `requested → approved → paid → received → recorded` (plus `rejected`, `cancelled`), each transition row immutable.
- [ ] **P9-06 — Client money & approval UI** — `MoneyInput` (locale-aware, minor-unit exact), `MoneyText`, FX disclosure ("converted at 1 USD = 23.45 SLE, source, time"), XState approval flow mirror.
  Exit criteria P9: ledger property suite, FX append-only tests, SoD tests green; 🔒 review by owner + accountant.

**Foundations gate:** P1–P9 exit criteria all green. Only now build user-facing modules.

---

## P10 — Field operations (MVP)

For each module below Claude Code uses `/new-module`, then: schema + migration (RLS + publication) → service with state machine → API + OpenAPI → sync handler (conflict strategy) → client screens (phone/tablet/desktop variants) → i18n keys → tests (unit, integration, Maestro/Playwright happy path).

- [ ] **P10-01 — Tasks & milestones** — WBS hierarchy, dependencies (FS/SS), assignees, planned vs actual dates, % complete, status machine `todo → in_progress → blocked → done → verified`; Gantt on desktop (web-only component).
- [ ] **P10-02 — Daily logs** — one per site per day per author; weather (manual + optional API), manpower counts, equipment, work done (linked tasks), issues, delays with cause codes, photos; submit → lock; edits after submit create amendment.
- [ ] **P10-03 — Photos & evidence** — capture with `expo-camera`/`expo-image-picker`, GPS (with permission), timestamp, compass heading; watermark overlay optional; link to any entity; gallery with filters.
- [ ] **P10-04 — Workers & attendance** — worker registry (incl. subcontractor workers, no-login), ID photo, trade, day rate (Money); clock-in/out with geofence check (PostGIS on server, turf on device), optional photo; dedupe rule from P8; daily roll-up.
- [ ] **P10-05 — 2D drawings viewer & markups** — drawing register (discipline, number, revision, status); web: PDF.js + SVG markup layer; native: react-native-pdf + Skia layer; markups stored as vector JSON in page coords; pins linkable to tasks/issues; offline via site packages.
  Exit criteria P10: foreman completes a full offline day (attendance, daily log, 30 photos, 5 task updates, 2 markups) on Android mid-range device; syncs cleanly.

---

## P11 — Commercial core (MVP)

- [ ] **P11-01 — Materials catalogue & units** — materials with UoM conversions, categories, pg_trgm search.
- [ ] **P11-02 — Material requests** — site raises request → approvals engine → issued from store or sent to procurement (R2); offline creation allowed, approval online only.
- [ ] **P11-03 — Basic inventory** 🔒 — stores per site; `stock_movements` append-only (receipt, issue, transfer, adjustment, return) with quantities as `numeric(18,6)` in base UoM and valuation Money; on-hand read-model; negative stock blocked; adjustments require permission + reason + audit; stock valuation posts to ledger via outbox.
- [ ] **P11-04 — Budgets** 🔒 — cost codes (org template + project), budget lines Money per cost code, versions (original, revised), committed vs actual vs forecast read-model.
- [ ] **P11-05 — Expenditures** 🔒 — record expense with receipt photo, payee, cost code, currency, FX at transaction date; approval flow; on `recorded` → ledger posting; offline capture as draft only (never auto-posted).
- [ ] **P11-06 — Project cost dashboard** — budget vs committed vs actual per cost code, in project and reporting currency, with FX disclosure.
  Exit criteria P11: every money movement in P11 traces to a balanced journal entry; audit chain verifies.

---

## P12 — Notifications & messaging basics (MVP)

- [ ] **P12-01 — Notification service** — event → rules → channels (push, in-app, e-mail, SMS) with per-user preferences and quiet hours in user timezone; templates localized via i18n keys; delivery log.
- [ ] **P12-02 — Push** — Expo push tokens per device, revoked with device; deep links into Expo Router.
- [ ] **P12-03 — SMS & e-mail adapters** — SES; SMS adapter for launch countries; OTP not sent by BRICX (Keycloak handles auth).
- [ ] **P12-04 — Live updates** — WebSocket gateway authenticated with same token + revocation check; rooms per project; used for approvals inbox and dashboards.

---

## P13 — Cloud infrastructure & delivery pipeline

- [ ] **P13-01 — OpenTofu layout** 🌍 🔒
  Touches: `infrastructure/tofu/{modules,envs/{dev,staging,prod-af,prod-eu},global}`
  Modules: network (VPC, private subnets, NAT), rds (Postgres 18, Multi-AZ prod, PITR, KMS, logical replication params), valkey, s3 (+ versioning, object lock on audit exports bucket), cloudfront + WAF, ecs (api, worker, relay, powersync, keycloak), secrets, kms, observability, directory (global). Remote state in S3 with locking; one state per env.
- [ ] **P13-02 — Container images** — multi-stage Dockerfiles (distroless/node for api/worker), non-root, Trivy scan in CI, SBOM (Syft), images signed (cosign).
- [ ] **P13-03 — Deploy pipeline** — GitHub OIDC → AWS (no long-lived keys); on merge to `main`: build → push → migrate (one-off ECS task as `bricx_owner`) → deploy staging → smoke tests → manual approval → prod cells sequentially (af, then eu).
- [ ] **P13-04 — Mobile & web release** — EAS profiles `development | preview | production`; channels mapped to envs; `eas update` for JS-only fixes with runtime version policy `fingerprint`; store submission via `eas submit`; web PWA deployed to S3/CloudFront with cache-busting and service-worker update prompt.
- [ ] **P13-05 — Observability** — OTel SDK in api/worker (HTTP, pg, BullMQ spans); dashboards: API RED metrics, queue depth/age, outbox lag, sync upload rejects/conflicts, FX staleness, ledger post failures; alerts to on-call channel.
- [ ] **P13-06 — Backups & DR** 🔒 — RDS PITR 35 days, daily snapshot copied within same residency region (second AZ/account), S3 versioning + replication within region; **restore drill** runbook; RPO ≤ 15 min, RTO ≤ 4 h.
  Exit criteria P13: staging rebuilt from zero with `tofu apply` + pipeline; restore drill passed and documented.

---

## P14 — MVP hardening & launch

- [ ] **P14-01 — Security review** 🔒 — OWASP ASVS L2 checklist; ZAP baseline in CI against staging; dependency and image scans clean of criticals; external pentest scheduled and findings tracked.
- [ ] **P14-02 — Performance** — k6 scenarios: 500 concurrent field users uploading, approvals burst, dashboard reads; p95 API < 300 ms, sync upload batch (100 ops) < 2 s; Postgres `pg_stat_statements` review, indexes added.
- [ ] **P14-03 — Low-end device & network testing** — Android Go-class device, 2G/3G throttling profiles, 7-day offline, storage-full scenario.
- [ ] **P14-04 — Accessibility & localisation QA** — screen readers (TalkBack/VoiceOver), dynamic type, RTL pass, pseudo-locale overflow pass, all launch languages reviewed by native speakers in Tolgee.
- [ ] **P14-05 — Data protection** — privacy notice, consent for GPS/photos, data export & deletion (business records soft-deleted, personal data erasure where lawful), records of processing, DPA template for clients.
- [ ] **P14-06 — Runbooks** — incident response, revoke compromised user/device, rotate secrets, failed migration, stuck outbox, sync conflict backlog, FX feed outage (fallback to last rate + banner), payment webhook replay.
- [ ] **P14-07 — Pilot & launch** — pilot with 1–2 contractors; feedback triage; go/no-go checklist (all exit criteria, SLOs met for 14 days in staging pilot); production launch.
  **MVP gate:** go/no-go signed by owner.

---

## Release 2

### P15 — BOQ & estimating
- [ ] P15-01 Rate libraries (per region/org; labour, material, plant; versioned; currency-aware).
- [ ] P15-02 BOQ structure (bills, sections, items, UoM, qty `numeric(18,6)`, rate Money, amount computed with exact rounding rules; provisional sums, prime cost, contingencies).
- [ ] P15-03 Estimating (build-ups: item = Σ resources × qty × rate + overhead/profit %), what-if versions, comparison view.
- [ ] P15-04 Import/export (Excel via SheetJS with column mapping wizard; validation report).
- [ ] P15-05 BOQ → budget link (items map to cost codes); interim valuations (measured qty × rate, retention %, previous certified) generating ledger postings. 🔒

### P16 — Suppliers & procurement
- [ ] P16-01 Supplier registry (docs, bank details **field-level encrypted with KMS envelope**, approval to activate, bank-detail change requires 2-person approval). 🔒
- [ ] P16-02 RFQs & quote comparison.
- [ ] P16-03 Purchase orders (approvals, commitments to budget, versions/amendments).
- [ ] P16-04 Goods received notes (partial deliveries, photos, quantity/quality check) → inventory receipts. 🔒
- [ ] P16-05 Three-way match (PO ↔ GRN ↔ supplier invoice) with tolerance rules; variance workflow.

### P17 — Payment integrations & reconciliation 🔒
- [ ] P17-01 `PaymentAdapter` contract: `initiate, verify, handleWebhook, refund, status` + capability flags; contract test kit every adapter must pass.
- [ ] P17-02 Webhook ingestion: raw store → signature verify → dedupe by provider event id → outbox → processor; replay tool.
- [ ] P17-03 First adapters from `docs/adr/pending.md` (e.g. one mobile-money provider for Sierra Leone such as Orange Money or Afrimoney via direct API or aggregator, one card/aggregator gateway such as Flutterwave or Paystack, one bank/transfer route); sandbox E2E per adapter.
- [ ] P17-04 Payment runs: batch supplier payments, approval, idempotency keys per payment, status polling fallback when webhooks fail.
- [ ] P17-05 Auto-linking: confirmed payment → project, cost code, expenditure/invoice, receipt → ledger.
- [ ] P17-06 Reconciliation: import bank/mobile-money statements (CSV/API), matching rules (amount, reference, date window), manual match UI, unmatched ageing report.

### P18 — Change orders, RFIs, submittals
- [ ] P18-01 Change orders: request → price (BOQ items) → approve (client + owner) → budget & contract value revision → ledger/valuation effect. 🔒
- [ ] P18-02 RFIs: numbering per project, ball-in-court, due dates, linked drawings/markups, responses, closure.
- [ ] P18-03 Submittals: register, review cycles, stamps (approved/approved as noted/revise & resubmit), revision history.

### P19 — Quality, inspections, safety, punch lists
- [ ] P19-01 Form builder (versioned JSON schema forms, offline).
- [ ] P19-02 Inspections & test plans (ITPs), hold/witness points, sign-off with signature capture.
- [ ] P19-03 Safety: toolbox talks, incident reports (restricted permission), permits to work, observations.
- [ ] P19-04 Punch lists: pin on drawing, assignee, photo before/after, field-level merge sync.

### P20 — Client & owner portals, reporting
- [ ] P20-01 Portal route group `(portal)` with restricted permission bundles (Client, Consultant); read-only financial summaries; approvals for change orders/valuations.
- [ ] P20-02 Report engine: templates (React-PDF), scheduled reports via worker, localized, branded, with FX disclosure.
- [ ] P20-03 Standard reports: daily/weekly progress, cost report, cash-flow, valuation certificate, inventory valuation, attendance/payroll export, audit extract.
- [ ] P20-04 Portfolio dashboards (desktop) on read-models.
  **Release 2 gate:** payment adapters pass contract kit; reconciliation proven on 1 month of pilot data.

---

## Release 3

### P21 — Accounting integrations
- [ ] P21-01 `AccountingAdapter` contract (map accounts, push journals, pull payments, sync suppliers/customers) + mapping UI.
- [ ] P21-02 Adapters: QuickBooks Online, Xero first; Sage, Odoo, Zoho Books next. Push is idempotent by journal id; reconciliation report BRICX ↔ accounting system.

### P22 — BIM phases 2–3 (web/desktop)
- [ ] P22-01 IFC upload → worker validates, extracts element index (GUID, type, storey, properties) into Postgres; model stored as optimized fragments (That Open fragments format).
- [ ] P22-02 Viewer (That Open Components): navigation, properties, sections, measurements; link elements to tasks/RFIs/inspections by IFC GUID.
- [ ] P22-03 IfcOpenShell Python worker (separate container, BullMQ via bridge or its own queue): quantity takeoff → BOQ suggestions; model comparison between revisions; federation.
- [ ] P22-04 Decide Tauri 2 desktop wrapper if trigger in C21 is met.

### P23 — Analytics, forecasting, AI-assisted search
- [ ] P23-01 ClickHouse per region cell; CDC from Postgres (Debezium or PeerDB) → analytics schema; tenant isolation via row policies.
- [ ] P23-02 Forecasting: cost-at-completion, EVM (PV/EV/AC, CPI/SPI), cash-flow forecast.
- [ ] P23-03 Search: Meilisearch for documents/entities with tenant tokens.
- [ ] P23-04 AI-assisted document search & report drafting: embeddings stored in pgvector per cell (residency), retrieval respects CASL (filter before retrieval), LLM calls through a server-side gateway with logging, no training on client data, human review before any generated report is issued.

---

## P24 — Production operations & maintenance (continuous)

**Cadence**

| When | Task |
|------|------|
| Every PR | CI gates, CODEOWNERS on money/sync/identity, migration review |
| Daily | Check alerts: outbox lag, sync conflicts backlog, FX staleness, failed webhooks, queue DLQ |
| Weekly | Renovate batch merge; review `sync_conflicts` and rejected uploads; audit-chain verify job report |
| Monthly | Restore drill on staging from prod snapshot (anonymised); access review (who has finance/admin roles, expired grants); cost review |
| Quarterly | Keycloak upgrade; Expo SDK upgrade (one SDK per quarter, via dedicated branch + full Maestro run); Postgres minor upgrades; key/secret rotation; DR game day; pentest retest |
| Yearly | Node LTS migration (move to next even LTS within 6 months of its LTS date); Postgres major upgrade (blue/green); external pentest; ASVS re-assessment |

**Maintenance tasks (repeat as needed)**

- [ ] M-01 Dependency upgrade session: `/verify` before and after; one ecosystem per PR (Expo, Nest, Drizzle, PowerSync).
- [ ] M-02 Expo SDK upgrade: follow Expo changelog, `npx expo install --fix`, rebuild dev clients, runtime version bump (OTA incompatible), staged rollout 10% → 50% → 100%.
- [ ] M-03 Add a country: region config template, currency/tax profile, locale files, payment/SMS adapters behind contract kit, chart-of-accounts template, legal review; no core code change allowed — if one is needed, write an ADR first.
- [ ] M-04 Add a language: add locale in Tolgee, glossary review, RTL check, pseudo-locale pass, release via runtime translation fetch (no app rebuild).
- [ ] M-05 Add a region cell 🌍: `tofu apply` new env, Keycloak realm import, directory entry, smoke tests, residency sign-off.
- [ ] M-06 Incident: follow `docs/runbooks/incident.md`; post-mortem within 5 working days; roadmap task created for each action item.
- [ ] M-07 Data correction: never UPDATE ledger/audit; use reversing entries or documented admin workflows, each with a ticket id in the audit reason.
- [ ] M-08 Deprecations: API versions supported ≥ 12 months after successor ships; client min-version enforced via `/v1/client-config`.

---

## Appendix A — Definition of Done (every task)

- Tests written first for acceptance criteria; `pnpm verify` green.
- New tenant tables: RLS forced, in PowerSync publication if syncable, sync-stream scope + leak test updated.
- New money fields: bigint minor units + currency; ledger posting if it moves money.
- New writes with side effects: outbox, not direct enqueue.
- New strings: i18n keys in `en` + placeholders in all launch locales.
- Audit event recorded for every state change.
- OpenAPI client regenerated; docs/ADR updated if a decision changed.
- `ROADMAP.md` checkbox ticked, `PROGRESS.md` updated.

## Appendix B — Suggested timeline (small team: 3–4 engineers + Claude Code)

| Block | Phases | Indicative duration |
|-------|--------|---------------------|
| Foundations | P0–P9 | 12–16 weeks |
| MVP features + launch | P10–P14 | 10–14 weeks |
| Release 2 | P15–P20 | 20–26 weeks |
| Release 3 | P21–P23 | 16–24 weeks |

Durations are planning estimates, not commitments; re-baseline at each gate.
