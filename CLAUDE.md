# BRICX IQ — Claude Code Project Rules

Construction management platform: global, offline-first, cross-platform, financially sensitive, fully auditable.

## Read first
- `docs/STACK.md` — the stack. Decisions are final; do not propose alternatives unless an ADR is being written.
- `docs/ROADMAP.md` — work one phase at a time, tasks in order.
- `docs/adr/` — why things are the way they are.
- `docs/DEPENDENCIES.md` — every allowed package. Anything else needs an ADR.
- `docs/product/` — what we are building (concept + constraints). Reference only; STACK/ROADMAP win on conflict.
- `docs/brand/BRAND.md` — colour tokens, logos, pending design decisions.

## Session start (mandatory)
- If `docs/STACK.md`, `docs/ROADMAP.md` or `docs/DEPENDENCIES.md` is missing, STOP and report. Never build from your own judgment.
- Find the phase: the first phase after P3 whose exit the owner has not approved, or the one the human names. Inside an approved phase plan, work tasks in ROADMAP order, skipping tasks marked 'Moved to'. Work on nothing outside the approved plan.
- `salvage/v0` is an earlier non-compliant prototype. Reference only (money, currencies, audit chain, expense rules). Never merge it or copy its structure.

## Workflow
1. One phase = one thread (resumable across sessions). Inside it: one branch `<task-id>-<slug>` and one PR per task, run in order. Never run parallel threads or split a task across sub-agents.
2. Phase kickoff, in plan mode: post ONE phase plan (task order, dependencies, decisions needed from the owner, risks, how each Done-when is verified) and stop for approval. 🔒 tasks additionally get their own task plan and stop for approval before any code is written. A material change to the approved plan (a new or reordered task, a new dependency, a new decision) needs owner re-approval before work continues.
3. Tests before implementation for every "Done when" item.
4. Run `pnpm verify` (plus the task's Verify command) until green.
5. Tick the task in ROADMAP.md, add a row to docs/PROGRESS.md, commit (Conventional Commits).
6. Push each task branch and open ONE PR per task to main. Title `<type>(<scope>): <summary> (<task-id>)`, e.g. `ci: add CI skeleton (P1-06)`: the pr-title CI check runs commitlint on it, and the squash merge puts it on main. Body: what changed, Done-when checklist, verify output. After a non-🔒 PR opens, the thread may start the next task from main only if it is independent: it does not need the open PR's code and does not touch the same files, migration sequence or generated artefacts; a dependent task waits for the merge. Never rebase a pushed branch, force-push or merge. If an earlier merge leaves an open PR conflicting with main (typically only ROADMAP.md and PROGRESS.md), report it to the owner. The owner either resolves it in GitHub's conflict editor (keeping both PROGRESS rows), or tells the thread to recreate the branch as `<task-id>-<slug>-r2` from main, re-apply the task's changes, ROADMAP tick and PROGRESS row, push it with `git push -u origin`, and open a new PR that links the old one; the owner closes the old PR. After a 🔒 PR opens, stop: start no further task until the architect has reviewed and the owner has merged. Never merge.
7. Batching: small non-🔒 tasks in the same package may share one PR; the PR body lists every task ID with its own Done-when checklist. The title carries the first task ID.
8. Phase exit: post an evidence report (each task's Done-when and the phase exit criteria, with command output). Do not start the next phase until the owner approves it.
9. Hybrid execution applies from P4 onward (ADR 0050). ROADMAP.md stays authoritative; subtasks remain the tracking units.

## Commands
- `pnpm dev:up | dev:down | dev:reset` — local stack (Postgres 18+PostGIS, Valkey, SeaweedFS, Keycloak, PowerSync, Mailpit, ClamAV)
- `pnpm db:migrate | db:seed | db:generate`
- `pnpm gen:api` — regenerate packages/api-client from OpenAPI
- `pnpm verify` — typecheck + lint + unit tests
- `pnpm test:integration` — Testcontainers suites
- `pnpm i18n:check` — locale completeness

## Layout
apps/client (Expo: iOS/Android/web PWA) · apps/api (NestJS modular monolith) · apps/worker (BullMQ + outbox relay)
packages/{ids,money,i18n,validation,permissions,domain,db,sync-schema,ui,api-client,adapters,config}
infrastructure/{docker,tofu,keycloak}

## Non-negotiable rules
1. Money = `bigint` minor units + ISO 4217 code via `@bricx/money`. Never float. FX rates `NUMERIC(24,12)` + decimal.js.
2. Ledger and audit tables are append-only. App role has INSERT/SELECT only. Fix = reversing entry.
3. Every tenant table: `org_id`, FORCE RLS, and — if synced — a PowerSync stream scope plus a leak test. RLS does NOT protect replication.
4. All DB access through `withTx()` (sets `app.org_id`, `app.user_id`, `app.project_ids`). Never import the raw pool.
5. Side effects (jobs, notifications, payments, webhooks out) go through the outbox in the same transaction. Never enqueue BullMQ directly from a request.
6. UUIDv7 ids; syncable ids generated on device.
7. `timestamptz` UTC in storage; render in user/project timezone. Use injected `Clock`, not `Date.now()`, in domain code.
8. No hard-coded user-facing string, currency, unit, or date format. i18n keys only; RTL-safe styles (`start/end`).
9. Financial records never auto-merge on sync conflict.
10. Segregation of duties server-side: requester ≠ approver. Payments confirmed only by verified webhook or server-to-server check.
11. Authorization in four layers, all generated from `@bricx/permissions`: CASL (API + UI) → RLS → sync streams → SoD.
12. Migrations: forward-only, expand/contract, hand-reviewed SQL. Never edit an applied migration.
13. API modules talk to each other only via `public-api.ts`.

## Never
- Push to main, merge any PR, force-push, or run destructive SQL outside the local stack.
- Read or write `.env.production*` or real credentials.
- Add a dependency that duplicates a chosen tool (e.g. a second styling lib, ORM, or state manager).
- Weaken a test to make it pass.
- Commit tool-generated agent instruction files (AGENTS.md, .cursorrules, etc.). CLAUDE.md is the only agent rulebook. If a tool writes one, disable it in that tool's config and report it.
