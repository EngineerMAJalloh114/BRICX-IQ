# 0035. Database bootstrap roles, the `bricx` schema and PowerSync's replication identity

- Status: Accepted
- Date: 2026-10-02
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P2-02; ADR 0003 (non-owner app role), ADR 0023 (dependency policy), ADR 0031 (CI rules), ADR 0034 (dev stack); P2-02 architect requirements 1–14 and rulings A2 (gated), B1, C1, D1, E1 (2026-10-02)

## Context

Until P2-02 the local Postgres had only the bootstrap superuser, and PowerSync replicated and stored its buckets as that superuser with no publication (ADR 0034). ADR 0003 requires the application to connect as a non-owner, non-BYPASSRLS role, and migrations to run as a separate owner. CLAUDE.md rule 3: RLS does not protect replication.

What was measured on 2026-10-02 (PostgreSQL 18.6 + PostGIS 3.6.4 and PowerSync 1.26.1, the images ADR 0034 pins):

- **PowerSync's health signals.** `/probes/liveness` and `/probes/readiness` report process state only. The admin diagnostics API (`POST /api/admin/v1/diagnostics`, bearer token from `api.tokens`, 401 without) reports `connections[].connected`, `connections[].errors[]` (re-checked live: a missing publication is `fatal` `PSYNC_S1141`), and for the active sync config `initial_replication_done`, `last_lsn`, keepalive and checkpoint times, `replication_lag_bytes` and `errors[]`.
- **`pg_stat_replication` is NOT a valid health signal on PostgreSQL 18.** After `DROP PUBLICATION powersync`, `pg_stat_replication` still shows `powersync_repl | streaming` and the slot stays active, while PowerSync reports `PSYNC_S1141`. `powersync-health.int.test.ts` asserts this on every run.
- **Dropping the publication loses data (confirmed).** A row written while the publication was missing never replicated after it was restored, although later rows did (source 3 rows, PowerSync 2). `powersync-health.int.test.ts` asserts this on every run.
- **PowerSync's initial snapshot honours RLS.** It reads with plain `SELECT`; for a NOBYPASSRLS role it warns `PSYNC_S1145` and copies zero rows from a table with RLS enabled.
- **A2 gate:** with tables in a dedicated `bricx` schema and extensions in `extensions`, PowerSync replicated a `bricx` table with FORCE RLS (publication `FOR TABLE bricx.items`, sync rule `SELECT * FROM bricx.items`): snapshot, streaming inserts and the storage counts matched. `bricx_app` called PostGIS (`ST_MakePoint`, geography `ST_Distance`), pgcrypto (`digest`, `gen_random_bytes`, `crypt`) and `pg_trgm` unqualified through its pinned search_path.

## Decision

- **Roles** (created by `infrastructure/docker/postgres/init/01-bootstrap.sh`; every attribute explicit, all `NOSUPERUSER NOCREATEDB NOCREATEROLE`):

  | Role | Attributes | Access |
  |---|---|---|
  | `bricx_owner` | LOGIN, NOREPLICATION, NOBYPASSRLS | Owns schema `bricx` and publication `powersync`; runs migrations |
  | `bricx_app` | LOGIN, NOREPLICATION, NOBYPASSRLS | CONNECT; USAGE on `bricx`, `extensions`; default SELECT, INSERT, UPDATE, DELETE on tables and USAGE, SELECT on sequences that `bricx_owner` creates (no TRUNCATE, REFERENCES, TRIGGER); no CREATE anywhere |
  | `bricx_readonly` | LOGIN, NOREPLICATION, NOBYPASSRLS | CONNECT; USAGE; default SELECT on tables |
  | `powersync_repl` | LOGIN, REPLICATION, **BYPASSRLS** (C1) | CONNECT; USAGE; **no default privileges**: SELECT only on published tables |
  | `powersync_storage_owner` | LOGIN, NOREPLICATION, NOBYPASSRLS (B1) | Owns database `powersync_storage` only; no CONNECT on the app database |

