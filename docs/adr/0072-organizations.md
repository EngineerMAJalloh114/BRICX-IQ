# 0072. Organisations: creation through the directory, a signed-in route, create attempts and archive

- Status: Accepted
- Date: 2026-11-06
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP P6-02 (🔒, phase ruling R1); P6 phase plan approved 2026-11-06 16:46Z (D1–D10 as ★, rulings R1–R12); P6-02 task plan approved 2026-11-06 16:51Z (R6 confirmed, D11 and D13–D15 as ★, owner conditions C1–C4, D16 changed by C3); ADR 0020 (region cells), ADR 0057 (idempotency), ADR 0062 (token validation, users), ADR 0063 (sessions), ADR 0065 (revocation), ADR 0066 (roles, memberships, bootstrap), ADR 0068 (route markers), ADR 0071 (global directory), CLAUDE.md rules 4, 5 and 12

## Context

P5 built users, roles and memberships for an organisation id that nothing owned: `membership:bootstrap` seeded an empty organisation by id, and the P5-05 Also line left `memberships.org_id` and `roles.org_id` without a foreign key until this task. ADR 0071 gave the global directory a reservation, `registerOrganization()`, that P6-02 must call before the cell commits (C2), and left the release of an abandoned reservation to this task.

Two things in the P5 code shaped this task. The AuthGuard refused every route when the token had no `org_id` claim (`org_missing`), and that claim is a Keycloak attribute only an administrator writes: a person who has just signed up could call nothing, including the route that creates their organisation. And the generic `@Idempotent()` store keys rows by `org_id`, which a create does not have yet.

## Decision

### D1, D13. Who creates, and the cap

Any signed-in user may create an organisation through `POST /v1/organizations` and becomes its first owner. `ORGS_MAX_CREATED_PER_USER` (default 5, 1–1000) caps the user's create attempts that are `pending` or `committed`; an archived organisation still counts (rows are never deleted), a `refused` attempt (slug taken) does not. One more is 409 `request.conflict`. The cap is checked under a per-user advisory lock (`pg_advisory_xact_lock(0x4f524743, hashtext(user_id))`), so two parallel creates at the cap give one 201 and one 409.

### D2. Data region

`CELL_ID` is a required API key with the cell-id shape of ADR 0071 (`^[a-z]{2}(-[a-z]+)+-[0-9]+$`, at most 32 characters; `.env.example`: `af-south-1`). It is written to `organizations.data_region` at creation. The trigger `bricx.organizations_immutable` refuses any change of `id`, `slug`, `data_region` or `created_at`, for every role including `bricx_owner` and the superuser (SQLSTATE P6002).

### D3. The directory writer

`DIRECTORY_WRITER_DATABASE_URL` (optional, `directory_writer`, remote-only in production) opens the writer. Without it, the create route answers 503 `server_unavailable` and writes nothing; read, update and archive still work.

### D5, D7, D8, D9. Fields

