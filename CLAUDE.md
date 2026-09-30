# BRICX IQ — Claude Code Project Rules

Construction management platform: global, offline-first, cross-platform, financially sensitive, fully auditable.

## Read first
- `docs/STACK.md` — the stack. Decisions are final; do not propose alternatives unless an ADR is being written.
- `docs/ROADMAP.md` — work one task at a time, in order.
- `docs/adr/` — why things are the way they are.
- `docs/DEPENDENCIES.md` — every allowed package. Anything else needs an ADR.
- `docs/product/` — what we are building (concept + constraints). Reference only; STACK/ROADMAP win on conflict.
- `docs/brand/BRAND.md` — colour tokens, logos, pending design decisions.

## Session start (mandatory)
- If `docs/STACK.md`, `docs/ROADMAP.md` or `docs/DEPENDENCIES.md` is missing, STOP and report. Never build from your own judgment.
- Find the task: first unchecked ID in ROADMAP.md, or the ID the human names. Work on nothing else.
- `salvage/v0` is an earlier non-compliant prototype. Reference only (money, currencies, audit chain, expense rules). Never merge it or copy its structure.

## Workflow
1. One task per session, one thread, one branch `<task-id>-<slug>`, one PR. Never run parallel threads or split a task across sub-agents.
2. Plan mode first. Post the plan and stop for approval on every task. 🔒 tasks additionally require architect review of the PR before merge.
3. Tests before implementation for every "Done when" item.
4. Run `pnpm verify` (plus the task's Verify command) until green.
5. Tick the task in ROADMAP.md, add a row to docs/PROGRESS.md, commit (Conventional Commits).
6. Push the task branch and open ONE PR to main. Title `<task-id>: <summary>`. Body: what changed, Done-when checklist, verify output. Then stop. Never merge.

## Commands
- `pnpm dev:up | dev:down | dev:reset` — local stack (Postgres 18+PostGIS, Valkey, MinIO, Keycloak, PowerSync, Mailpit, ClamAV)
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