- **PUBLIC:** `REVOKE ALL` on both databases (CONNECT, TEMPORARY, CREATE) and on schemas `public`, `extensions` and `bricx`. CONNECT is granted only as in the table; nobody gets TEMPORARY.
- **Pinned search_path on every role** (role-level `ALTER ROLE … SET`): `bricx, extensions, pg_temp` for the four app-database roles, `powersync, pg_temp` for `powersync_storage_owner`. `pg_temp` is listed last, so a temporary object can never shadow ours.
- **Schema (A2):** application tables live in `bricx`, owned by `bricx_owner`. Extensions `postgis`, `pg_trgm`, `btree_gist` and `pgcrypto` live in `extensions`, owned by the bootstrap superuser. `public` holds nothing and grants nothing. Consequences for later tasks: Drizzle schemas use `pgSchema('bricx')` and drizzle-kit `schemaFilter: ['bricx']`, with the migrations-table schema decided in P4-02; PowerSync sync rules name tables `bricx.<table>`; the RLS and leak checks of P4/P8 can be "every table in `bricx`".
- **Publication `powersync` is created EMPTY**, publishes insert, update, delete and truncate (PowerSync requires all four), and is owned by `bricx_owner` so migrations can alter it (`ALTER PUBLICATION … ADD TABLE` needs ownership of both the publication and the table).
- **Pairing rule (requirement 2).** Every migration that publishes a table runs, in the same migration, `GRANT SELECT ON bricx.<table> TO powersync_repl` and `ALTER PUBLICATION powersync ADD TABLE bricx.<table>`; unpublishing revokes the grant in the same migration. `powersync_repl` never gets default privileges. **The publication is never dropped or recreated** (rows written while it is missing are lost): ROADMAP P4-02's migration guard rejects `DROP PUBLICATION` and `CREATE PUBLICATION`, and P4-09's module template carries the pairing rule.
- **RLS does not protect replication; sync streams and leak tests (P8-02) do; `powersync_repl`'s credential can read every tenant's rows in published tables and must never leave the sync service.** BYPASSRLS is needed because PowerSync's snapshot reads with plain `SELECT` and every tenant table forces RLS. It reaches only tables it is granted, which by the pairing rule are exactly the published ones. ROADMAP P8-02 adds: initial sync must prove the row count equals the source count for each published table.
- **The bootstrap superuser is bootstrap-only.** It is used by the init scripts and the postgres healthcheck only. PowerSync replicates as `powersync_repl` and stores buckets as `powersync_storage_owner`. `check:workspace` fails if `POSTGRES_SUPERUSER_*` appears anywhere in compose.yml outside the `postgres` service (comments included) or in any other tracked file except `.env.example`, Markdown and the guard fixtures.
- **Passwords** come from `.env` (obviously fake `dev-only-…` values in `.env.example`). The init script passes each to psql as a variable quoted with `:'name'`, so no password is a literal in SQL, and it fails if any is empty. Init scripts run only on an empty volume.
- **`pnpm dev:up`** appends every key that `.env.example` has and `.env` lacks (never touching existing lines) and prints them; starts `postgres` first and, if the five roles, the `bricx` and `extensions` schemas or the publication are missing (a volume created before P2-02), stops with an instruction to run `pnpm dev:reset`. It asks inside the container as the image's `POSTGRES_USER`, so the script never handles the superuser's credentials.
- **PowerSync healthcheck (D1):** `infrastructure/docker/powersync/healthcheck.mjs` calls the diagnostics API on `127.0.0.1` with `PS_API_TOKEN` (from `POWERSYNC_API_TOKEN`), and is healthy only if the source connection is up, it and the active sync config report no `fatal` error, and initial replication is done. It never prints the token. The API port stays published on `127.0.0.1` only.
- **Integration tests (`tooling/db-bootstrap`, private).** `packages/db` arrives in P4-02 (which may move them). `db-roles.int.test.ts` and `powersync-health.int.test.ts` run compose.yml's images (read from compose.yml, no second copy), mount the REAL `postgres/init` folder, the real `powersync.yaml` and the real `healthcheck.mjs`, take role passwords from `.env.example`, and use a throwaway superuser generated per run. Checks return a list of problems. Five sabotage cases (app BYPASSRLS, CREATE to PUBLIC, PUBLIC CONNECT left by a dropped REVOKE, an unpublished table granted to `powersync_repl`, `powersync_repl` without BYPASSRLS) must each be reported, and must pass again once reverted. Polling is bounded; there are no fixed sleeps.
- **`integrationPreset`** in `@bricx/vitest-config`: `*.int.test.*` only, from a `vitest.integration.config.mts` (so root and unit runs never pick them up; `defaultPreset` now excludes them), no coverage, no retries, one file at a time, zero test files fail. Proven by three `vitest-smoke` fixtures. `check:workspace` requires every package with `*.int.test.*` files to have `test:integration` = `vitest run --config vitest.integration.config.mts` using the preset (and no such script without such files), at least one such package, the root script `turbo run test:integration`, and `cache: false` for that turbo task.
- **Dependencies (E1, ADR 0023):** `testcontainers` 12.1.0 and `@testcontainers/postgresql` 12.1.0 (2026-08-04), `pg` 8.23.0 (2026-08-08), `@types/pg` 8.23.1 (2026-08-17): the newest release of each at least 7 days old. `pg` is the driver `packages/db` uses from P4. Three install scripts in the `dockerode` tree stay unapproved (`ssh2`, `cpu-features`, `protobufjs`); the tests pass without them. Testcontainers' cleanup container `testcontainers/ryuk:0.14.0` is pinned as `RYUK_IMAGE` (`@sha256:7c1a8a9a47c780ed0f983770a662f80deb115d95cce3e2daa3d12115b8cd28f0`) through `RYUK_CONTAINER_IMAGE` (the name testcontainers 12 reads), listed in DEPENDENCIES.md section 8 and checked by `check:workspace`. `db-roles.int.test.ts` proves every running Ryuk container runs that image.
- **CI:** an `integration` job (needs `install`, SHA-pinned checkout, `persist-credentials: false`, no `if:`, no job permissions, no cache step) runs `pnpm test:integration`. Adding it to the required checks of ruleset "main: protect" is an owner step after the job has run once (`docs/runbooks/github-settings.md`).

