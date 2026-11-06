# 0071. Global directory service: launch cells, a separate directory database and a public resolve route

- Status: Accepted
- Date: 2026-11-06
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP P6-01 (🌍); P6-01 task plan approved 2026-11-06 with D1 confirmed by the owner, D2–D8 as proposed and owner conditions C1–C7; ADR 0020 (region cells), ADR 0035 (bootstrap roles), ADR 0052 (migrator), ADR 0062 (`@Public()`), CLAUDE.md rules 4 and 5

## Context

ADR 0020 puts every organisation in one region cell (a full stack per residency region) and gives a thin global directory service the job of routing an organisation to its cell. An organisation's data region is fixed at creation. Before signing in, a client knows only what the person types (an email address or an organisation's short name), so it must ask the directory which cell's API and Keycloak to use. The launch regions were an open business decision in `pending.md`, needed by this task.

## Decision

### D1. Launch cells

The launch cells are `af-south-1` (Cape Town) and `eu-west-1`, as STACK.md C20 names them (owner confirmed 2026-11-06). The `pending.md` row is struck through and points here. A cell id has the AWS region shape (`^[a-z]{2}(-[a-z]+)+-[0-9]+$`, a `CHECK` on `directory.cells.id`). Adding a cell later is one `directory.cells` row written by `directory_owner` (runbook `docs/runbooks/migrations.md`, "The global directory"), not a migration.

### D2 and C1. A separate `bricx_directory` database with three roles

The directory has its own database, `bricx_directory`, never the cell database. In production it is one global instance. In development it lives in the same Postgres container, created by `infrastructure/docker/postgres/init/02-directory.sh`. Three roles, all `NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS`, with `search_path = directory, pg_temp`:

| Role | May | Used by |
|------|-----|---------|
| `directory_owner` | owns schemas `directory` and `directory_migrations`, runs migrations | `pnpm db:migrate` (`DIRECTORY_MIGRATION_DATABASE_URL`) |
| `directory_reader` | `SELECT` on `cells`, `org_directory`, `org_email_domains`, nothing else | the public resolve route and the global deployment (`DIRECTORY_DATABASE_URL`) |
| `directory_writer` | `INSERT` on `org_directory`, plus `SELECT` on `org_directory` for the conflict check; nothing on `org_email_domains` or `cells` | `registerOrganization()` only (P6-02) |

`CONNECT` is revoked from `PUBLIC` on both databases. Only the three directory roles may connect to `bricx_directory`. No cell role (`bricx_owner`, `bricx_app`, `bricx_readonly`, `bricx_relay`, `powersync_repl`, `powersync_storage_owner`) may connect to it, and no directory role may connect to the cell database or `powersync_storage`. `@bricx/db-bootstrap` proves this with real connection attempts. There are no default privileges in schema `directory`: each grant is written in the migration, so a new table is unreadable until a migration grants it. Every table has `ENABLE` and `FORCE ROW LEVEL SECURITY` with one policy per role and command, so a privilege granted by mistake still returns no rows. The directory migrator refuses a table without both. No function is executable by `PUBLIC` (default privileges of `directory_owner`), and the directory schema has no `SECURITY DEFINER` function.

The application never connects as `directory_owner`. Each runtime handle checks `current_user` at the start of every transaction and refuses any other role (`DirectoryRoleError`). The reader's transactions are `READ ONLY`. This is a documented exception to CLAUDE.md rule 4 (`withTx()`), like the relay's (ADR 0056): the directory is global, so it has no `app.org_id`. The handles live in `packages/db` (ADR 0040) and the pool is never exported.

### D4. Tables (architect-reviewed 2026-11-06)

Migration `packages/db/directory-migrations/0000_directory.sql`, its own journal. Hand-written SQL, with no Drizzle snapshot because the directory has no Drizzle schema. Forward-only and immutable once merged, like the cell migrations: `check:workspace` and `migrations-immutable` cover both folders. History goes in `directory_migrations.applied`.

