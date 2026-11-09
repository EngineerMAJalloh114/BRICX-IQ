# 0076. Seed and fixtures: a deterministic, idempotent dev seed through withTx()

- Status: Accepted
- Date: 2026-11-09
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP P6-05b (moved from P2-04, ADR 0040) with its binding decisions C1, D, E1, F, G, H1, I1, J1, K1, L1 and requirements 1–5 (architect ruling 2026-10-13); P6 phase plan approved 2026-11-06 16:46Z (D1–D4, rulings R3 and R9); P6-05b task plan approved 2026-11-09 08:55Z (architect calls 1–6 as recommended) with owner conditions 1–6 (09:03Z); ADR 0020 (region cells), 0023 (dependency policy), 0035 (database roles), 0039 (config), 0062 (users), 0072 (organisations), 0075 (projects and sites); CLAUDE.md rules 3, 4, 6, 7

## Context

Every phase so far has seeded its own rows inside its own tests (`@bricx/db-bootstrap/fixtures`, as the superuser). A developer starting the local stack had an empty database: no organisation, no user, no project. P6-05 created the last table the seed writes, so P6-05b adds `pnpm db:seed`: one command that fills the local dev database with a fixed, known dataset and can be run again at any time.

## Decision

### The command (I1, C1, E1; owner conditions 3 and 6)

`pnpm db:seed` is the root script `tsx --env-file=.env packages/db/seed/run.ts`. The root `package.json` is the dev entry point that loads `.env` (ADR 0039: nothing under `packages/` loads an env file). A missing `.env` stops Node before the seed runs, naming the file; the runbook says to copy `.env.example` first.

`@bricx/config/seed` (`loadSeedConfig()`) reads `NODE_ENV` and `DATABASE_URL` only, the app's own key, so there is no new config key (C1). It refuses:

- `NODE_ENV` unset, empty, or anything but `development` or `test`, and production by name (`seed_refused_in_production`);
- any host but `localhost`, `127.0.0.1` or `::1` (`seed_non_local_host`). The URL is judged as node-postgres will read it: pg copies every query parameter into its config, so every host the URL names (its own and each `?host=`) and every user (its own and each `?user=`) must pass. A unix socket path, an encoded socket host and an empty host (pg would fall back to `PGHOST`) are refused. A test checks the seed against pg's own parser (`seed-config-oracle.test.ts`): nothing it accepts lets pg reach anything but bricx_app on a local host;
- any user but `bricx_app` (`seed_role_not_bricx_app`, architect call 6).

Problems are keys and codes (`ConfigError`), never a value. At run time the first transaction also checks `current_user` is `bricx_app` and stops with `SeedRoleError` before writing anything (condition 3).

### Through withTx() only (D, requirement 2)

The seed opens the app pool (`openDatabase`, one connection) and does every read and write inside `withTx()`, as `bricx_app`, so FORCE RLS holds for every tenant row as it does for the API. There is no seed-only transaction helper and no `pg` import in `packages/db/seed/`; the dataset test scans the sources for a raw client, a pool, the relay or directory handles, the bootstrap fixtures and `.query(`.