## Consequences

Positive:
- `bricx_app` cannot create, alter, drop or truncate anything, cannot bypass RLS, and sees zero tenant rows without a transaction context.
- PowerSync no longer runs as a superuser, and "healthy" now means replication works.
- Every bootstrap property is re-proven on every CI run against the real init folder, and each check is proven to fail when its property breaks.

Negative:
- Existing volumes need `pnpm dev:reset`, which deletes all local stack data; init scripts run only once, so changing a role password in `.env` later also needs a reset. (architect-reviewed 2026-10-02)
- `powersync_repl` can read every tenant's rows in published tables (BYPASSRLS); a leaked replication credential exposes all published data across orgs. (architect-reviewed 2026-10-02)
- `bricx_readonly` sees zero rows in RLS tables without a context; reporting needs its own context or policies later. (architect-reviewed 2026-10-02)
- Default privileges give `bricx_app` UPDATE and DELETE on every new table; ledger and audit migrations (P4) must REVOKE them to stay append-only (CLAUDE.md rule 2). (architect-reviewed 2026-10-02)
- The dedicated schema means every Drizzle schema, drizzle-kit config, sync rule and ad-hoc query must name `bricx`, and PostGIS cannot later be moved out of `extensions` (it is not relocatable). (architect-reviewed 2026-10-02)
- Dropping the publication is silent data loss (rows written meanwhile never replicate); only the P4-02 migration guard and review stand in the way. (architect-reviewed 2026-10-02)
- The healthcheck depends on PowerSync's admin diagnostics API, whose response shape is not a stable contract; an upgrade can turn it red until the healthcheck is updated (the fixtures in `scripts/guard-fixtures/diagnostics/` pin the shape we read). It also adds one more dev secret (`POWERSYNC_API_TOKEN`). (architect-reviewed 2026-10-02)
- Ryuk mounts the Docker socket and publishes a port while tests run; Testcontainers also reuses any Ryuk container already running on the machine, and the Ryuk test then fails if that one is not the pinned image. (architect-reviewed 2026-10-02)
- Each integration run pulls the postgis, PowerSync and Ryuk images anonymously from Docker Hub; shared CI runner IPs can hit Docker Hub's anonymous rate limit. (architect-reviewed 2026-10-02)
- The repo-wide superuser scan matches text, so a legitimate future need (such as a backup script) needs a guard change. (architect-reviewed 2026-10-02)

## Alternatives rejected

- **A1, tables in `public`:** PostGIS's `spatial_ref_sys` and ~1,000 functions and types would share the tenant schema, so "every table has `org_id` and FORCE RLS" checks need exemptions.
- **B2, `powersync_repl` also owns the storage database:** the replication role would hold DDL rights in a database. **B3, a second Postgres container:** more memory and one more service for the same isolation.
- **C2, NOBYPASSRLS plus a per-table policy for `powersync_repl`:** three paired statements per table, and a forgotten policy syncs zero rows silently.
- **D2, a one-off health proof:** not re-proven when PowerSync or Postgres changes.
- **E2, Ryuk disabled:** a crashed local run leaves containers behind.
- **A Postgres-side health signal (`pg_stat_replication`, slot `active`):** reports streaming while the publication is gone (Context).