- `directory.cells (id text PK, api_base_url text, keycloak_url text, created_at)`: one row per cell. URLs are origins (API) or an issuer URL (Keycloak, path allowed), `http` or `https` with no credentials, query or fragment (`CHECK`). Rows are deployment data written by `directory_owner`, not migration data.
- `directory.org_directory (org_id uuid PK, org_slug text UNIQUE, cell_id text FK cells, created_at)`: the reservation. The slug is 3–63 characters of `a-z`, `0-9` and `-`, not starting or ending with `-` (`CHECK`). A trigger refuses any `UPDATE` of `org_id` or `cell_id`, for every role including `directory_owner`, because an organisation's region is immutable (ADR 0020). No role but `directory_owner` may `UPDATE` or `DELETE`.
- `directory.org_email_domains (domain text PK, org_id uuid FK org_directory, verified_at timestamptz NOT NULL, created_at)`: see C3.

The directory keeps no audit chain. An organisation's creation is audited in its own cell's chain (P6-02). Directory rows hold no personal data (ids, slugs, cell ids, domain names).

### D7 and C2. `registerOrganization()` is a reservation, called before the cell commits

`registerOrganization(writer, { orgId, slug, cellId })` in `@bricx/db/directory` inserts the `org_directory` row with `ON CONFLICT DO NOTHING` and then reads what holds the org id or the slug:

- no row before: `reserved`;
- the same `(org_id, slug, cell)` already there: `existing` (idempotent);
- the slug belongs to another organisation: `DirectoryRegistrationError` `slug_taken`;
- the org id is registered with another slug or cell: `DirectoryRegistrationError` `org_registered_differently`;
- an unknown cell: `DirectoryRegistrationError` `unknown_cell`.

Errors carry the code only, never a value.

**P6-02 calls it synchronously, before the cell transaction that creates the organisation commits.** An outbox job (CLAUDE.md rule 5) cannot do this. Slugs are unique across every cell, so the only authority is the global directory, and the cell must know the slug is free before it commits the organisation. A job that ran after the commit would find a taken slug only after the organisation already exists in its cell, with no way to undo it. This is a **recorded exception to CLAUDE.md rule 5**, limited to this one call: a synchronous, idempotent reservation in another database, made before the local commit.

On failure:
- If the reservation fails, the cell transaction does not start (or rolls back), and nothing is created.
- If the reservation succeeds and the cell transaction then fails, a retry with the **same `org_id`** gets `existing` and reuses the reservation.
- Whether and how an abandoned reservation is released (a different `org_id` would get `slug_taken` until then) is decided in P6-02. P6-01 ships no release and no delete.

### C3. No unverified domain routes

`org_email_domains.verified_at` is `NOT NULL`, so a domain row exists only once it is verified. P6-01 ships no function that writes a domain, and `directory_writer` has no `INSERT` on `org_email_domains`. The tests seed domain rows as `directory_owner`. Before any domain row is written, P6-02 and P6-06 add DNS TXT verification and a denylist of free-mail domains (ROADMAP Also lines). Domains are stored lower-case ASCII (punycode for internationalised names), with at least two labels and at most 253 characters (`CHECK`).

### D3 and C4. The directory module stands alone; how the global instance boots

`apps/api/src/modules/directory` imports nothing from the cell database, `withTx()`, the request context or user provisioning. It imports only `@nestjs/common`, `nestjs-zod`, `zod`, `@bricx/db/directory`, `@Public()`, `ApiError` and its own files, and a test pins that import list. The query is parsed by the app's global Zod pipe, so the module does not import the pipe. `DirectoryModule.forRoot({ reader })` takes a `directory_reader` handle and closes it on shutdown, and a test builds its DI graph from `@bricx/config/directory` with only the directory environment set (`NODE_ENV`, `LOG_LEVEL`, `DIRECTORY_DATABASE_URL`). `@bricx/config/directory` reads those three keys and nothing else. The API reads `DIRECTORY_DATABASE_URL` as an optional key, and the worker never reads it.

In P6-01 the module is registered by `createApp` only when `DIRECTORY_DATABASE_URL` is set. A cell deployment leaves it unset, so a cell API has no directory route. `createApp` still needs the cell's configuration (database, Valkey, S3, Keycloak), so until P13-01 a global directory instance would run the API image with a full configuration plus `DIRECTORY_DATABASE_URL`. A **directory-only entry point** (an entry that boots `DirectoryModule` alone, as `directory_reader`, with no cell database, Valkey or Keycloak) is a P13-01 Also line and is not built now.

### D5 and C5. `GET /v1/directory/resolve`