- The slug (3–63 characters of `a-z`, `0-9`, `-`, not starting or ending with `-`, the directory's shape) is chosen at creation and immutable (D5).
- `brand_color` is `#rrggbb` in lower case, nullable; `logo_object_key` is a nullable column with no route here: the upload comes with the file pipeline (P8 Also line) (D7).
- Country (ISO 3166-1 alpha-2), default currency (ISO 4217 with a minor-unit exponent), default language (a supported locale) and timezone (a zone.tab name) are checked by `@bricx/validation`'s schemas; the CHECKs in migration 0009 hold their shapes. `units` is `metric` or `us_customary`; when absent it is the country's CLDR default from `@bricx/domain` `unitSystemFor` (D8).
- No e-mail domain is written and there is no domain route: the ADR 0071 C3 Also line is met by having no writer. Domains come in P6-06 (D9).

### D11 and C1. A route for a signed-in user with no organisation

- A route marker `@SignedIn()` (metadata `bricx:signed-in`, OpenAPI extension `x-bricx-signed-in`), checked with the other markers by `createApp` and pinned in the route list. Only `POST /v1/organizations` carries it. On such a route the AuthGuard verifies the token, provisions the user with no organisation, keeps `{ userId, acr }` for the handler (`signedInUser()`) and stops: no `org_id` claim or `X-Org-Id` header is read, and no grants, revocation key or session row is checked or written. The authorization guard lets it through. The handler's transactions run as that user through `TxRunner.runSignedIn(orgId, …)`.
- Revocation keys and sessions are organisation-scoped (ADR 0065, ADR 0063), so this route checks neither. **Accepted risk:** a user whose sessions were revoked in some organisation can still create an organisation until their access token expires: at most the realm's `accessTokenLifespan`, 5 minutes. Refresh is refused at once by Keycloak. They become the owner of a new, empty organisation and reach nothing of the one they were removed from.
- Every other route keeps the P5-02 contract (C1). A missing `org_id` claim takes the organisation from `X-Org-Id` (a lowercase UUIDv7); the membership check is unchanged, so the header never grants access by itself. A missing claim with no header, or a malformed claim with or without a header, is 403 `forbidden` (`org_missing`) and provisions nobody: no `users` row is written. The `org_id` attribute stays administrator-only. P7-05 Also: the client always sends `X-Org-Id`.

### D12 and C2. A stable organisation id (owner ruling R4)

The table `bricx.org_create_attempts` (a user table, not a tenant one) holds one row per user and Idempotency-Key: `user_id` (FK users), `key_hash` (SHA-256 of the key, 32 bytes), `request_hash` (the request fingerprint of ADR 0057, 32 bytes), `org_id` (UUIDv7, unique), `slug`, `state` (`pending`, `committed`, `refused`), `created_at`, `settled_at`. Primary key `(user_id, key_hash)`. FORCE RLS with the repository's own-row policies (`user_id = app.current_user_id()`, the `enableOwnedRls` pattern of ADR 0063); `bricx_app` has SELECT, INSERT and UPDATE of `state` and `settled_at` only, and the trigger `org_create_attempts_transition` allows only `pending → committed` and `pending → refused`, once (SQLSTATE P6003). Nobody deletes. Listed in `rls.int.test.ts`'s user tables; not synced.

The create:

0. The whole body is validated by the DTO before anything runs (C2), so the later steps cannot fail on input. Then: no writer, 503; no `Idempotency-Key`, 400 `idempotency.key_missing`; a malformed one, 400 `idempotency.key_invalid`; a reserved slug, 409 `organization.slug_unavailable`. Nothing is written by any of these.
1. **Tx A**, as the user: the advisory lock, then the attempt for `(user, key)`. Another body under the same key is 422 `idempotency.key_reused`. A `committed` attempt replays the organisation (201). A `refused` attempt replays the same 409. A `pending` attempt resumes with its `org_id`. A new key is checked against the cap and inserted `pending` with a new UUIDv7.
2. `registerOrganization({ orgId, slug, cellId: CELL_ID })`, before the cell commits (ADR 0071 C2, the recorded exception to CLAUDE.md rule 5). `slug_taken` settles the attempt `refused` in its own transaction and answers 409 `organization.slug_unavailable`. Any other failure (an unknown cell, the directory unreachable) is logged with the org id and a code only, answers 503 `server_unavailable` and leaves the attempt `pending`: the retry with the same key resumes it and gets `existing`.
3. **Tx B**, as the user in the new organisation: the attempt is locked (`FOR UPDATE`); if a parallel retry already committed it, the organisation is replayed. Otherwise `createOrganization()` (`@bricx/db/organizations`) inserts the row, runs the bootstrap (twelve roles, the first owner, one `users.mfa_check` outbox row, the audit event `org.member.bootstrap`), records `org.organization.create`, and the attempt is settled `committed`, all in one transaction.

The same key and body replay the stored outcome (C2): the organisation with 201 when committed, the same 409 when refused. Response bytes are not stored; the organisation is read again.

**Residual risks (C2):**
- A `pending` attempt counts toward the cap until it commits or an operator releases it, so a directory outage that strands attempts can use up a user's cap. The runbook lists pending attempts older than 24 hours (no automatic action).
- A client that sends a new key on each retry during a directory outage creates a new pending attempt, and a new reservation once the directory answers, each time, and burns attempts. Clients keep one key per user action (P7-05 Also).

### D14. Slugs that are not available (R5)

`@bricx/validation/reserved-slugs` (client-safe, so the client can check before sending) holds `ORGANIZATION_SLUG_PATTERN` and 65 reserved names (infrastructure, product and role words such as `www`, `api`, `admin`, `auth`, `bricx`, `directory`, `keycloak`, `postmaster`, `staging`). A reserved slug and a slug another organisation holds both answer 409 with one new envelope code, `organization.slug_unavailable` (en/fr/ar), and the same body, so the answer does not say which. No attempt or directory row is written for a reserved slug.

### D15. Dev cells (R2)

`pnpm db:migrate` runs `ensureDevCells()` (`@bricx/db/dev-cells`) after the directory journal, as `directory_owner`: it inserts the two launch cells, both pointing at the local stack (`http://localhost:4000`, `http://localhost:8080/realms/bricx`; architect-reviewed 2026-11-06), in one transaction with `ON CONFLICT DO NOTHING`. A cell row with other URLs stops the run (exit 1) with `cell_drift` and the cell id only, never a URL, and is not overwritten. It runs only for `NODE_ENV=development` and a directory URL whose host is local (`localhost`, `127.0.0.1`, `::1`); otherwise the step prints `skipped`. Any role but `directory_owner` is refused before anything is written.

### D6, D16 and C3. Archive, not delete

- `POST /v1/organizations/current/archive` needs a new catalogue key, `org.organization.archive`, held at org scope by the Owner bundle only (C3; generated files and the drift test updated). Archive does not use `org.organization.update`.
- Archive sets `archived_at` once and records `org.organization.archive`. A second archive is 404 like every other route of an archived organisation (the task plan's "archive twice is still 200" changed with D16's 404 rule). The trigger refuses moving `archived_at` for every role, and clearing it for every role but `bricx_owner`.
- After archive, the AuthGuard answers 404 `not_found` (guard reason `org_archived`) on every route of that organisation, before any revocation check or session row, through `Access.orgArchived` from `DbGrantsSource`. Only a route marked `@AllowArchivedOrg()` (`x-bricx-allow-archived-org`) runs: `GET /v1/organizations/current`. The slug stays reserved in the directory.
- Restore is a runbook step as `bricx_owner` in the organisation's context (`docs/runbooks/migrations.md`); there is no API route (architect-reviewed 2026-11-06: a restore writes no audit event in the organisation's chain; the operator records the ticket until an operator console exists).
- **MFA for archive (C3).** The catalogue's `requiresMfa` is a key-prefix rule (`finance.` only, `@bricx/permissions/mfa`), so requiring `acr` `mfa` for this one key needs new infrastructure (a per-key flag read by the authorization guard, the worker's `app.mfa_state()` and the drift test). Not built here: a P13-01 Also line adds it before production.

