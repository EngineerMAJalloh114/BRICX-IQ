# 0066. Grants, roles and project overrides

- Status: Accepted
- Date: 2026-10-22
- Deciders: Mohamed Abass Jalloh
- Source: P5-05 (task plan approved 2026-10-21 at 22:32Z with decisions D-A to D-I as proposed, D-B tightened by condition 2, and owner conditions 1–8); P5 phase rulings D5 (`bricx-mfa` through the outbox) and D7 (the request's organisation from memberships); ADR 0048 (the catalogue and CASL), ADR 0054 (RLS), ADR 0055 (audit), ADR 0056 (the outbox and its relay), ADR 0060 (the `bricx` realm), ADR 0062 (the `GrantsSource` port), ADR 0063 (devices and sessions), ADR 0064 (`@keycloak/keycloak-admin-client`), ADR 0065 (revocation).

## Context

Until P5-05 the production `GrantsSource` was `noGrants`: every authenticated request was denied by the ability, the request's organisation was the token's `org_id` claim, and the realm role `bricx-mfa` (the OTP flag of ADR 0060) was set by nobody. P5-05 brings the four tables the ROADMAP names (`roles`, `role_permissions`, `memberships`, `project_memberships`), the API that edits bundles and memberships, the production grants source, the organisation choice from memberships, and the Keycloak mapping. Everything here is 🔒: it is the authorisation data of the platform, and a mistake is a cross-org leak or a silent escalation.

## Decision

### The tables (D-C, D-D; owner condition 4)

Migration `0006_grants_roles`, forward-only:

- `bricx.roles` (`id`, `org_id`, `key` ≤ 64 `[a-z][a-z0-9_]*`, `name`, `system_key` nullable, `created_at`, `updated_at`, `archived_at`; unique `(org_id, key)`), catalogue resource `org.role` (actions `read`, `manage`, org scope; `owner` manages, `auditor` reads).
- `bricx.role_permissions` (`id`, `org_id`, `role_id`, `permission`, `granted_at`, `revoked_at`): one row per key per grant; a dropped key is `revoked_at`, never deleted, so the bundle's history stays (D-C ★; the alternative `permissions text[]` on `roles` loses it). Same resource `org.role`.
- `bricx.memberships` (`id`, `org_id`, `user_id → users`, `role_id`, `created_at`, `removed_at`; one open row per user and org), resource `org.member` (`read`, `invite`, `update`, `remove`, org scope).
- `bricx.project_memberships` (`id`, `org_id`, `project_id`, `user_id`, `role_id`, `overrides jsonb {add, remove}`, `created_at`, `removed_at`; one open row per user and project), resource `project.member` (`read`, `assign`; org or project scope). `project_id` is a bare UUID until P6-05 creates `projects` (D-D ★: an FK then; ROADMAP Also line). Site entries wait for P6-05's site assignment.

All four are on `TENANT_TABLES` with FORCE RLS and the generated policies; `memberships` and `project_memberships` also carry own-row SELECT policies (`OWN_ROW_TABLES`, `user_id = app.current_user_id()`, no UPDATE) so the guard and `GET /v1/me/memberships` read a user's rows in every organisation. Nothing is synced. The RLS coverage test, the FK seeding and the migrator guard cover them.

### `app.mfa_state()` and the owner read policies (owner conditions 1 and 4)

`app.mfa_state(p_user uuid) RETURNS TABLE (keycloak_sub text, required boolean)`: SECURITY DEFINER, owned by `bricx_owner`, `search_path = pg_catalog, pg_temp`, STABLE. `required` is true when any open org or project membership of the user, in any organisation, holds a `finance.*` key: a role with `system_key = 'owner'` (the code's `ROLES.owner` bundle, which holds finance keys and takes no overrides), else the role's open `role_permissions` plus `overrides.add` minus `overrides.remove`. EXECUTE is revoked from PUBLIC and from `bricx_app` and granted to `bricx_relay` only (condition 1; `bricx_relay` gets USAGE on schema `app` for this one function and no grant on the four tables). The API computes `mfaRequired` for its responses from its own org-scoped reads with the pure `requiresMfa()` helper and never calls the function; `grants.int.test.ts` proves `bricx_app` is refused (42501) and gets no benefit from the owner policies.

Because FORCE RLS binds `bricx_owner` too, the definer function reads the four tables through four owner-side SELECT policies (`USING (true)`, TO `bricx_owner`), listed by name in the migration, in `OWNER_READ_TABLES` and here: `roles_owner_select`, `role_permissions_owner_select`, `memberships_owner_select`, `project_memberships_owner_select`. The migrator guard (`guardProblem()`, code `owner_policy_unlisted`, amends ADR 0054) refuses any `bricx_owner` or PUBLIC policy whose expression is `true` on a table and command not in `OWNER_POLICY_TABLES` (`users` SELECT/INSERT/UPDATE from ADR 0062; the four tables SELECT only).

### Pure helpers in `@bricx/permissions` (c2)

`effectiveKeys(bundle, overrides)`, `validateOverrides(bundle, overrides, options)` (problems `too_many_keys` at `MAX_OVERRIDE_KEYS` 50, `unknown_key`, `duplicate_key`, `add_scope` for a key that is not project- or site-scoped, `add_in_bundle`, `remove_not_in_bundle`, `key_in_both`, `bundle_immutable` for the owner role) and `requiresMfa(keys)` (`MFA_KEY_PREFIX` `finance.`). Client-safe, 95 % covered, no `Date`.

### The production grants source and the organisation (D-A ★, D-B tightened by condition 2, phase ruling D7)

`DbGrantsSource` (`apps/api/src/common/auth/grants-source.ts`) replaces `noGrants`: one `withTx()` as the request's organisation and user, reading through the own-row policies the user's open org membership and its role, the open project memberships there (newest first, at most `MAX_PROJECT_MEMBERSHIPS` 100) and their roles, and the open `role_permissions` of those roles. `buildAccess()` turns rows into grants: the org membership's org and own keys as they are (project and site keys dropped: an org role names no project); each project membership's `effectiveKeys(bundle, overrides)`, project keys as one grant per permission over the projects it is held on, own keys kept, org keys dropped; a role with `system_key = 'owner'` is `ROLES.owner` from code; an archived role grants nothing while its memberships stand; a key the catalogue no longer knows is dropped, counted and logged once (`grants.unknown_permission`). The template module's tests pass on seeded rows (no `fixedAccess`), and `pnpm new-module`'s self-test is green.

The request's organisation is `X-Org-Id` when present (a lowercase UUIDv7, else 403 `forbidden`, reason `org_invalid`), else the `org_id` claim (a lowercase UUIDv7, else 403 reason `org_missing`); a user with no open membership there is 403 reason `membership_missing`, checked after provisioning and before the revocation keys, the session row and anything else is written (so a removed member's next request in that organisation is refused at once and no session row is created for a non-member). The claim is a default, never authorisation (amends ADR 0062 and ADR 0060 section 3b). `GET /v1/me/memberships` (no grant needed) lists the caller's open org memberships in every organisation with their project ids, so a client can offer the choice.

The wildcard (condition 2, amends ADR 0054): `app.project_ids = '*'` means every project of the organisation and is what `app.has_project()` honours. Only `withTx()`'s typed `allProjects: true` option sets it; `'*'` inside `projectIds` is refused (`InvalidTxContextError`), and a claim or a header can never produce it. `DbGrantsSource` alone computes it, when an org-scoped grant names a project- or site-level resource (what org scope already means in CASL); a project-scope-only identity never gets it. With `'*'` the project-level RLS backstop is reduced to the organisation: the API's ability check is the only project filter for that identity. Tests: `tx.test.ts`, `grants-source.test.ts`, `grants-source.int.test.ts`, `request-context.test.ts`.

### Roles (D-E ★ c, condition 3 for the memberships below)

`GET /v1/roles`, `GET /v1/roles/:id` (`org.role.read.org`), `POST /v1/roles`, `PATCH /v1/roles/:id`, `POST /v1/roles/:id/archive` (`org.role.manage.org`, which only `owner` holds). The owner role is virtual: `system_key = 'owner'`, bundle `ROLES.owner` from code, no `role_permissions` rows, 409 for any change. The eleven other system roles are copied at bootstrap into `role_permissions` rows and are editable like custom roles (D-E ★ c). A change grants only keys the editor holds at org scope (`holdsAll()` over the editor's ability; a refused key is 403 with one `grants.escalation` line naming it). An edit revokes the dropped keys and inserts the added ones, and, when the `finance.*` keys moved, enqueues one `users.mfa_check` row per open member of the role (at most `MAX_MFA_FANOUT` 1000, else 409, for architect review; P14-06 reconcile). An archive is refused while a membership uses the role (409). Every change ends with one audit event (`org.role.create|update|archive`, before and after as `{ key, name, permissions sorted }`), the last statement of the transaction (ADR 0055). Lists are open rows, newest first, at most `ROLE_LIST_LIMIT` 100.

### Memberships (condition 3; D-I ★; plan 3.3, 6.2)

`GET /v1/members`, `POST /v1/members` (idempotent, `{ userId, roleId }`, 201), `PATCH /v1/members/:id` (`{ roleId }`), `DELETE /v1/members/:id` (204), under `org.member.read|invite|update|remove.org`; `GET|POST|PATCH|DELETE /v1/projects/:projectId/members[/:id]` under `project.member.read|assign` at org scope or on that project. Memberships are by `users.id`: invitation of people who have not signed in is P6-02's (condition 6, ROADMAP Also line). Rules:

- Escalation: an editor grants only keys they hold (org scope for an org membership; on that project for a project one). Target protection (condition 3): an editor updates or removes a member only if they hold every key of that member's current role (or current effective keys, for a project row); the last-owner rule keeps at least one open `owner` per organisation (`pg_advisory_xact_lock` per org, then a count: demoting or removing the last owner is 409).
- Project overrides are validated with `validateOverrides()` against the role's bundle (422 `validation_failed` with the path; an `add` the editor does not hold is 403); a project assignment needs an open org membership (409) and one open row per user and project (409). The resulting ability holds exactly the effective keys (DW4).
- Removal closes the user's project memberships in the organisation and their open sessions there in the same transaction through the sessions module's public port `revokeOfUserInTx()` (cause `admin`: `sessions.revoked` + `sync.revoke` rows, the worker sets the keys and ends the Keycloak sessions, ADR 0065), `org.session.revoke` audited before `org.member.remove`. A role change (demotion) revokes nothing: the next request's grants come from the database (D-I ★). The removed user's next request in that organisation is 403 `membership_missing` (the guard reads the membership before the session; the plan's wording was 401, for architect review) and 200 in another organisation.
- Every change writes one `users.mfa_check` row for the user (D5) and one audit event with before and after (`org.member.invite|update|remove`, `project.member.assign|unassign`), the last statement. Responses carry `mfaRequired` from the API's own reads (condition 1).
- Lists: open rows, newest first, at most `MEMBER_LIST_LIMIT` 100.

Bootstrap (D-F ★ a): `pnpm membership:bootstrap --org <uuid> --user <users.id>` runs `bootstrapOrganization()` once per empty organisation: the twelve system roles (eleven copied bundles, the virtual owner) and the first `owner` membership, audited as `org.member.bootstrap`, with the `users.mfa_check` row; a non-empty organisation or an unknown user is refused (exit 1). P6-02 creates organisations through the same function (ROADMAP Also line).

### D5: `bricx-mfa` through the outbox and the worker (D-G ★ a; conditions 1 and 5)

Topic `users.mfa_check` (queue `users`, payload `{ userId }` only, 128 bytes, delivery as `sessions.revoked`: 40 attempts, 1 s doubling, 60 s cap; amends ADR 0056). The payload carries no flag. The worker's consumer (`apps/worker/src/mfa/consumer.ts`) reads the truth per job: `app.mfa_state(userId)` through `withRelayTx()` (`apps/worker/src/mfa/truth.ts`), then, as `bricx-worker` with the admin client, maps the realm role: added when required and absent, removed when not required and present, nothing when already right. Convergent and order-free: a retry of an old job after a newer one applies the current state. The role's id is read from the user's own mapping lists (`role-mappings/realm`, else `role-mappings/realm/available`), which `manage-users` may read; `GET /roles/{name}` needs `view-realm`, which the service account does not hold (ADR 0060 3b), so the plan's per-boot lookup by name is not used (for architect review). A user the database or the realm no longer knows logs `mfa.user_missing` and completes. Logs: `mfa.applied { outboxId, userId, required, changed, attempt }`, `mfa.retry`, `mfa.keycloak_failed { outboxId, userId, attempts, status }` on exhaustion (P13-05 alerts; a database failure exhausts into the same line with no status), ids only, never the subject.

Every admin request carries a timeout (`REQUEST_TIMEOUT_MS` 30 s, the client's own `AbortSignal`), for the revocation consumer too: a Keycloak that accepts a connection and never answers fails the attempt, which BullMQ retries, instead of holding the job (for architect review).

Condition 5: `withRelayTx()` has a second user. Semgrep `bricx-relay-tx-outside-relay` now excludes `apps/worker/src/mfa/` with `apps/worker/src/relay/`, `packages/db/` and `apps/worker/test/`, with a known-good fixture for it (amends ADR 0056, whose "one documented exception" is now these two folders).

Live (DW7, `apps/worker/test/mfa.int.test.ts`): assigning `accountant` maps `bricx-mfa` in the Testcontainers realm within 231 ms of COMMIT (printed); the empty `member` role clears it; a paused Keycloak fails the attempt by timeout and the job applies after the unpause on attempt 2; a login before the mapping reaches `acr` `pwd` with no OTP step, after it asks for OTP and reaches `acr` `mfa` (the P5-01 flow, read only). What the user sees meanwhile (plan 4.4): the membership change is effective in the API at once (grants come from the database); until the role lands the user signs in at `acr` `pwd`, and P5-07 refuses finance permissions without `acr` `mfa`; on removal the user is asked for OTP until the role is cleared.

### D2, single-member-organisation SoD (plan section 5): not built

The last-owner rule makes a one-member organisation exactly an owner holding both sides of every SoD pair (`checkSod` has no override, ADR 0048); the roles API lets that owner grant anyone a second-approver role but builds no "mandatory second approver" check and no self-approval delay. The owner decides before P5-07: (a) a second approver mandatory, (b) a delayed or audited self-approval, or (c) none. `pending.md` keeps the row (condition 8).

### Keycloak privileges (D-H ★)

Mapping a realm role needs `realm-management` `manage-users`, which `bricx-worker` already holds and which also lets it map roles to anyone and reset passwords (ADR 0060 3b). Narrowing it (fine-grained admin permissions, a second client) is P13-01's, whose Also line gains the `bricx-mfa` mapping; a leaked `KEYCLOAK_WORKER_CLIENT_SECRET` can map any realm role or reset any password until then.

## Consequences

- `app.project_ids = '*'` identities (org-scoped grants on project resources) lose the project-level RLS backstop for that request; the ability check is the only project filter. Stated in ADR 0054's amendment and tested.
- Four owner-side read policies exist on authorisation tables; the migrator guard refuses any other row-free owner policy.
- `bricx_relay` may execute one `app` function; `withRelayTx()` is used in two worker folders.
- A role edit that moves finance keys fans one outbox row out per member; above 1000 members the edit is refused until P14-06's reconcile job exists.
- Until the worker applies a mapping, a newly finance-granted user signs in at `acr` `pwd` (P5-07 fails closed on finance), and a user whose finance keys were removed is still asked for OTP (harmless).
- A removed member's next request in that organisation is 403 `membership_missing`, not 401.
- Negative: the admin client's 30 s timeout turns a slow Keycloak into a retried failure (bounded by the delivery options).

## Alternatives rejected

- **Payload carries `required`** (D-G alternative b): a delayed retry and a newer job can flip the role the wrong way; the truth is re-read instead.
- **`permissions text[]` on `roles`** (D-C alternative): loses the grant history an audit of a bundle needs.
- **Trusting the `org_id` claim for authorisation**: a Keycloak attribute would grant access; it only preselects a default (phase ruling D7).
- **The wildcard from a claim or header**: refused by `withTx()`'s input check; only the computed access sets it (condition 2).
- **`bricx_app` executing `app.mfa_state()`**: the API would read across organisations through a definer function; it computes `mfaRequired` from org-scoped reads instead (condition 1).
- **Calling Keycloak from the request**: rule 5; the outbox and the worker carry the mapping.
- **Looking the realm role up by name once per boot** (the plan's wording): needs `view-realm`; the user's mapping lists carry the id with the privilege the worker already has.
