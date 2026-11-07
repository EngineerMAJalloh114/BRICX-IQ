# 0073. Region configuration: layered org and project settings, provenance, and the org's session idle limit

- Status: Accepted
- Date: 2026-11-07
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP P6-03; P6 phase plan approved 2026-11-06 16:46Z (P6-03 D1–D7 as ★, rulings R1–R12); P6-03 task plan approved 2026-11-07 12:26Z (D8–D14 as ★, owner conditions C1–C4); P5 phase ruling D6 and P5-01 condition 7 (ADR 0060, ADR 0063); ADR 0048 (permissions), ADR 0054 (RLS), ADR 0055 (audit), ADR 0072 (organisations), CLAUDE.md rules 3, 4, 7, 8 and 12

## Context

An organisation's currency, language, timezone and units are columns of `bricx.organizations` since P6-02 (ADR 0072 D8). The rest of what makes a construction business regional (a reporting currency, how dates and numbers are written, a tax profile, the payment and accounting adapters, a rate library) had nowhere to live, and none of it could differ per project. P5 left one more value waiting here: an organisation's session idle limit, which may only shorten the Keycloak realm's 12 h (`ssoSessionIdleTimeout`). P5-03 built the `OrgSessionPolicy` port and bound it to the realm value until this task stored the org's.

## Decision

### D1. One typed row per layer

`bricx.region_configs` holds one row per layer: the org row (`project_id` NULL) and one row per project. Each field is its own nullable, typed column with a CHECK; NULL means "inherit". The constraint `region_configs_layer` is `UNIQUE NULLS NOT DISTINCT (org_id, project_id)`, so there is one org row and one row per project, and the same index serves every read. Key/value rows were rejected: no typed CHECKs and free-form keys.

### D2, D8, D9. Three layers, each later one winning, with provenance

`resolveRegionConfig()` in `@bricx/domain/region-config` (pure, client-safe) resolves `system → org → project`, and every field of the result carries its value and the layer that set it (`system`, `org` or `project`).

- **org**: currency, language, timezone and units come from the organisation's own columns, and only from them (D8). The org row cannot hold them: the DTO refuses them and the CHECK `region_configs_org_columns` is the backstop. The other fields come from the org row.
- **project**: the project's row, for every field except the idle limit (D10).
- **system**: what is left, derived, with no per-country table (D9). The reporting currency is the effective currency. The format locale is the effective language plus the organisation's country (`en-SL`). There is no tax profile, accounting adapter or rate library, the payment list is empty, and the idle limit is the realm's.

Since the four organisation columns are NOT NULL, the system layer never sets them.

### D3. Date and number format

The stored value is a BCP 47 formatting locale (for example `en-GB`), canonicalised by `@bricx/validation`'s `LanguageTagSchema` and rendered with `Intl` on the client. No pattern strings are stored (CLAUDE.md rule 8).

### D4, D12. Adapter fields before P6-04

`accounting_adapter` and each entry of `payment_adapters` are adapter ids matching `^[a-z][a-z0-9_]{1,62}$`. The payment list holds 0 to 16 unique ids and is stored sorted. `tax_profile_id` and `rate_library` are opaque references matching `^[a-z0-9][a-z0-9_.-]{0,63}$` until P21 and P15 (architect-reviewed 2026-11-07). P6-04 checks the ids against its registry (Also line).

### D5, C4. Permissions

A new catalogue resource `org.region_config` has `read` and `update`, both at org scope only. Every default role reads it. Only the owner updates it, because there is no admin role. Every route checks these org-scope keys, the project routes included. A project role that holds `project.project.update` on a project still cannot change that project's region configuration (owner condition C4). The generated files and role bundles were regenerated.

Existing organisations keep their stored `role_permissions`: the owner bundle is virtual and gets `update` at once, while the eleven other roles get `read` only in organisations created from now on. There is no production data. Locally, run `pnpm dev:reset`.

### D6, C2. The session idle limit

`session_idle_seconds` lives on the org row only (project rows cannot hold it, `region_configs_project_idle`). It must be an integer from 60 to 43 200. Both bounds are checked by the DTO (422) and by the CHECK `region_configs_session_idle_seconds`. NULL means the realm's limit.

- **Maximum, 43 200 s (12 h):** this is the realm's `ssoSessionIdleTimeout`. An organisation may only shorten it (P5 phase ruling D6). It is one named constant, `SESSION_IDLE_SECONDS.max` in `@bricx/domain/limits`. `REALM_IDLE_SECONDS` in `apps/api/src/common/auth/session-policy.ts` is that constant, and `test/session-policy.test.ts` still pins it to `realm-bricx.json`.
- **Minimum, 60 s:** below one minute, an ordinary pause between two requests of an active user would end the session.