### D17 and C4. The P5-05 foreign keys

Migration 0009 adds `memberships.org_id → organizations(id)` and `roles.org_id → organizations(id)`. A database with membership or role rows for an organisation that has no row (a `membership:bootstrap` run before this migration) fails the migration: the fix is `pnpm dev:reset`. No production database exists yet, so no production data is affected (CLAUDE.md rule 12: forward-only holds; this is a local-only reset). `membership:bootstrap` now requires an existing organisation and refuses a missing one (`org_missing`); `bootstrapOrganization()` moved to `@bricx/db/organizations` (phase ruling PD-2).

Test fixtures gain the organisation row through one shared helper, `seedOrganization` / `seedOrganizations` in `@bricx/db-bootstrap/fixtures` (C4). Only fixtures changed; the P5 suites' assertions did not (the PR lists the files).

### D4 and R6. Releasing an abandoned reservation

No automatic release. A reservation whose organisation never committed stays until an operator releases it as `directory_owner`, after checking that the cell has no such organisation and that no attempt is still pending for it, and accepting that the directory's 200 answers are cached for up to a day (ADR 0071 D5). The existing `owner_all` policy lets `directory_owner` delete; the foreign key from `org_email_domains` keeps a reservation that has a domain (23503). No directory migration was needed, so P6-06's directory migration is 0001 (R6 confirmed).

## Consequences

- A new user can create an organisation with only a signed-in token, and use it at once through `X-Org-Id`, with no Keycloak write.
- The organisation id is stable across retries, so the directory and the cell never disagree about it; a stranded attempt is visible to an operator and costs the user one slot of the cap.
- Every route gains one indexed read of `organizations.archived_at` in `DbGrantsSource`.
- The P5-02 test pins that change: the guard's own reasons gain `org_archived`; the route list gains the `signed_in` kind and the four organisation routes; the `X-Device-Id` loop skips the signed-in route (it registers no session).
- PATCH /v1/organizations/current with an empty body (or none) returns 422 and writes nothing: done in P6-03 (ADR 0073, owner condition C1).

## Alternatives rejected

- The worker writes the Keycloak `org_id` attribute through an outbox job after create: an administrator write per organisation, and the user still needs a new token before using it.
- The generic `@Idempotent()` store for create: it is keyed by organisation, which a create does not have.
- A reserved slug as 422 `validation_failed`: it would tell a caller which names are reserved and which are taken.
- A directory migration with a narrower `directory_owner` DELETE policy: the existing policy and foreign key already give the runbook what it needs.
- Requiring MFA for archive now: needs a per-key MFA flag across the API, the worker and the database (P13-01 Also).
