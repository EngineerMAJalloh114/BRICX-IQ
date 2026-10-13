# 0040. Re-home the seed framework and amend the P2 exit

- Status: Accepted
- Date: 2026-10-13
- Deciders: Mohamed Abass Jalloh
- Source: P2-04 plan review (2026-10-13 02:03Z): plan not approved to build; ruling A2 (defer the task), B1 (amend the P2 exit), and decisions C–L recorded for the moved task; ADR 0035 (database roles); ADR 0039 (config loading, `DATABASE_URL` as `bricx_app`).

## Context

ROADMAP P2-04 asks for a deterministic seed of 2 organizations, users for each system role, 1 project with 2 sites, 6 currencies and 3 languages, with `pnpm db:seed` idempotent. None of what it writes or depends on exists in P2:

- The tables come later: users (P5-02), `roles` and `memberships` (P5-05), organizations (P6-02), region configuration (P6-03), `projects` and `sites` (P6-05). `pnpm db:migrate` arrives with P4-02.
- CLAUDE.md rule 4 requires `withTx()`, which P4-03 builds. Fixed UUIDv7 ids come from `@bricx/ids` (P3-01), the injected `Clock` from `@bricx/domain` (P3-06) and the role bundles from `@bricx/permissions` (P3-05).

The P2 exit line also ran `pnpm db:migrate`, so the P2 gate could not close before P4, while the ROADMAP says no phase starts with an open gate behind it.

## Decision

1. **Move the task.** The seed and fixtures framework becomes **P6-05b**, directly after P6-05, the last task that creates a table the seed writes. Its Steps and Verify are copied unchanged. P2-04 stays unticked in the ROADMAP with a pointer to P6-05b; the work and its tick belong to P6-05b.
2. **Binding decisions for P6-05b** (architect ruling 2026-10-13):
   - C1: connect as `bricx_app` through the existing `DATABASE_URL` (ADR 0039); no new config key.
   - D: all database access through P4-03's `withTx()`; no seed-only transaction helper, no raw pool import.
   - E1: a `@bricx/config/seed` subpath reading only `NODE_ENV` and `DATABASE_URL`, refusing production and a non-local database host.
   - F: ids from `@bricx/ids`; every seeded id a fixed UUIDv7 literal in the dataset.
   - G: the injected `Clock` from `@bricx/domain`, fixed to one seed instant.
   - H1: `INSERT … ON CONFLICT (id) DO NOTHING`, then compare stored rows with the dataset; drift stops the run with table and id only; never overwrite.
   - I1: run through `tsx` (already allow-listed for seeds); versions and the 7-day check recorded at install time.
   - J1: both organizations in the one dev database, tagged `af-south-1` and `eu-west-1` (ADR 0020), a dev-only simplification.
   - K1: one user per default role bundle (P3-05) in each organization.
   - L1: `pg` and `testcontainers` at the versions on `main`, one version of each repo-wide.
3. **Binding requirements for P6-05b:** tests first for every "Done when" item; only the `bricx_owner`/`bricx_app` roles (ADR 0035) and the ADR 0039 URL conventions, no raw pool imports; deterministic output (fixed UUIDv7 ids, injected `Clock`, no `Date.now()`, no unseeded random); no secrets, fake values only; every dependency with its release date checked against the 7-day rule, and an ADR plus a DEPENDENCIES.md row for any new package.
4. **P2 exit criteria** become: `pnpm i && pnpm dev:up` with every service healthy, and `pnpm test:integration` green.
5. **P4 exit criteria** gain the full clone-to-API-health-check line: `pnpm i && pnpm dev:up && pnpm db:migrate && pnpm db:seed`.

No code, dependency or lockfile change.

## Alternatives rejected

- **A1, build the framework in P2 with table writers added later:** `pnpm db:seed` would write nothing until P4–P6, and the seed would need its own transaction helper, id derivation and clock, each replaced later.
- **A3, create the tables in P2-04:** takes the schema away from P4-02's hand-reviewed migrations and from the tasks that own each table.

## Consequences

- P2 can close on what P2 delivers (a healthy stack and green integration tests), so P3 can start.
- P4-03 and P4-04 integration tests that need two organizations build their own fixtures until P6-05b exists. (for architect review)
- The P4 exit line runs `pnpm db:seed`, which P6-05b creates, so the P4 gate cannot pass before P6-05b unless that line changes. (for architect review)
- `/next-task` (`.claude/commands/next-task.md`) picks the first unchecked task, and P2-04 stays unchecked, so it will offer P2-04 until the command or the marker changes. (for architect review)
- D puts the seed on P4-03's `withTx()`, which the ROADMAP places in `apps/api/src/common/db`; packages may not import apps (eslint-plugin-boundaries), so P6-05b must first decide where `withTx()` lives for `packages/db/seed`. (for architect review)
- The table-to-task mapping in Context is read from the ROADMAP's Steps (users in P5-02 is inferred from "map `sub` → `users` row"); if a later task moves a table, P6-05b moves with it. (for architect review)