This value overrides the P5-03 mechanism it was built for: the `OrgSessionPolicy` port with `clampIdleSeconds()`. The production binding was `realmSessionPolicy`, which gave every org 12 h, and is now `DbOrgSessionPolicy`.

- `DbOrgSessionPolicy` reads the org row's value on every tracked request, in its own `withTx()` as the request's user in that organisation. It uses no cache, so a change applies on the next request (D13).
- `clampIdleSeconds()` still caps the value at the realm's and falls back to the realm's for anything that is not a positive integer.
- The guard answers 401 `session_expired` once a session has been idle longer than the org's limit.

`session_idle_seconds` alone is read by an indexed single-row lookup. The effective configuration reads the organisation's columns, its org row and the project's row together in one query on `region_configs_layer` (C2).

### D6 (consequence). last_seen_at moves often enough for a short limit

The tracker writes `last_seen_at` at most once per `USERS_LAST_SEEN_THROTTLE_SECONDS`, which defaults to 300 s. With an org limit shorter than that, a user making a request every minute would have been idled out after one limit, because their activity was never recorded.

`touchSeconds()` now writes it once per throttle, but at least once per tenth of the org's limit. A session therefore idles after between 90 % and 100 % of the limit with no requests (architect-reviewed 2026-11-07). The realm's 12 h is unchanged: a tenth of it is above the default throttle.

### D10. Project rows before P6-05

`project_id` is a bare UUID with no foreign key, as `project_memberships.project_id` was in P5-05. A row for a project that does not exist yet is accepted. P6-05 adds the foreign key (Also line).

### D11, C1, C3. Routes, writes and audit

- `GET /v1/region-config/effective?projectId=` returns the effective configuration, each field with its source. An unknown or foreign project has no row, so the result is the organisation's values.
- `GET` and `PATCH /v1/region-config` act on the org row.
- `GET` and `PATCH /v1/region-config/projects/{projectId}` act on a project's row.
- A layer with no row reads as all fields null and no timestamps.

PATCH rules:

- An empty body, or no body, is 422 `validation_failed` and writes nothing (C1).
- A field set to null goes back to inheriting.
- A body whose values equal the stored ones answers 200 with the row as it is. Nothing is written (`updated_at` does not move) and no audit event is recorded (C1).
- A real change upserts the row and records one audit event, `org.region_config.update` for the org row or `org.region_config.project_update` for a project row. Its `after` is `{ "fields": [...] }`, the changed field names, never their values (C1).
- A field a layer may not hold is an unknown field: 422 before any transaction (C3).
- A CHECK violation that reaches the database anyway (23514, the backstop) is turned into 422 `validation_failed` by the service, never a 500 (C3).

`PATCH /v1/organizations/current` already answered an empty body with 422 since P6-02. P6-03 pins that it writes nothing and adds the no-body case (C1). The queued chore in ADR 0072 is done.

### D14. Not synced

`org.region_config` is `synced: false`. `bricx.region_configs` is in no publication, and a P8-02 Also line adds its stream and leak test.

## Consequences

- Clients get one read that says what applies and why. A project changes only what differs from its organisation.
- Every tracked request makes one more indexed read, the org's idle limit, in a short transaction of its own.
- With an org limit below 3 000 s, `last_seen_at` is written more often than the throttle, at most once every `limit / 10` seconds per session.
- Rows are never deleted: no DELETE policy under FORCE. A layer is reset by setting its fields to null.
- `bricx_app` may update only the field columns and `updated_at`. `id`, `org_id`, `project_id` and `created_at` are fixed by the column grant. There is no trigger, so `bricx_owner` is not bound (architect-reviewed 2026-11-07).
- Also lines:
  - P6-04: unknown adapter ids are refused on write with 422, and stored values are still returned on read.
  - P6-05: the `project_id` foreign key, whose migration fails loudly on orphan rows.
  - P8-02: the stream and the leak test.
  - P13-01: a role-bundle sync for existing organisations before the first production organisation, because new catalogue keys do not reach stored `role_permissions`.
  - Queued chore: fold the idle-limit read into the session tracker's transaction.
  - Queued chore: raise `packages/db` coverage above the 70.82 % margin.

## Alternatives rejected

- Key/value rows per setting: no typed CHECKs and free-form keys.
- Letting the org row override the organisation's four columns: two sources for one value.
- Per-country default tables in `@bricx/domain`: new data with a new source pin, for values every organisation already sets at creation.
- Reusing `org.organization.update` for writes: one key would cover both the legal identity and the regional settings.
- A 60 s in-process cache of the idle limit: a shortened limit would apply up to a minute late.
- Swapping P6-03 and P6-04 so that adapter ids are checked at once: a change to the approved order.
