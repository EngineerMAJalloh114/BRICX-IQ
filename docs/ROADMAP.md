# BRICX IQ — Master Implementation Roadmap

Built for Claude Code. Follow phase by phase, task by task, from an empty repository to production maintenance.
Stack source of truth: `docs/STACK.md` (v2). Working rules: `CLAUDE.md`.

---

## Execution model

**Previous model (tiny-step, P0–P3).** One task = one Claude Code session = one thread = one branch = one PR. Plan mode first, and every task's plan stopped for owner approval; 🔒 tasks also needed architect review of the PR before merge. After the PR opened the session stopped, and the next task started in a new thread. §0 below describes this model.

**Reason for the change.** P4–P24 hold most of the roadmap's tasks. Under the tiny-step model each one costs its own thread, plan approval and full stop, even when it is small and independent of the open PR. The hybrid model approves the plan once per phase and keeps the per-task stops where the risk is (🔒 tasks and phase gates). (ADR 0050)

**Hybrid model (CLAUDE.md Read first, Session start and Workflow items 1, 2, 6–9; ADR 0050).**

- One phase = one thread, resumable across sessions. Inside it: one branch `<task-id>-<slug>` and one PR per task, run in the order below. No parallel threads; a task is never split across sub-agents.
- Phase kickoff, in plan mode: ONE phase plan (task order, dependencies, decisions needed from the owner, risks, how each Done-when is verified), then stop for owner approval. A material change to the approved plan (a new or reordered task, a new dependency, a new decision) needs owner re-approval before work continues.
- Session start: find the phase (the first phase after P3 whose exit the owner has not approved, or the one the human names); inside an approved phase plan, work tasks in ROADMAP order, skipping tasks marked "Moved to". Nothing outside the approved plan.
- After a non-🔒 PR opens, the thread may start the next task from main only if it is independent: it does not need the open PR's code and does not touch the same files, migration sequence or generated artefacts; a dependent task waits for the merge. Never rebase a pushed branch, force-push or merge. If an earlier merge leaves an open PR conflicting with main (typically only ROADMAP.md and PROGRESS.md), report it to the owner. The owner either resolves it in GitHub's conflict editor (keeping both PROGRESS rows), or tells the thread to recreate the branch as `<task-id>-<slug>-r2` from main, re-apply the task's changes, ROADMAP tick and PROGRESS row, push it with `git push -u origin`, and open a new PR that links the old one; the owner closes the old PR.
- After a 🔒 PR opens, stop: start no further task until the architect has reviewed and the owner has merged.
- Small non-🔒 tasks in the same package may share one PR; the PR body lists every task ID with its own Done-when checklist. The title carries the first task ID.

**Effective point.** From P4 onward, after the verified P3 exit (PR #41: P3-01 to P3-06 ticked, coverage thresholds met, zero `any`, `pnpm verify` green on main).

**P4–P24 sequence.** P4 → P5 → P6 → P7 → P8 → P9 → P10 → P11 → P12 → P13 → P14 → P15 → P16 → P17 → P18 → P19 → P20 → P21 → P22 → P23 → P24, each phase's tasks in the order listed in its section. A phase starts only after the previous phase's exit is approved.

**Tracking.** This file stays authoritative. Subtasks (task IDs) remain the tracking units: each merged task ticks its checkbox here and adds a row to `docs/PROGRESS.md`. Phases, task IDs and task content do not change with the execution model.

**Decision and approval gates.**

1. Phase kickoff plan: owner approval before any task in the phase starts; owner re-approval for any material change to it.
2. 🔒 tasks: their own task plan and owner approval before any code is written. After a 🔒 PR opens, stop: start no further task until the architect has reviewed and the owner has merged.
3. Non-🔒 PRs: owner review and merge; the thread never merges.
4. Phase exit: evidence report, then owner approval before the next phase starts.

**Testing and acceptance criteria.** Unchanged: tests first for every **Done when** item, the task's **Verify** command and `pnpm verify` green, and Appendix A (Definition of Done) for every task. A phase closes when its **Exit criteria** pass in CI and the phase exit evidence report (each task's Done-when and the exit criteria, with command output) is approved by the owner.

---

## 0. How to use this roadmap with Claude Code

> Tiny-step model, used P0–P3. From P4 onward the **Execution model** section above applies (ADR 0050).

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
  Steps: Vitest projects in the root `vitest.config.mts` (`test.projects`; `vitest.workspace.ts` was deprecated in Vitest 3.2 and removed in 4); shared presets in `@bricx/vitest-config`: a default preset and an swc preset (`unplugin-swc`, decorator metadata) for api/worker; coverage via v8; thresholds keyed by path: `packages/money`, `packages/permissions`, `apps/api/src/modules/ledger` ≥ 95% lines (`packages/ids` added in P3-01, ADR 0041); others ≥ 70%. `tooling/vitest-smoke` proves the thresholds, the swc preset and that zero tests fail. Every package under `apps/` and `packages/` needs a `test` script (`check:workspace`).
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
- [x] **P1-06b — Production audit ignores GHSA-vfj7-8cjw-p6xm (braces), tooling only, dated** (from P1-06, ADR 0037)
  Touches: `pnpm-workspace.yaml`, `scripts/audit-prod.mjs`, `scripts/audit-ignores.mjs`, `scripts/guards.mjs`, `scripts/check-workspace-scripts.mjs`, `scripts/guard-fixtures/audit-ignores/`
  Steps: ignore the advisory by id only (`auditConfig.ignoreGhsas`, never a severity or audit level); `check:workspace` fails unless each ignored id is recorded in an Accepted ADR with its package and a "Revisit by" date, the package is outside every apps/ and packages/ production closure, and the date has not passed (warning in the last 30 days); `pnpm audit:prod` prints each ignore with its ADR.
  Verify: `pnpm audit:prod` passes; it fails with the ignore removed or naming another GHSA; the guard fixtures fail for an apps/ importer reaching `braces` and for an expired date.
  Revisit by 2027-01-04 (ADR 0037).
- [x] **P1-06c — Override handlebars to 4.7.10 (three advisories in the production audit), no ignore** (from P1-06, ADR 0038)
  Touches: `pnpm-workspace.yaml`, `pnpm-lock.yaml`, `scripts/guards.mjs`, `scripts/overrides.mjs`, `scripts/check-workspace-scripts.mjs`, `scripts/audit-prod.mjs`, `scripts/guard-fixtures/overrides/`
  Steps: `overrides: handlebars: 4.7.10` (exact, global) in `pnpm-workspace.yaml`, after the 7-day rule is re-checked at install; `check:workspace` and `pnpm audit:prod` fail unless every override is exact, set only in `pnpm-workspace.yaml`, recorded in an Accepted ADR with a "Remove when" trigger, listed in DEPENDENCIES.md, and the only version of its package in `pnpm-lock.yaml`, and fail on a stale override.
  Verify: `pnpm audit --prod` reports no handlebars advisory and only the braces ignore; `pnpm why handlebars` shows 4.7.10 only; the override fixtures fail for each broken case.
  Remove when an eslint-plugin-boundaries release requires handlebars >=4.7.10 (ADR 0038).

  Exit criteria P1: CI green on `main`; branch protection active.

---

## P2 — Local development environment