- `@Public()`, added deliberately to the pinned route list in `apps/api/test/can-guard.test.ts` and the public list in `auth-routes.test.ts`.
- Exactly one of `org_slug` or `email_domain`, or 422 `validation_failed`. Input is bounded (slug at most 63, domain at most 253 characters) before any query. It is normalised: lower-case, and one trailing dot stripped from a domain.
- 200 `{ cell, apiBaseUrl, keycloakUrl }`. Never the organisation's id or name. `Cache-Control: public, max-age=86400`, because the cell is immutable (for architect review: one day, so a released slug from P6-02 stops being served within a day).
- Unknown: 404 `directory.not_found` (a new envelope code, 404, with `errors:directory.not_found` in en, fr and ar; the fr and ar text is machine-drafted, like the rest), with the identical body for both keys (apart from the correlation id) and `Cache-Control: public, max-age=60`.
- The handler sets `Cache-Control` once it has the answer. Nest's `@Header()` is not used, because it would also stamp a 422 or a 503 with the one-day header. A 422 or a 503 carries no public cache header (tested).
- **An organisation slug's existence is discoverable by design.** The route exists to say which cell serves a slug, so it answers 200 for a slug that exists and 404 for one that does not. The mitigation for enumeration is the edge WAF rate limit (a P13 Also line). No rate limiter is installed in P6-01: `@nestjs/throttler` has a DEPENDENCIES.md row but is not installed. A verified domain is discoverable the same way.

### D6 and C6. The client resolver

`resolveCell({ email } | { slug }, options)` lives in `packages/api-client/src/directory.ts`, outside the generated output directory (`src/generated/`, which orval cleans), and a test runs orval and proves the file is left intact. It takes the domain from the email address, calls the directory URL (`EXPO_PUBLIC_DIRECTORY_URL` in `@bricx/config/client-public`) with an injected `fetch`, re-parses the answer with a strict Zod schema (exactly `cell`, `apiBaseUrl`, `keycloakUrl`), refuses non-`https` URLs (the directory's and the cell's) when `production` is set, and never falls back to a default cell: an unknown organisation is `CellNotFoundError`. A malformed lookup, a bad directory URL or a malformed answer is `DirectoryClientError` (`invalid_lookup`, `insecure_url`, `invalid_response`); any other non-2xx answer is the fetcher's `ApiProblem`. Only the email's domain is sent, never the address, and errors carry no value. The client's config gains `EXPO_PUBLIC_DIRECTORY_URL` (the dev API's URL in `.env.example`, since the dev API also serves the directory). P7-05 wires it into the login flow (ROADMAP Also line).

### C7. Development stack

`.env.example` gains `DIRECTORY_OWNER_PASSWORD`, `DIRECTORY_READER_PASSWORD`, `DIRECTORY_WRITER_PASSWORD` (dev-only placeholders), plus `DIRECTORY_DATABASE_URL` and `DIRECTORY_MIGRATION_DATABASE_URL`. `tooling/db-bootstrap` lists the three roles in `rolePasswordKeys`. `pnpm dev:up` stops with a `pnpm dev:reset` instruction when the volume lacks the directory roles or database, because init scripts run only on an empty volume. `pnpm db:migrate` migrates the cell database and then, when `DIRECTORY_MIGRATION_DATABASE_URL` is set, the directory.

## Consequences

Positive:
- Data residency holds: the directory stores routing data only, and tenant data never leaves its cell.
- Each credential can do one thing: the public route can only read, and registration can only add a reservation.
- An organisation's cell cannot be changed by any role, the owner included.

Negative:
- A cell's org creation depends on the global directory being up (accepted in ADR 0020; P6-02 decides the user-facing failure).
- Slug existence and verified domains are publicly discoverable; only the edge rate limit slows enumeration. (architect-reviewed 2026-11-06)
- Abandoned reservations hold a slug until P6-02 decides release.
- One more database, three more credentials, and a second migration folder to keep immutable.
- Existing local volumes need `pnpm dev:reset`.

## Alternatives rejected

- **Directory tables in the cell database** (a schema): breaks "a thin global service" and would put routing data for every cell into one cell.
- **Two roles (owner + one app role)** (the plan's D2 before C1): the public route's credential could then write.
- **An outbox job for registration**: cannot give the cell a global uniqueness answer before it commits (C2).
- **A domain write function now**: a domain could route before verification exists (C3).
- **A new `apps/directory`**: a layout change. The standalone module plus a later entry point (P13-01) gives the same separation.
- **`@nestjs/throttler` now**: a per-instance limiter does not stop distributed enumeration. The edge WAF does (P13).