Per organisation it runs three kinds of transaction: one for the organisation, its org region config, roles and role bundles; one per user (`app.provision_user()` needs the user as the transaction's user); one for the memberships, the project, its region config, sites, project members and site assignments, with the owner as the transaction's user (projects and sites must be `created_by` the current user) and the project in `app.project_ids`.

### Idempotent, never overwriting (H1; owner condition 1)

Each row is `INSERT … ON CONFLICT DO NOTHING` with no conflict target, so any unique key (the id, an organisation slug, a project code, an open-membership index) makes it a no-op. The row is then read back by id and compared column by column with the dataset: every column the seed writes, plus the columns it leaves NULL, which must still be NULL; a site's boundary is compared as GeoJSON. A row that is missing (another row holds one of its unique keys, or RLS hides it) or differs stops the run with `SeedDriftError`: `seed drift: <table> <id>`, never a value. The seed never updates or deletes. A user is read back first; only a missing one goes through `app.provision_user()`, and the id it returns must be the committed one.

On success the CLI prints one line, the same on every run: the dataset's row count per table and `no drift` (condition 5). Whether rows were inserted or already present is not printed; `runSeed()` returns both, and the integration suite proves the second run inserts nothing.

### Deterministic (F, G; requirement 3; owner condition 2)

Every seeded id is a UUIDv7 literal committed in `packages/db/seed/ids.ts`, keyed by a dataset name (`org/a`, `role_permission/b/auditor/…`). `seed/generate-ids.ts` writes that file: for each name, `@bricx/ids`' generator on the seed instant with its random bits taken from SHA-256 of the name, so each literal is reproducible from its name alone and independent of order. The dataset test re-derives every entry, so nobody edits one by hand.

Every timestamp (`created_at`, `updated_at`, `granted_at`, `last_seen_at`) comes from the injected `fixedClock` of `@bricx/domain/clock`, 2026-01-01T00:00:00Z (G); no column is left to a database default. The seed sources never read the real clock or a random source (scan test).

### The dataset (J1, K1; architect calls 1, 4, 5)

- Two organisations in two region cells (J1): A, "Sahel Builders Ltd (seed)", `af-south-1`, Sierra Leone, SLE, `en`, Africa/Freetown, reporting currency USD; B, "Atlas Constructions SAS (seed)", `eu-west-1`, France, EUR, `fr`, Europe/Paris, reporting currency GHS.
- In each: the twelve roles with the default bundles from `@bricx/permissions` (the rows `bootstrapOrganization()` writes), and one user per role with a membership holding it (K1): users = `ROLE_IDS` × 2. The role list and the bundles are read from `@bricx/permissions`; a role or key the committed ids do not cover fails the dataset test until `generate-ids.ts` is run (condition 4).
- One active project per organisation, created by its owner (architect call 1): A's in Lagos (NGN, reporting USD, Africa/Lagos, region-config language `en`), B's in Nairobi (KES, reporting EUR, Africa/Nairobi, region-config language `ar`). Each has two sites with small counter-clockwise boundaries, its nine project roles as project members, and the site engineer and the foreman assigned to site 1.
- The six currencies USD, EUR, SLE, NGN, KES and GHS and the languages en, fr and ar all appear. **The Nairobi project's `ar` is an RTL fixture**: it gives the client a right-to-left project to render; it says nothing about where Arabic is spoken.
- Users are database rows with fake subjects `seed-<org>-<role>`. There is no Keycloak account (phase plan D1; the P7-05 Also line covers a dev Keycloak seed), so nobody can sign in as them yet, and no directory row (phase plan D2): `pnpm db:seed` does not register the seed organisations in the global directory. Fake values only: no e-mail, password, token or secret (requirement 4, scan test).

### Region cells (J1; owner condition 6)

Both organisations live in the one dev database, tagged with different cells. The dev API's `CELL_ID` (`.env.example`) is `af-south-1`, and organisation B (`eu-west-1`) is still written: nothing in the database ties `data_region` to the serving cell (trigger `organizations_immutable` only refuses a change), and both values are cells that `db:migrate`'s directory step registers in dev (`DEV_CELLS`). The integration suite proves it. **J1 is a dev-only simplification and is not two-cell isolation evidence** (ruling R3): the two-API, two-cell Testcontainers isolation test is separate work (recommended for P6-06).

### No audit events (architect call 3; owner condition 6)

The seed writes no audit event and no outbox row. Seed rows are dev fixtures, not user actions; a hash-chained, append-only audit trail that a re-run would have to match row for row would make the seed non-idempotent. The E1 guard is what keeps this safe: the seed refuses production and any non-local database, so audit-free rows can only ever exist in a local dev or test database.

### tsx (I1, requirement 5, ADR 0023)

`tsx` 4.23.15 becomes an exact-pinned root devDependency: published 2026-09-20T07:22:17.792Z (49 days before 2026-11-08, so it passes the 7-day rule), integrity `sha512-Yiex1Ovn8z2xPpOWckIiysV1SSyRMY9BkLF++q0yKiDxCqRhosKfMg3janKkiLBwZ5c/YryloKwGZcrEmtwxKw==` (the registry's and the lockfile's), MIT, no install script. It was already in the lockfile at that version through `drizzle-kit`, with `esbuild` 0.28.2 (build scripts ignored) and optional `fsevents`, so no new package enters the tree. Node 24's own type stripping (which `db:rls` uses) cannot replace it: the workspace packages export `.ts` sources with extensionless imports.

`pg` (8.23.1) and `testcontainers` (12.2.0) stay at the versions on main, one version each (L1). `@bricx/db` gains workspace dependencies on `@bricx/config`, `@bricx/domain` and `@bricx/ids`, and a dev dependency on `@bricx/i18n` for the RTL check.

## Consequences

- `pnpm db:seed` gives a developer two organisations, 24 users, two projects and four sites on the local stack, and can be run again at any time; a drifted row is reported, not repaired. To start over: `pnpm dev:reset`, `pnpm dev:up`, `pnpm db:migrate`, `pnpm db:seed`.
- A change to the role bundles or to the dataset needs `seed/generate-ids.ts` to be run and the new `ids.ts` committed; the dataset test fails until then. A dev database seeded before such a change reports drift or gains the new rows; it never has rows changed.
- The P6 exit gate's "`pnpm db:seed` twice idempotent" is the integration suite's two runs plus the CLI's identical summary.
- Known limits: the seed users cannot sign in until a dev Keycloak seed exists (P7-05); the seed organisations are not in the global directory; J1 proves nothing about cell isolation.