- [x] **P2-01 — Docker Compose stack** 🌍
  Touches: `infrastructure/docker/compose.yml`, `infrastructure/docker/*/`, `.env.example`
  Services: `postgres` (18 + PostGIS; `wal_level=logical`), `valkey`, `s3` (SeaweedFS; MinIO's community images are no longer published, ADR 0034; the dev bucket is created by the `s3-init` one-shot, amended in P2-01b, ADR 0036), `keycloak` (dev mode, realm import), `powersync` (Open Edition, config mounted), `mailpit`, `clamav`, `grafana/otel-lgtm` (single-container dev observability, includes the OTel Collector).
  Steps: healthchecks on every service; named volumes; `pnpm dev:up` / `dev:down` / `dev:reset` scripts.
  Done when: all services healthy from cold start in < 3 min (measured on the owner's WSL2 machine: 1m40s to 2m56s, Grafana in `otel-lgtm` up to 166 s; P2-01c, ADR 0042).
  Verify: `pnpm dev:up && docker compose ps --format json | jq -se 'length > 0 and all(.[]; .Health == "healthy")'` (`ps --format json` prints one object per line, hence `-s`; amended in P2-01).

- [x] **P2-02 — Database bootstrap roles** 🔒
  Touches: `infrastructure/docker/postgres/init/*` (the init script is `01-bootstrap.sh`, so role passwords come from the environment; amended in P2-02, ADR 0035)
  Steps: create roles `bricx_owner` (owns schema, runs migrations), `bricx_app` (LOGIN, NOBYPASSRLS, no DDL), `bricx_readonly` (reporting), `powersync_repl` (REPLICATION, SELECT on published tables); publication `powersync` (created empty, tables added by migrations); extensions `postgis`, `pg_trgm`, `btree_gist`, `pgcrypto`.
  Also (from P2-01, ADR 0034): remove the temporary superuser replication used by PowerSync; use `powersync_repl`. PowerSync health check must prove replication is streaming (replaces the liveness-only check).
  Done when: `bricx_app` cannot `CREATE TABLE` and cannot bypass RLS.
  Verify: integration test `db-roles.int.test.ts`. This is the first Testcontainers test: add the CI integration job with it (P1-06, ADR 0031); if P4 adds one first, add the job there.
  Done in P2-02 (ADR 0035): app tables in schema `bricx`, extensions in `extensions`; `powersync_repl` has BYPASSRLS; PowerSync storage as `powersync_storage_owner`; tests in `tooling/db-bootstrap` (`db-roles.int.test.ts`, `powersync-health.int.test.ts`), run by `pnpm test:integration` and the CI `integration` job.

- [x] **P2-01b — S3 dev bucket created deterministically** (from P2-01, ADR 0036)
  Touches: `infrastructure/docker/compose.yml` (`s3`, new `s3-init`), `infrastructure/docker/s3/create-bucket.sh`, `scripts/dev-stack.mjs`, `scripts/guards.mjs`
  Why: SeaweedFS 4.48 `weed mini` gives its filer about 6 s, then tries `S3_BUCKET` once and never retries; on a slow cold start the bucket was never created and `dev:up` failed with "s3 is unhealthy".
  Steps: one-shot `s3-init` (same pinned image, profile `init`, `weed shell` `s3.bucket.create`; success = the bucket directory exists in the filer, checked before and after creating; at most 60 attempts 2 s apart and 180 s in total, then exit 1 with a clear message); `pnpm dev:up` runs it with `docker compose run --rm s3-init` before waiting for the stack; the `s3` service no longer gets `S3_BUCKET` (it reads the same `.env` key as `BRICX_S3_BUCKET` for its unchanged healthcheck); compose guard allows a missing healthcheck only for one-shot `*-init` services (profile `init` only, `restart: "no"`, `depends_on`, no ports, no healthcheck).
  Done when: the race is reproduced (I/O-limited cold start: old config fails, new config passes) and `s3-bucket.int.test.ts` fails without the retry; `pnpm dev:reset && pnpm dev:up` passes 5 times in a row, including under CPU load.
  Verify: `pnpm test:integration` (`tooling/db-bootstrap/test/s3-bucket.int.test.ts`); cold-start proofs (`pnpm dev:reset && pnpm dev:up`) run at least 3 times.

- [x] **P2-01c — Cold-start healthcheck windows (otel-lgtm, keycloak, powersync)** (from P2-01, ADR 0042)
  Touches: `infrastructure/docker/compose.yml` (`otel-lgtm`, `keycloak`, `powersync`), `scripts/guards.mjs`, `scripts/check-workspace-scripts.mjs`, `scripts/guard-fixtures/compose/start-period-*.yml`
  Why: cold `pnpm dev:up` runs on the owner's WSL2 machine (1m40s to 2m56s in total) failed with "is unhealthy" for `otel-lgtm` (Grafana 166 s, past its ~170 s deadline) and `powersync` (past its ~90 s deadline), and `keycloak` reached 144 s against its ~170 s deadline; each recovered later. Grafana runs 813 SQLite migrations on a fresh volume (344 s at 50 write IOPS in the agent environment); PowerSync and Keycloak wait on their own process boot (first start after a daemon restart: 92 s and 182 s from container start), not on replication or the realm import.
  Steps: `start_period` otel-lgtm 300 s, keycloak 300 s, powersync 180 s (from the measurements, with margin; `retries` and `start_interval` unchanged); `GF_DATABASE_WAL: "true"` (344 s → 74 s at 50 write IOPS; for architect review); compose guard floors for the three services, failing closed on a missing, interpolated or unreadable value and on a missing service.
  Done when: each slow start is reproduced and explained; the fixtures and the sabotage proofs per service (floor − 1 s in `compose.yml`, the floor removed, the service renamed) fail; 3 cold starts exit 0.
  Verify: `pnpm verify` (`check:workspace`); cold-start proofs (`pnpm dev:reset && pnpm dev:up`) run at least 3 times, printing `docker logs bricx-dev-otel-lgtm-1 | grep "Grafana: "`.

- [x] **P2-03 — Config & secrets loading**
  Touches: `packages/config/src/*`
  Steps: Zod-validated env schema per app (`api`, `worker`, `client-public`); fail fast on boot; `.env.example` complete; no secret in client bundle (only `EXPO_PUBLIC_*`).
  Verify: unit test: missing `DATABASE_URL` throws with a readable message.
  Done in P2-03 (ADR 0039): zod 4.6.5 repo-wide; `@bricx/config` subpath exports `./api`, `./worker`, `./client-public` (no root barrel); errors carry key + code only, never a value; `DATABASE_URL` (as `bricx_app`), `VALKEY_URL` and `S3_SECRET_ACCESS_KEY` come back as `Secret` (`reveal()` only); production rejects `dev-only` and `bricx-dev` values, a local `DATABASE_URL`, `VALKEY_URL` or `S3_ENDPOINT` host (a local OTel collector is allowed) and wildcard CORS origins; loaders never read a file (`check:workspace`: no env-file loading under `packages/`, never `.env.production`); `API_PORT=4000` (Grafana holds 3000).

- [ ] **P2-04 — Seed & fixtures framework**
  Touches: `packages/db/seed/*`
  Steps: deterministic seed (fixed UUIDv7s) creating 2 orgs in different regions, users for each system role, 1 project with 2 sites, currencies USD/EUR/SLE/NGN/KES/GHS, languages en/fr/ar (RTL test).
  Verify: `pnpm db:seed` twice is idempotent.
  Moved to P6-05b (ADR 0040): the tables, `withTx`, `@bricx/ids` and the domain `Clock` it needs come in P3–P6. Stays unticked here; the work and its tick are in P6-05b.
  Exit criteria P2 (amended in ADR 0040): `pnpm i && pnpm dev:up` with every service healthy, and `pnpm test:integration` green.

---

## P3 — Shared domain packages

- [x] **P3-01 — `@bricx/ids`**
  Steps: UUIDv7 generator (`uuid` v7) with monotonic ordering per process; `Brand<'ProjectId'>` style branded types; parse/validate helpers.
  Done when: 1M ids generated in-process are strictly increasing and unique.
  Done in P3-01 (ADR 0041): no `uuid` dependency; RFC 9562 version 7 written in-house (the injected clock would leave `uuid` only packing bytes). Subpaths `@bricx/ids/uuid-v7` (`createUuidV7Generator({ clock: { now(): number }, fillRandom? })`, `parseUuidV7`, `safeParseUuidV7`, `isUuidV7`, `IdError`) and `@bricx/ids/branded` (`OrgId`, `UserId`, `ProjectId`, `SiteId` with `parseX`, `safeParseX`, `isX`, `toX`); no root entry. 42-bit counter, strictly increasing within a millisecond and when the clock goes backwards; randomness from `globalThis.crypto` at call time. Parse is strict lowercase: API boundaries lowercase untrusted input first. Ids source imports no package, npm module or Node built-in and never reads the clock or `Math.random` (lint, smoke fixtures, real-path check). `packages/ids` is a 95% coverage path.

- [x] **P3-01b — Semgrep adoption** (from P3-01, ADR 0032 trigger; ADR 0043)
  Touches: `.github/workflows/ci.yml` (`security` job), `scripts/semgrep-pin.mjs`, `scripts/semgrep.mjs`, `scripts/guards.mjs`, `scripts/check-workspace-scripts.mjs`, `scripts/guard-fixtures/semgrep/*`, `tooling/semgrep/{rules,selftest}/*`, `tooling/semgrep/MANIFEST.json`, `.semgrepignore`, `.github/CODEOWNERS`
  Why: ADR 0032 deferred Semgrep until the first P3 package with `src/`; `@bricx/ids` (P3-01) reached it.
  Steps: `semgrep/semgrep` 1.179.0 pinned by image index and amd64 digest (1.180.0 failed the 7-day rule), run with `--network none`, read-only mounts, `--metrics=off`, `--disable-version-check`, `--strict` and `--error`, pulled with 3 attempts and never skipped; rules written for this repo (the Semgrep Rules License forbids redistributing registry rules; this repo is public): 4 workflow rules the ADR 0031 guard does not cover and 8 TS/JS rules ESLint does not cover (child_process shell and string commands, RegExp from data, `eval`, clock and `Math.random` in money and permissions, money float coercion, raw Postgres driver outside `packages/db`, BullMQ add outside the outbox relay); each rule with a known-bad and a known-good fixture; `MANIFEST.json` lists every rule file's SHA-256 and the DEPENDENCIES.md §7 row names the manifest's SHA-256; `.semgrepignore` scans tests too.
  Done when: the CI `security` job runs the self-test then the scan with no `if:`; the self-test fails when a known-bad line is missed; `check:workspace` fails on each broken guard rule G1–G8 (fixtures and sabotage proofs); every finding on `main` fixed or suppressed inline with a reason.
  Verify: `pnpm verify` (`check:workspace`); `node scripts/semgrep.mjs --selftest`; `pnpm semgrep`.

- [x] **P3-02 — `@bricx/money`** 🔒 ⛔ *(done 2026-10-13, ADR 0045; `iso4217.json` comes from a pinned public-domain mirror of the SIX lists because SIX is unreachable from the agent environment: the owner cross-checks with `gen:iso4217 --source six`; `fast-check` is a devDependency of `packages/money`; eight subpaths, no root entry)*
  Touches: `packages/money/src/{currency,money,fx,allocate,format}.ts`, `data/iso4217.json`
  Steps:
  1. Generate `iso4217.json` (code, numeric, minor exponent, name) from the official list; include SLE (2) and keep SLL flagged historical.
  2. `Money { amount: bigint; currency: CurrencyCode }` immutable; `add/subtract` require same currency (throw otherwise); `multiply(ratio: Decimal, rounding)`; `allocate(ratios)` with largest-remainder so parts sum exactly.
  3. `convert(money, rate: Decimal, target, rounding = HALF_EVEN)` returns `{ money, rateUsed }`.
  4. `format(money, locale)` via `Intl.NumberFormat` with `maximumFractionDigits` from exponent.
  5. Zod schemas: `MoneySchema` serialises amount as **string** in JSON (bigint-safe).
  Done when: property tests (fast-check) prove `allocate` sums exactly, `add` is associative, round-trip JSON preserves value; JPY/BHD/SLE formatting tests pass.
  Verify: `pnpm --filter @bricx/money test -- --coverage`.

- [x] **P3-03 — `@bricx/i18n`**
  Steps: key namespaces (`common`, `construction`, `finance`, `field`, `errors`, `validation`); glossary file `glossary.json` (`construction.change_order`, `finance.retention`, …) with definitions for translators; typed keys (i18next `CustomTypeOptions`); ICU enabled; `isRTL(locale)`; BCP 47 normalisation; fallback chain `project → user → device → en`.
  Done when: a missing key fails `pnpm i18n:check` (script compares all locale files against `en`).

- [x] **P3-04 — `@bricx/validation`**
  Steps: Zod schemas for primitives (email, phone E.164, ISO country/currency, IANA zone, BCP 47, GeoPoint, `Money`), pagination/cursor, standard error envelope; `z.infer` types exported.

- [x] **P3-05 — `@bricx/permissions`** 🔒 ⛔
  Touches: `packages/permissions/src/{catalogue,roles,ability,scopes}.ts`
  Steps:
  1. Catalogue as data: `resource.action.scope` where scope ∈ `own | site | project | org`; e.g. `finance.payment.approve.project`, `field.dailylog.create.site`.
  2. Default role bundles: Owner, Project Owner, Project Manager, Quantity Surveyor, Site Engineer, Foreman, Storekeeper, Accountant, Client, Consultant, Subcontractor, Auditor (read-only).
  3. `buildAbility(grants, context)` → CASL `MongoAbility` usable on API and client.
  4. Segregation-of-duties matrix: pairs that may not be held by the same actor on the same record (`request`/`approve`, `create PO`/`receive goods`, `record payment`/`reconcile`).
  5. Generator script outputs: RLS helper SQL fragments and PowerSync sync-stream fragments from the catalogue (consumed in P4-04, P8-02).
  Done when: snapshot test of the catalogue; ability tests for every default role × 10 sample actions.

- [x] **P3-06 — `@bricx/domain` kernel**
  Steps: `Clock` interface, `Result` type, domain error classes, generic state-machine helper (`defineMachine({states, transitions, guards})`) used by server and mirrored by XState on client; units of measure (SI + imperial, conversion table, per-region default).
  Exit criteria P3: all packages ≥ coverage thresholds; zero `any`.

---

## P4 — API foundation

- [x] **P4-01 — NestJS app skeleton**
  Touches: `apps/api/src/{main.ts,app.module.ts}`, `apps/api/src/common/*`
  Steps: Fastify adapter; Helmet; CORS allow-list from config; `nestjs-pino` structured logs with correlation id (`x-request-id`); graceful shutdown; `/health/live`, `/health/ready` (db, valkey, s3); URI versioning `/v1`.
  Also (from P2-01b, ADR 0036): when `api` (and, with P4-06, `worker`) is added to the compose stack, it declares `depends_on: s3-init: condition: service_completed_successfully` (the bucket exists before it starts).
  Also (from P2-03, ADR 0039): `main.ts` calls `loadApiConfig()` from `@bricx/config/api` before anything else and listens on `config.http.port`; CORS uses `config.http.corsOrigins`; `config.database.url.reveal()` only where the pool is created. `.env` is loaded only by a dev-only entry point (`process.loadEnvFile(".env")` or `node --env-file=.env`), never by `main.ts` in production and never `.env.production`.
  Also (P4 plan D6, ADR 0051): in P4 the api and worker run as host processes against the compose stack (`pnpm dev:api`), so the `depends_on: s3-init` step above moves to P13-02.
  Verify: `curl localhost:4000/health/ready` → 200 (port amended in P2-03: Grafana binds 3000; `API_PORT` in `.env`).

- [x] **P4-02 — Drizzle & migrations** 🔒
  Touches: `packages/db/src/schema/*`, `packages/db/drizzle.config.ts`, `packages/db/migrations/*`
  Steps: schema split per module; shared column helpers (`id uuid default uuidv7()`, `orgId`, `createdAt/updatedAt timestamptz`, `createdBy`, `version integer`, `deletedAt`); migrations generated then **hand-reviewed**; `pnpm db:migrate` runs as `bricx_owner`; migration CI job applies to empty DB and to previous release snapshot.
  Also (from P2-02, ADR 0035): tables live in schema `bricx` (`pgSchema('bricx')`, drizzle-kit `schemaFilter: ['bricx']`; decide the migrations-table schema); the migration guard must reject `DROP PUBLICATION` and `CREATE PUBLICATION` (the `powersync` publication is never dropped or recreated: rows written while it is missing never replicate).
  Also (from P2-03, ADR 0039): the `bricx_owner` connection for `db:migrate` is a new key declared in `@bricx/config` (schema, `.env.example`, `Secret`), not a second loader.
  Also (P4 plan D8, ADR 0052): no release exists yet, so the migration step applies all migrations to an empty DB and then each migration prefix in order; the previous-release-snapshot step moves to P13-03.
  Done when: rollback strategy documented (forward-only migrations; expand/contract pattern in `docs/runbooks/migrations.md`).

- [x] **P4-03 — Request context & transactional unit of work** 🔒 ⛔
  Touches: `apps/api/src/common/db/{tx.ts,context.interceptor.ts}`
  Steps:
  1. `AsyncLocalStorage` request context: `userId, orgId, projectIds[], roles, deviceId, ip, geo?, correlationId`.
  2. `withTx(fn)` opens a transaction as `bricx_app`, runs `SET LOCAL app.org_id = …, app.user_id = …, app.project_ids = …` (use `set_config(..., true)`), then `fn(tx)`.
  3. All repositories receive `tx`; lint rule forbids importing the raw pool outside `common/db`.
  Also (binding, from P2-04, ADR 0040): `withTx()` lives in `packages/db` as the core transaction primitive, with no Nest imports; `apps/api` only wires it into the request context. Reason: packages cannot import apps, and P6-05b's seed needs it. The `tx.ts` in Touches and the raw-pool lint rule in step 3 follow from this (the pool stays inside `packages/db`).
  Also (P4-03 task plan, ADR 0053): `withTx(context, fn)` is a method of the `@bricx/db` database handle; `apps/api` keeps the request context in AsyncLocalStorage (created in a Fastify `onRequest` hook, sealed by `context.interceptor.ts`) and opens transactions through `TxRunner`; the step-3 rule is Semgrep (`bricx-raw-pg-outside-db`, plus `bricx-raw-sql-outside-withtx` and `bricx-db-query-outside-withtx`).
  Done when: integration test proves a query with no context returns zero rows from tenant tables.

- [x] **P4-04 — RLS policy framework** 🔒 ⛔
  Steps: SQL function `app.current_org()`, `app.has_project(uuid)`; migration helper `enableTenantRls(table, {projectScoped})` emitting `ALTER TABLE … ENABLE/FORCE ROW LEVEL SECURITY` + policies; CI script fails if any table with `org_id` lacks FORCE RLS.
  Done when: cross-tenant read/write attempts fail in tests for every table (parametrised test iterates information_schema).
  Also (from P2-02, ADR 0035): functions created by bricx_owner get EXECUTE revoked from PUBLIC by default (ALTER DEFAULT PRIVILEGES ... REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC); SECURITY DEFINER functions must set their own search_path.
  Also (P4-04 task plan, ADR 0054): the bootstrap creates schema `app` for the functions, plus `app.current_user_id()`; the helper is `enableTenantRls(table, resource)` with the expressions from `@bricx/permissions` (`rlsPolicies()`), printed by `pnpm db:rls`; the check is the migrator's deny-by-default guard (every table in `bricx` and `app` needs ENABLE + FORCE unless on `GLOBAL_TABLES`, and every SECURITY DEFINER function a `search_path`), run inside each migration's transaction, instead of a separate CI script.

- [x] **P4-05 — Audit events** 🔒
  Touches: `modules/audit/*`, migration `audit_events`
  Steps: columns: `id, org_id, occurred_at, actor_id, actor_type, device_id, ip, geo, action, entity_type, entity_id, before jsonb, after jsonb, correlation_id, prev_hash, hash`; `REVOKE UPDATE, DELETE ON audit_events FROM bricx_app`; `AuditService.record()` inside the same tx, takes `pg_advisory_xact_lock(hashtext(org_id))`, computes `hash = sha256(prev_hash || canonical_json(row))`; `audit:verify` CLI walks a chain.
  Done when: tampering a row in test makes `audit:verify` fail at that row.
  Also (from P4-02 review): `migrations-immutable` also covers `packages/db/migrations/meta/NNNN_snapshot.json` (a Done-when item of this task).
  Also (P4-05 task plan, ADR 0055): the table adds `seq` (UNIQUE per org) and `hash_version`; statement-level triggers make it append-only for `bricx_owner` too; `hash = sha256(prev_hash ‖ utf8(JCS(row)))` with each column's serialisation pinned in ADR 0055; the lock is `pg_advisory_xact_lock(AUDT, hashtext(org_id))`, `record()` refuses anything but READ COMMITTED and is the last statement of the request transaction; run `pnpm audit:verify --org <uuid>`.

- [x] **P4-06 — Transactional outbox** 🔒 ⛔
  Touches: `modules/outbox/*`, `apps/worker/src/relay/*`
  Also (from P2-01b, ADR 0036): a compose `worker` service declares `depends_on: s3-init: condition: service_completed_successfully`.
  Also (from P2-03, ADR 0039): the worker calls `loadWorkerConfig()` from `@bricx/config/worker` first on boot; same `.env` rule as P4-01.
  Steps: table `outbox(id, org_id, topic, payload jsonb, created_at, published_at, attempts)`; `OutboxService.enqueue(tx, topic, payload)`; relay in worker polls `FOR UPDATE SKIP LOCKED`, publishes to BullMQ with `jobId = outbox.id` (idempotent), marks published; dead-letter after N attempts with alert.
  Done when: test proves rolled-back transaction produces no job; committed one produces exactly one.
  Also (P4-06 task plan, ADR 0056): the table adds `next_attempt_at`, `last_error` (a code) and `dead_at`, with CHECKs; the API writes through `insertOutbox()` in `@bricx/db/outbox` (`bricx_app` INSERT only, no RETURNING); the relay runs as the new role `bricx_relay` through `withRelayTx()`, a documented exception to rule 4; infrastructure failures (Valkey or Postgres down) never count an attempt, row failures dead-letter at `OUTBOX_DEAD_LETTER_AFTER` (default 10); Valkey runs with `noeviction` and the worker refuses to start otherwise; no compose `worker` service in P4 (`pnpm dev:worker`, D6); re-drive SQL in `docs/runbooks/outbox.md`.

- [x] **P4-07 — Error model & idempotency**
  Steps: RFC 9457 problem+json responses; error codes namespaced (`finance.approval.self_approval_forbidden`) and i18n-keyed; `Idempotency-Key` header middleware storing `(key, user, route, request_hash, response)` for 24h on all POST that create money or stock movements.
  Done when: replayed POST returns the identical response without a second write.
  Also (from the P4-06 review, PR #52): add error handlers to the API's request and probe pg pools (`openDatabase()` in `@bricx/db/database`, used by `apps/api/src/app.ts` and `apps/api/src/common/health/probes.ts`), as `openRelayDatabase()` does with a `connect` listener on every client: an idle-client error must not crash the process.
  Also (P4-07 task plan, ADR 0057): the envelope stays ADR 0047's, sent as `application/problem+json` with `traceId` = the correlation id; `TransactionCommitError(sqlstate)` from `withTx()` for a failure after `fn` resolved; `bricx.idempotency_keys` (UNIQUE org+user+route+key, user-level RLS `TO bricx_app` only, 24 h, 256 KiB, plaintext responses) with `@Idempotent()` on the route and the claim as the first statement of `TxRunner.run()`; a replay sends the stored text verbatim with `Idempotent-Replayed: true`; a non-JSON body on such a route is 415; no identity is 401 until P5; `@bricx/validation` and `@bricx/money` JSON imports carry `with { type: "json" }` so Node loads them (Metro/Hermes: must confirm at P7).

- [x] **P4-08 — OpenAPI & client generation**
  Steps: nestjs-zod DTOs; `/openapi.json`; `pnpm gen:api` runs orval → `packages/api-client` (fetch + TanStack Query hooks, bigint amounts as strings); CI fails if generated client is stale.
  Verify: `pnpm gen:api && git diff --exit-code packages/api-client`.
  Also (P4 phase plan D9, ADR 0058): the TanStack Query hooks move to P7-01 (no consumer before the Expo app); P4-08 generates the fetch client only. `GET /openapi.json` is version-neutral and unauthenticated (for architect review at P5). An `@Idempotent()` route stores the wire form of its result (`wireFormOf(handler)` from the response DTO), so a `Money` replays byte-equal; interceptor order is context → idempotency → serializer. `@bricx/money` imports `decimal.js` as a namespace and narrows its default (`decimalConstructor()`) because the api type-checks the package under `nodenext` (Metro/Hermes: must confirm at P7).

- [x] **P4-09 — Module template**
  Steps: reference module `modules/_template` (controller, service, repository, schema, policies, events, `public-api.ts`, tests); `/new-module` command copies it.
  Also (from P4-07, ADR 0057): the template shows `@Idempotent()` on its create route and `ApiError(code)` for refusals; errors never carry a message.
  Also (from P4-08, ADR 0058): the template's routes take `createZodDto` DTOs and declare `@ZodResponse({ status, type })`; adding a route regenerates the client (`pnpm gen:api`, committed) and the template shows catching SQLSTATE 23505 (`sqlstateOf()`) and raising an `ApiError`.
  Also (from P4-02 review): the pairing guard rejects `ALTER PUBLICATION … SET TABLE` and `ALTER PUBLICATION … SET (publish…)`.
  Also (from P2-02, ADR 0035): pairing rule for synced tables: the migration that publishes a table runs `GRANT SELECT ON bricx.<table> TO powersync_repl` and `ALTER PUBLICATION powersync ADD TABLE bricx.<table>` together (unpublishing revokes in the same migration); `powersync_repl` never gets default privileges. Ledger and audit tables REVOKE the default UPDATE and DELETE from `bricx_app` (rule 2).
  Also (ADR 0059): `pnpm new-module <module> <Entity> <subject>` (`scripts/new-module.mjs`, called by `/new-module`) copies the template and registers the copy at marker comments; it refuses append-only subjects (owner decision 2026-10-17) and any subject that is not project-level with `created_by`. CI job `new-module` proves a copy passes `pnpm verify`, `pnpm gen:api` with no diff and the db and api integration suites. The migrator's guard also refuses `append_only_writable` and `publication_without_grant` from the catalog. `abilityFor(identity)` (role names → role bundles) is a stand-in that P5 replaces (for architect review).
  Exit criteria P4: tenancy isolation, audit chain, outbox and idempotency integration suites green; a new developer (or Claude Code session) goes from clone to running API health check with `pnpm i && pnpm dev:up && pnpm db:migrate` (ADR 0040; no `pnpm db:seed` until P6-05b).

---

## P5 — Identity, sessions, authorization

Also (P4 exit, architect rulings 2026-10-18): these apply to whichever task meets the trigger first.
- The first P5 task that adds a table with a foreign key: the RLS test seeds parent rows before child rows (P4 point 13, ADR 0054).
- Whichever P5 task first touches the audit hash: if no test pins the `inet::text` form (`/32`, `/128`), it adds one (P4 point 14, ADR 0055).
- The next change to the guards: if no such guard exists, add a `check:workspace` guard that fails on any `nosemgrep` outside test directories (P4 point 16).

- [x] **P5-01 — Keycloak realm as code** 🔒
  Touches: `infrastructure/keycloak/realm-bricx.json`, `infrastructure/tofu/modules/keycloak/*`
  Steps: realm `bricx`; clients `bricx-client` (public, PKCE, redirect URIs for Expo scheme + web), `bricx-api` (bearer-only); access token TTL 5 min, refresh rotation on, refresh max 12h idle (configurable per org); MFA TOTP required for finance roles; WebAuthn passwordless enabled; brute-force detection; custom claims mapper `org_id` limited (authorisation data stays in BRICX DB, not tokens).
  Done when: realm import is reproducible from file.
  Also (from P4-08/P4-09, owner 2026-10-17): decide `/openapi.json` exposure per environment: public in dev; gated (authenticated) or off in production.
  Also (P5-01 task plan, ADR 0060): the realm file is a minimal realm (no users, secrets or literal localhost), imported with `IGNORE_EXISTING`, so it is the initial state only (`pnpm dev:reset` locally); the web redirect URI and origin come from `${KEYCLOAK_WEB_*}` placeholders; MFA is the `bricx-mfa` role's conditional OTP subflow with `acr` `pwd`/`mfa`; compose.yml builds an optimized image (`infrastructure/docker/keycloak/Dockerfile`, `kc.sh build`) that `tooling/keycloak-realm`'s tests also build. The `infrastructure/tofu/modules/keycloak/*` module moves to P13-01 (phase ruling D4). `/openapi.json` (ruling D1): `OPENAPI_EXPOSURE` = `public | authenticated | off`, built in P5-02.

- [x] **P5-02 — API token validation**
  Steps: JWKS-cached verification (`jose`); map `sub` → `users` row (provisioned on first login); guard populates request context.
  Verify: expired, wrong-audience, and wrong-issuer tokens → 401 tests.
  Also (P4 exit, architect ruling 2026-10-18, P4 point 23): before any user or personal-data row is written, the logger redacts database errors. It logs only the SQLSTATE, constraint, table and column, and never SQL parameters or pg `detail`/`where`. A test writes a sentinel value and fails if it appears in any 5xx log line.
  Also (P4 exit, architect ruling 2026-10-18, P4 point 25): Done when a test in `packages/db` makes a pool client of `openDatabase()` emit `'error'` and proves the process does not crash. With `keepClientsQuiet()` removed in `packages/db/src/database.ts` that test must fail directly. P4-07 sabotage 07 was caught only through unhandled errors.
  Also (P5 phase ruling D1, ADR 0060): config key `OPENAPI_EXPOSURE` = `public | authenticated | off`; default `public` in development and test, `off` in production; `public` in production is refused at config load; `authenticated` accepts any valid bearer token through this task's guard.
  Also (P5 phase ruling D3, ADR 0060): a failed token or sign-in with no known organisation writes no `audit_events` row; it writes one structured security log line through the redacting logger (reason code and correlation id, never the token, no personal data).
  Also (P5-02 task plan, approved by the owner 2026-10-21 with conditions 1-8): the first commit is the log redaction (an error serializer shared by the API and the worker, `@bricx/db/log`) with a sentinel test over the request log, the error handler, the outbox relay and the worker, plus the pool-client test. The `org_id` claim is a default-organisation hint only, never authorisation (phase ruling D7). `bricx.users` (`id`, `keycloak_sub` UNIQUE, `created_at`, `last_seen_at`) has FORCE RLS with own-row reads and is written only by `app.provision_user()`, a SECURITY DEFINER function run inside `withTx()` with a pinned `search_path`, EXECUTE for `bricx_app` only, touching only a throttled `last_seen_at` on conflict; `GLOBAL_TABLES` stays empty and `users` is not in the `powersync` publication (ruling D8). `jose` 6.2.12 with its ADR. Every token failure is one `unauthenticated` code (401, `WWW-Authenticate: Bearer`). The eight hand-copied test identity guards are deleted; positive-path tests get their ability through a test-only grants override outside `src`, and the new-module CI job stays green. The expired, wrong-audience and wrong-issuer cases run against the real Keycloak of P5-01.

- [ ] **P5-02b — Keycloak dev-stack import volume**
  Defect (owner, 2026-10-21; filing only): compose bind-mounts `realm-bricx.json` at `data/import/` inside the `keycloak-data` named volume mounted at `data`. Docker leaves 0-byte stubs in the volume for nested mounts. A stale `*.json` in `data/import` (seen twice: `bricx-placeholder-realm.json` on 2026-10-18, and again on 2026-10-21 after a reboot) makes Keycloak fail with "Failed to run import: No content to map due to end-of-input", and `pnpm dev:up` fails.
  Fix (to plan later): mount the named volume only at the dev-file database path, bind the realm file at `data/import` separately, add a compose guard test, amend ADR 0060.
  Also: `pnpm dev:reset` must complete `.env` before calling compose, or fail naming the command to run.
  Also (chores filed with the P5-03 plan, owner 2026-10-21; not started): `bsync` runs `pnpm install --frozen-lockfile` when `pnpm-lock.yaml` changed; every PR's "Verify locally (owner)" section lists the follow-up commands when `.env.example` or `pnpm-lock.yaml` changes (`pnpm install --frozen-lockfile`, `pnpm dev:up`); the runbook says to stop a leftover API with `fuser -k 4000/tcp` (`pkill -f dev:api` does not match it).

- [x] **P5-03 — Devices & sessions**
  Steps: tables `devices(id, user_id, platform, name, last_seen, trusted, revoked_at)`, `sessions(id, user_id, device_id, keycloak_sid, created_at, revoked_at)`; client sends `X-Device-Id` (generated once, stored in secure store); endpoints: list my devices, revoke device, admin revoke user.
  Also (P5 phase ruling D9, settled by the P5-03 task plan approved 2026-10-21 with conditions 1-7): `devices` is user-level (no `org_id`; `user_id → users`; on `USER_TABLES` with FORCE RLS, own rows only; `bricx_app` may UPDATE only `name`, `last_seen_at` and `revoked_at`, `revoked_at` only from NULL to a value, no DELETE or TRUNCATE; `trusted` is written by nobody until P5-07). `sessions` is org-level (`org_id` = the organisation signed into, `user_id`, `device_id`, `keycloak_sid`, `created_at`, `last_seen_at`, `revoked_at`) on `TENANT_TABLES` as catalogue resource `org.session` (actions `read`, `revoke`, org scope) plus an own-row policy on `user_id` alone, so a user sees and ends their own sessions across organisations (ADR 0063). Admin revoke user ships gated by `org.session.revoke.org`: deny-all under the production `noGrants` source until P5-05 binds grants. A revoke writes one `org.session.revoke` audit event in the request's org chain listing every affected session with its `org_id`, and one `sessions.revoked` outbox row under the request's org, in the same transaction; the relay tolerates the unconsumed topic (worker test). Device registration is audited as `org.device.register` (ids only) in the request's org chain; provisioning stays unaudited because no membership exists then (ADR 0063).
  Also (P5 phase ruling D6, ADR 0060): an `OrgSessionPolicy` port gives `min(org value, realm 12 h)`; a non-positive or non-integer org value falls back to the realm value; the production binding returns the realm value until P6-03 stores the org value. An idle or revoked session answers 401 `session_expired`.
  Also (P5 Also, P4 point 13): the RLS coverage test seeds FK parents before children (`users` → `devices` → `sessions`) and proves child-first is refused.
  Also (device binding): `X-Device-Id` absent is allowed; one that matches a non-revoked device of the user lands on the session; unknown, revoked or another user's answers 401 (`device_unknown`). Only `POST /v1/devices`, through a route decorator, accepts an unregistered header, and only when it equals the body id. Device binding is advisory until P5-07 (not an authentication factor).
  Also (P5-02 review, implemented here): `reasonFor()` maps an unclassified jose error to 401 `token_malformed`; only JWKS failures give 503. A signed token whose `sub` fails the printable-ASCII check is refused as 401 `subject_missing` before provisioning, never 500.
- [ ] **P5-04 — Immediate revocation** 🔒
  Steps: Valkey set `revoked:sid:*` and `revoked:user:*` with TTL ≥ access token TTL; guard checks on every request; revocation also calls Keycloak admin API to end sessions and emits `sync.revoke` so PowerSync credentials endpoint refuses new tokens.
  Done when: revoked user's next API call returns 401 within 1 s; next sync token request fails.

- [ ] **P5-05 — Grants, roles, project overrides** 🔒
  Steps: tables `roles` (org-editable bundles), `role_permissions`, `memberships(user, org, role)`, `project_memberships(user, project, role, overrides jsonb)`; API to edit bundles (permission `org.role.manage.org`); every change audited.
  Also (P5 phase ruling D5, ADR 0060): when a membership grants any `finance.*` permission, the user gets the Keycloak realm role `bricx-mfa` (through the outbox and the admin client), and loses it when no membership does; from here the request's organisation is chosen from the user's memberships, and the `org_id` claim only preselects a default (P5-01 condition 3).
- [ ] **P5-06 — Temporary elevated access** 🔒
  Steps: `access_grants(user, permission, scope_id, reason, granted_by, starts_at, expires_at, revoked_at)`; ability builder includes only active grants; worker job expires and audits; UI shows countdown.
- [ ] **P5-07 — Authorization guard & SoD enforcement** 🔒 ⛔
  Steps: `@Can('finance.payment.approve', { scope: 'project', from: 'params.projectId' })` decorator → CASL check; `SodService.assert(actor, record, action)` in services; unit + integration tests for all SoD pairs.
  Also (P5-01 condition 4, ADR 0060): a live login test against the Testcontainers Keycloak proves a `bricx-mfa` user must pass OTP and gets `acr` `mfa`, and a user without the role gets `acr` `pwd`; finance permissions are refused without `acr` `mfa` (a step-up error code).
  Exit criteria P5: security test suite (authn, revocation, RLS, SoD) green; 🔒 review by owner.

---

## P6 — Tenancy, region configuration, projects & sites

- [ ] **P6-01 — Global directory service** 🌍
  Steps: minimal table (in a separate `directory` DB per deployment) mapping `org_id → region_cell, api_base_url, keycloak_url`; public `GET /v1/directory/resolve?email_domain|org_slug`; client resolves cell before login.
- [ ] **P6-02 — Organizations** — CRUD, legal name, country (ISO 3166), default currency/language/timezone/units, data region (immutable after creation), branding.
- [ ] **P6-03 — Region configuration module**
  Steps: `region_configs` layered **org → project** overrides for: currency, reporting currency, language, timezone, date/number format, units, tax profile id, enabled payment adapters, accounting adapter, rate library; resolver returns effective config with provenance (which layer set each value).
  Also (P5 phase ruling D6, P5-01 condition 7, ADR 0060): an org's session idle timeout lives here and can only shorten the Keycloak realm's 12 h, never lengthen it; the API's session check (P5-03) enforces it.
- [ ] **P6-04 — Adapter registry**
  Steps: `packages/adapters/src/registry.ts` with interfaces `PaymentAdapter`, `TaxAdapter`, `AccountingAdapter`, `SmsAdapter`, `FxRateProvider`; each adapter declares supported countries/currencies; `NullAdapter` for development; registry validated at boot.
- [ ] **P6-05 — Projects & sites**
  Steps: `projects(code, name, client_org?, status, currency, reporting_currency, timezone, start/end, contract_value money)`, `sites(project_id, name, geom geography(Polygon), address, geofence_radius_m)`; PostGIS index; status machine `draft → active → on_hold → completed → archived`.
- [ ] **P6-05b — Seed & fixtures framework** (moved from P2-04, ADR 0040)
  Touches: `packages/db/seed/*`
  Steps: deterministic seed (fixed UUIDv7s) creating 2 orgs in different regions, users for each system role, 1 project with 2 sites, currencies USD/EUR/SLE/NGN/KES/GHS, languages en/fr/ar (RTL test).
  Verify: `pnpm db:seed` twice is idempotent.
  Placed here because P6-05 (`projects`, `sites`) is the last task that creates a table the seed writes (users P5-02, `roles`/`memberships` P5-05, organizations P6-02, region configs P6-03).
  Binding decisions (architect ruling 2026-10-13, ADR 0040):
  - C1: the seed connects as `bricx_app` through the existing `DATABASE_URL` (ADR 0039); no new config key. Tenant rows go through FORCE RLS like the app.
  - D: all database access through P4-03's `withTx()` from `packages/db` (CLAUDE.md rule 4); no seed-only transaction helper and no raw pool import.
  - E1: a `@bricx/config/seed` subpath reads only `NODE_ENV` and `DATABASE_URL` and refuses production and a non-local database host.
  - F: ids from `@bricx/ids` (P3-01); every seeded id is a fixed UUIDv7 literal committed in the dataset.
  - G: the injected `Clock` from `@bricx/domain` (P3-06), fixed to one seed instant; never the real clock.
  - H1: `INSERT … ON CONFLICT (id) DO NOTHING`, then compare each stored row with the dataset; a drifted row stops the run and reports table and id only, never values; the seed never overwrites.
  - I1: `pnpm db:seed` runs through `tsx` (DEPENDENCIES.md row "for seed"); its ADR records the version, publish timestamp and integrity at install time.
  - J1: both orgs in the one dev database, tagged with different region cells (`af-south-1`, `eu-west-1`; ADR 0020); a dev-only simplification.
  - K1: one user per default role bundle from `@bricx/permissions` (P3-05) in each org.
  - L1: `pg` and `testcontainers` at the versions already on `main`; one version of each repo-wide.
  Binding requirements (architect, 2026-10-13):
  1. Tests first for every "Done when" item.
  2. Seeds and fixtures use only the `bricx_owner`/`bricx_app` roles from ADR 0035 and the database URL conventions from ADR 0039. No raw pool imports (CLAUDE.md rule 4).
  3. Deterministic output: fixed UUIDv7 ids, injected `Clock`, no `Date.now()` and no random without a seed.
  4. No secrets in seed data. Fake values only.
  5. Every dependency stated with its release date and checked against the 7-day rule. Any new package needs an ADR and a DEPENDENCIES.md row.
- [ ] **P6-06 — Members & invitations** — invite by e-mail/phone, accept flow creates Keycloak user, assigns role.
  Exit criteria P6: two orgs in two cells fully isolated; effective-config resolver tested for every overridable field; `pnpm db:seed` run twice is idempotent; a new developer goes from clone to running API health check with `pnpm i && pnpm dev:up && pnpm db:migrate && pnpm db:seed` (ADR 0040).

---

## P7 — Client foundation

- [ ] **P7-01 — Expo app scaffold**
  Steps: `create-expo-app` into `apps/client` with Expo Router, TS, New Architecture; Metro monorepo defaults; `app.config.ts` reading env; bundle ids `com.bricxiq.app`; web output `static` + PWA manifest & service worker (Workbox) for installability.
  Also (from P3-01, ADR 0041): Hermes has no `crypto.getRandomValues`; provide it (`expo-crypto` is listed) before the first `@bricx/ids` id is made, or `next()` throws `no_crypto`.
  Also (from P4-08, ADR 0058; phase plan D9): install `@tanstack/react-query` and add orval's `react-query` output (hooks over the same `customFetch` mutator) to `packages/api-client`, with a status line on ADR 0016; call `configureApiClient()` at app start with the device's fetch; confirm Metro/Hermes load `@bricx/money` (`decimalConstructor()`, the UMD `Decimal.default`) and the JSON import attributes.
  Also (from P2-03, ADR 0039): the client calls `loadClientPublicConfig({ EXPO_PUBLIC_API_URL: process.env.EXPO_PUBLIC_API_URL, … })`, naming every key (Expo inlines `EXPO_PUBLIC_*` only when read by name), and imports only `@bricx/config/client-public`. Prove no secret is in the bundle: build web and native bundles and fail if any server key's value from `.env.example` appears in them.
  Verify: `pnpm --filter client start` runs on iOS sim, Android emulator, web.
- [ ] **P7-02 — Design system (`packages/ui`)**
  Steps: NativeWind config with tokens (colour, spacing, radius, typography) incl. dark mode; primitives: Button, Input, Select, Sheet, Dialog, Toast, Card, Badge, Tabs, DataList, MoneyText, DateText, EmptyState, SyncBadge; RTL-safe (`start/end` not `left/right`); Storybook for web.
- [ ] **P7-03 — Device-class shells**
  Steps: layout hook `useDeviceClass()` → `phone | tablet | desktop`; phone: bottom tabs with quick field actions; tablet: split view; desktop: sidebar + data-dense tables; route groups `(field)`, `(office)`, `(portal)`.
- [ ] **P7-04 — i18n runtime**
  Steps: i18next init with bundled `en` + runtime fetch of other locales from API/CDN (cached offline); language switcher; `I18nManager.forceRTL` handling with reload prompt on native; pseudo-locale for QA.
- [ ] **P7-05 — Auth flow**
  Steps: `expo-auth-session` OIDC PKCE against the resolved cell; tokens in `expo-secure-store` (native) / memory + refresh via httpOnly cookie through a thin BFF route on web; biometric app unlock option; logout clears local DB.
  Also (P5-01 architect review item 1, ADR 0060): passkey sign-in. P5-01 delivers the WebAuthn passwordless policy and the enabled `webauthn-register-passwordless` required action only; no browser flow has a passwordless step. This task adds a passkey alternative to the password step in `bricx browser` (with its `acr` level stated), the app's register-and-sign-in screens, and a live test that a registered passkey signs in. Logout uses the post-logout URIs `com.bricxiq.app://auth/logout` and `${KEYCLOAK_WEB_LOGOUT_URI}`.
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
  Also (from P4-09, ADR 0059): modules made by `pnpm new-module` are never published; wiring one into sync (publication `ADD TABLE` paired with `GRANT SELECT … TO powersync_repl` in one migration, a stream scope from `@bricx/permissions`, the leak test) lands here, and `pnpm new-module` learns it then.
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
  Also (from P4-07, ADR 0057): every POST that creates a journal entry carries `@Idempotent()`; a deferred balance constraint failing at COMMIT is `TransactionCommitError` → 409 `request.conflict`.
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
- [ ] **P10-03b — Document scanner** (extends P10-03)
  Goal: scan paper documents on the phone.
  Touches: `apps/client` (scan screen, web fallback), `apps/api` files module and `apps/worker` file pipeline (P8-06), `packages/permissions`, `packages/i18n` locale files (for architect review)
  Steps:
  1. On-device scan with edge detection, perspective correction, multi-page.
  2. Output one PDF.
  3. Upload through the P8 file pipeline (ClamAV, thumbnails, EXIF/metadata handling).
  4. Web fallback = camera photo + manual crop.
  Needs the scanner and OCR package ADR first (`docs/adr/pending.md`); no package is named here. (for architect review)
  Done when: a multi-page scan becomes one PDF linked to its entity; works offline (queued upload); virus-scan result recorded; viewing requires a permission; i18n keys exist; one Maestro and one Playwright happy path.
  Verify: `pnpm verify && pnpm test:integration`, plus the task's Maestro flow (native) and Playwright flow (web). (for architect review)
- [ ] **P10-04 — Workers & attendance** — worker registry (incl. subcontractor workers, no-login), ID photo, trade, day rate (Money); clock-in/out with geofence check (PostGIS on server, turf on device), optional photo; dedupe rule from P8; daily roll-up.
  Done when: photos of people require recorded consent and a restricted read permission; retention rule defined; face matching and biometrics are OUT of scope until a legal review and ADR.
- [ ] **P10-04b — Site map and surroundings, owner view** (after P10-03 and P10-04; depends on P6-05 sites)
  Goal: an owner sees the site and its surroundings on a map from anywhere, including off site on the web PWA. (for architect review)
  Touches: `apps/client` (map screen, web PWA), `apps/api` sites, photos and daily-log read endpoints, `packages/permissions`, `packages/i18n` locale files (for architect review)
  Steps:
  1. Boundary and pin from `sites.geom`.
  2. Street and satellite basemap.
  3. Distance and directions.
  4. Markers for geotagged photos and daily logs.
  5. "Last updated" time on all data.
  6. Works in the web PWA for off-site owners.
  7. Add the marker visibility permission to the `@bricx/permissions` catalogue and regenerate the artefacts (CLAUDE.md rule 11). Do not hard-code visibility in the UI.
  Done when: an owner on web sees the site boundary and the last 30 days of geotagged markers; offline shows cached tiles and last-known data with a clear stale label; marker visibility respects project permissions; BLOCKED until the tile/imagery provider decision is recorded.
  Blocked: needs the map tile and imagery provider ADR (`docs/adr/pending.md`, needed before P10 kickoff). If the provider ADR is still missing at the P10 exit report, the owner either defers P10-04b explicitly or ticks it. It is never skipped silently.
  Verify: `pnpm verify && pnpm test:integration`, plus a Playwright flow (web owner view) and a Maestro flow (offline stale label). (for architect review)
- [ ] **P10-05 — 2D drawings viewer & markups** — drawing register (discipline, number, revision, status); web: PDF.js + SVG markup layer; native: react-native-pdf + Skia layer; markups stored as vector JSON in page coords; pins linkable to tasks/issues; offline via site packages.
  Exit criteria P10: foreman completes a full offline day (attendance, daily log, 30 photos, 5 task updates, 2 markups) on Android mid-range device; syncs cleanly.

---

## P11 — Commercial core (MVP)

- [ ] **P11-01 — Materials catalogue & units** — materials with UoM conversions, categories, pg_trgm search.
- [ ] **P11-02 — Material requests** — site raises request → approvals engine → issued from store or sent to procurement (R2); offline creation allowed, approval online only.
- [ ] **P11-03 — Basic inventory** 🔒 — stores per site; `stock_movements` append-only (receipt, issue, transfer, adjustment, return) with quantities as `numeric(18,6)` in base UoM and valuation Money; on-hand read-model; negative stock blocked; adjustments require permission + reason + audit; stock valuation posts to ledger via outbox.
  Also (from P4-07, ADR 0057): every POST that creates a stock movement carries `@Idempotent()`.
- [ ] **P11-04 — Budgets** 🔒 — cost codes (org template + project), budget lines Money per cost code, versions (original, revised), committed vs actual vs forecast read-model.
- [ ] **P11-05 — Expenditures** 🔒 — record expense with receipt photo, payee, cost code, currency, FX at transaction date; approval flow; on `recorded` → ledger posting; offline capture as draft only (never auto-posted).
- [ ] **P11-05b — Receipt capture and OCR** 🔒 (extends P11-05)
  Goal: read amount, date, payee from a receipt photo.
  Touches: `apps/client` expense capture (P11-05), `apps/api` expenditures module (P11-05), `packages/i18n` locale files (for architect review)
  Steps:
  1. On-device text recognition (no network call).
  2. Result is a SUGGESTION shown for confirmation.
  3. Amount parsed through `@bricx/money` with an explicit currency.
  4. Original image stored as evidence.
  5. Manual entry always available.
  6. Web: manual entry only, unless the package ADR finds an offline in-browser text-recognition option. (for architect review)
  Needs the scanner and OCR package ADR first (`docs/adr/pending.md`); no package is named here. (for architect review)
  Done when: unit and property tests cover ambiguous formats ("1.234,50" vs "1,234.50"), garbage input, and zero or negative amounts; nothing is posted without user confirmation and approval flow; offline result is a draft; OCR failure falls back to manual entry.
  Verify: `pnpm verify && pnpm test:integration` (for architect review)
- [ ] **P11-06 — Project cost dashboard** — budget vs committed vs actual per cost code, in project and reporting currency, with FX disclosure.
  Exit criteria P11: every money movement in P11 traces to a balanced journal entry; audit chain verifies.

---

## P12 — Notifications & messaging basics (MVP)

- [ ] **P12-01 — Notification service** — event → rules → channels (push, in-app, e-mail, SMS) with per-user preferences and quiet hours in user timezone; templates localized via i18n keys; delivery log.
- [ ] **P12-02 — Push** — Expo push tokens per device, revoked with device; deep links into Expo Router.
- [ ] **P12-03 — SMS & e-mail adapters** — SES; SMS adapter for launch countries; OTP not sent by BRICX (Keycloak handles auth).
- [ ] **P12-04 — Live updates** — WebSocket gateway authenticated with same token + revocation check; rooms per project; used for approvals inbox and dashboards.
- [ ] **P12-04b — Live site presence** 🔒 (after P12-04 and P10-04)
  Goal: authorised viewers see who is on site now. (for architect review)
  Touches: `apps/api` attendance module (P10-04) and WebSocket gateway (P12-04), `apps/client`, `packages/permissions`, `packages/i18n` locale files (for architect review)
  Steps:
  1. Server-derived read model "who is on site now" from clock-in/out events.
  2. Delivered over the project WebSocket room; not a synced table.
  3. Read-model refresh and room publish go through the outbox (CLAUDE.md rule 5). (for architect review)
  4. Add the live-presence visibility permission to the `@bricx/permissions` catalogue and regenerate the artefacts (CLAUDE.md rule 11). Do not hard-code visibility in the UI.
  Done when: a clock-in appears for authorised viewers within seconds while online; shows last-updated time; revoked sessions stop receiving it; viewing presence requires a dedicated permission entry in @bricx/permissions.
  Verify: `pnpm verify && pnpm test:integration`; the delivery test asserts that the clock-in event reaches the room, with no wall-clock time limit (CI runners are slower). (for architect review)

---

## P13 — Cloud infrastructure & delivery pipeline

- [ ] **P13-01 — OpenTofu layout** 🌍 🔒
  Touches: `infrastructure/tofu/{modules,envs/{dev,staging,prod-af,prod-eu},global}`
  Modules: network (VPC, private subnets, NAT), rds (Postgres 18, Multi-AZ prod, PITR, KMS, logical replication params), valkey, s3 (+ versioning, object lock on audit exports bucket), cloudfront + WAF, ecs (api, worker, relay, powersync, keycloak), secrets, kms, observability, directory (global). Remote state in S3 with locking; one state per env.
  Also (from P4-02, ADR 0052): the RDS bootstrap creates the `bricx_migrations` schema, owned by `bricx_owner`, no grants.
  Also (from P4-06, ADR 0056): the RDS bootstrap creates `bricx_relay` (LOGIN, NOBYPASSRLS, `search_path = bricx, pg_temp`, `idle_in_transaction_session_timeout = '30s'`, CONNECT and USAGE on `bricx` only); the valkey module sets persistence and `maxmemory-policy noeviction` (the worker refuses to start otherwise; if the managed service blocks `CONFIG GET`, decide how the worker checks the policy).
  Also (from P5-01, phase ruling D4 and condition 2, ADR 0060): the `keycloak` module (the ROADMAP's `infrastructure/tofu/modules/keycloak/*`, moved here) creates each cell's realm from `infrastructure/keycloak/realm-bricx.json` with the web redirect URI and origin set per environment. The file is imported only into an empty realm (`IGNORE_EXISTING`), so realm changes reach running realms through this module or an idempotent admin-API step in the deploy pipeline, never a re-import, with a drift check that compares each live realm with the file the way `tooling/keycloak-realm`'s import test does. Production Keycloak gets its own image (Postgres database, TLS, hostname); `infrastructure/docker/keycloak/Dockerfile` is for dev and test only. Each environment also sets the realm's SMTP server (password-reset e-mail; the file sets none) and the three web placeholders `KEYCLOAK_WEB_REDIRECT_URI`, `KEYCLOAK_WEB_ORIGIN` and `KEYCLOAK_WEB_LOGOUT_URI`.
- [ ] **P13-02 — Container images** — multi-stage Dockerfiles (distroless/node for api/worker), non-root, Trivy scan in CI, SBOM (Syft), images signed (cosign).
  Also (from P4-01, P4 plan D6, ADR 0051): when `api` and `worker` are added to the compose stack, they declare `depends_on: s3-init: condition: service_completed_successfully` (ADR 0036); decide whether the image keeps `apps/api`'s `.js`→`.ts` resolve hook or bundles the workspace packages.
  Also (from P4-03, ADR 0053): set Fastify `trustProxy` for the load balancer; otherwise `request.ip`, and with it the request context's (and the audit log's) ip, is the load balancer's address.
- [ ] **P13-03 — Deploy pipeline** — GitHub OIDC → AWS (no long-lived keys); on merge to `main`: build → push → migrate (one-off ECS task as `bricx_owner`) → deploy staging → smoke tests → manual approval → prod cells sequentially (af, then eu).
  Also (from P4-02, D8): apply migrations to the previous release's snapshot before deploy.
  Also (from P4-02, ADR 0052): the RDS bootstrap creates the `bricx_migrations` schema, owned by `bricx_owner`, no grants.
  Also (from P4-02 review): `MIGRATION_DATABASE_URL` must be a direct Postgres connection, not a pooler (the migrator's session advisory lock; ADR 0003).
  Also (from P4-04, ADR 0054): the RDS bootstrap creates schema `app` (owned by `bricx_owner`, REVOKE ALL FROM PUBLIC, USAGE for `bricx_app` and `bricx_readonly`) and runs `ALTER DEFAULT PRIVILEGES FOR ROLE bricx_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`.
  Also (from P4-05, ADR 0055): deleting the newest audit events leaves a valid, shorter chain. Anchor each org's audit head (`seq`, `hash`) outside the database (for example the object-locked audit exports bucket) and run `audit:verify` as a scheduled job that compares each chain with its anchor.
  Also (from P4-06, ADR 0056): the bootstrap step creates `bricx_relay` (see P13-01); outbox retention: published rows are kept until a retention job removes them, by partition drop or an explicit `bricx_owner` DELETE policy (a plain owner DELETE deletes 0 rows under FORCE RLS).
  Also (from P4-07, ADR 0057): `bricx.idempotency_keys` purge: expired rows are reused in place but never deleted (no DELETE policy, `bricx_owner` bound by FORCE); the owner decides the retention policy here (partition drop or an explicit `bricx_owner` DELETE policy) with the outbox's.
- [ ] **P13-04 — Mobile & web release** — EAS profiles `development | preview | production`; channels mapped to envs; `eas update` for JS-only fixes with runtime version policy `fingerprint`; store submission via `eas submit`; web PWA deployed to S3/CloudFront with cache-busting and service-worker update prompt.
- [ ] **P13-05 — Observability** — OTel SDK in api/worker (HTTP, pg, BullMQ spans); dashboards: API RED metrics, queue depth/age, outbox lag, sync upload rejects/conflicts, FX staleness, ledger post failures; alerts to on-call channel.
  Also (from P4-06, ADR 0056): alert on `outbox.dead_letter` and on `outbox.relay_unavailable` lasting more than a few minutes; dashboard pending and dead outbox rows.
  Also (P5 phase ruling D3, ADR 0060): alert on the security log line for failed tokens and sign-ins with no known organisation (P5-02).
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

### Unscheduled (no task ID yet)
- TrackerAdapter contract for hardware GPS trackers on equipment and vehicles; provider undecided.

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
