# 0067. Temporary elevated access

- Status: Accepted
- Date: 2026-10-22
- Deciders: Mohamed Abass Jalloh
- Source: P5-06 (task plan approved 2026-10-22 at 09:22Z with decisions D-A, D-B, D-C and D-E as proposed, D-D changed to "revoke keeps sessions", D-G changed to "delayed job plus a 5-minute sweep", and owner conditions 1–6; condition 4's design, one shared recorder with two callers, chosen on the thread's card); the owner's phase decision D2 = (a) of 2026-10-22 11:18Z, recorded here as a P5-07 constraint; the owner's PR #71 review of 2026-10-22 at 21:47Z (three amendments: database immutability, removal ends elevations, no transitive elevation; the worker-credentials risk accepted); the P5-05 carry-forwards (the escalation rule `holdsAll`, the revoke-and-audit path, the outbox for every side effect); ADR 0048 (the catalogue), ADR 0053 (`withTx()`), ADR 0054 (RLS), ADR 0055 (audit), ADR 0056 (the outbox and its relay), ADR 0065 (delivery options), ADR 0066 (grants, `app.mfa_state()`, the `GrantsSource`).

## Context

P5-05 made a user's effective keys a function of their memberships: a role bundle, project overrides, nothing else. Month-end cover, an audit, a stand-in approver: real work needs one person to hold one key for a bounded time, with a reason, granted by someone who already holds it, ending on its own, and recorded at both ends. The task is 🔒: an elevation is an authorisation change, and a mistake is a silent, permanent escalation.

## Decision

### What an elevation is (D-A, D-B, D-C)

One grant is exactly one catalogue key, at one scope, to one user, for one window: `bricx.access_grants` (migration `0007_access_grants`): `id` (UUIDv7), `org_id`, `user_id → users`, `permission` (a catalogue key, ≤ 72), `scope_id` (a project id, NULL for org scope; a bare UUID until P6-05, as `project_memberships.project_id`), `reason` (1–500), `granted_by → users`, `starts_at`, `expires_at`, `revoked_at`, `revoked_by → users`, `expired_at`, `created_at`. Checks in SQL: `granted_by <> user_id`, `starts_at < expires_at`, a window of 60 s to 30 days, `revoked_at` and `revoked_by` set together and never before `created_at`, `expired_at >= expires_at`, never both `revoked_at` and `expired_at`. Partial indexes serve the user's active rows and the sweep's due rows.

Immutability in the database (PR #71 review, amendment 1): `bricx_app` has no table-level UPDATE on `access_grants`, only UPDATE on `revoked_at`, `revoked_by` and `expired_at` (`restrictTenantUpdate()` in `packages/db/src/rls.ts`, registry `TENANT_UPDATE_COLUMNS`, emitted into migration `0007` and checked by the RLS coverage test). The BEFORE UPDATE trigger `access_grants_immutable` (SECURITY INVOKER, the pattern of 0005's `sessions_immutable` and `forbid_unrevoke`) binds every role, the superuser included: any change to `id`, `org_id`, `user_id`, `permission`, `scope_id`, `reason`, `granted_by`, `starts_at`, `expires_at` or `created_at` raises 42501 `an access grant is immutable but for its end`, and a change to an end column when the row already has an end, or one that sets both ends at once, raises 42501 `an access grant ends once`: no un-revoke, no un-expire, no second end. A grant is ended once and never edited; more time or another key is a new grant.

A grant is active at instant t when `starts_at <= t < expires_at` and `revoked_at IS NULL`. It never auto-extends and there is no extension endpoint: more time is a new grant, a new audit event and a new expiry job.

The catalogue gains the resource `org.access_grant` with actions `read`, `grant`, `revoke` at org scope (29 resources, 86 permissions, 195 entries; amends ADR 0048). By default only the virtual owner bundle holds `grant` and `revoke`; `auditor` reads. An organisation that wants to delegate granting edits a role bundle with the P5-05 roles API.

Who may grant what (D-A ★): the granter must hold every key they elevate at org scope (`holdsAll`, the P5-05 escalation rule; a miss is 403 `forbidden` plus one `grants.escalation` line with ids only), and never elevates themselves (`granted_by <> user_id`; the API answers 422 on `userId`): the requester ≠ approver shape of CLAUDE.md rule 10, applied to elevation itself.

No transitive elevation (PR #71 review, amendment 3): the granter is checked against the keys of their memberships alone. `buildAccess()` also answers `membershipGrants`, the same computation before the elevations are merged; the guard carries them on the identity (sealed and validated like `grants`), and `grant()` runs `holdsAll` on `membershipAbilityFor(identity)`. A key a granter holds only through an elevation is 403 `forbidden` with the `grants.escalation` line, exactly as a key they do not hold. The three `org.access_grant.*` keys themselves are never elevatable: `scopeOf()` refuses them with 422 on `permission`, so no elevation hands out the right to elevate, read or revoke elevations. Every other use of the merged grants is unchanged: an elevated key works on every route that checks it.

Scope (D-B ★): a project- or site-level key must name a project in `scopeId`; an org-level key (`org.*`) must not. Anything else is 422 on `scopeId` (an org key with a scope, a project key without one, a site or own key: site scope waits for P6-05's site assignment). The user must hold an open org membership (409 `request.conflict` otherwise) and, for a project scope, an open project membership there (409).

Duration and caps (D-C ★): the window is 60 s to `ACCESS_GRANT_MAX_SECONDS` (config, 60–2 592 000, default 86 400 = 24 h); `startsAt` defaults to now and may be at most 30 days ahead; at most `ACCESS_GRANTS_MAX_PER_USER` open grants per user and organisation (config, 1–1000, default 20; 409 under a per-user advisory lock, as devices). Both keys are API-only (`@bricx/config/api`), documented in `.env.example`.

### Tables, policies and functions (DW1; owner conditions 2 and 4)

`access_grants` is on `TENANT_TABLES` (FORCE RLS, the generated org policies, no DELETE), on `OWN_ROW_TABLES` (a user reads their own rows in any organisation, for `GET /v1/me/access-grants` and the grants source) and on `OWNER_READ_TABLES` with the owner-side SELECT policy `access_grants_owner_select` (`OWNER_POLICY_TABLES`: SELECT only; the migrator guard refuses any other row-free owner policy). Not synced. The RLS coverage test, the FK seeding and the guard cover it.

`app.mfa_state()` v2 (D-F, condition 2; amends ADR 0066): `required` is also true when the user holds an access grant with a `finance.*` key that is not revoked and not expired (`expired_at IS NULL`), a future `starts_at` included: the realm role `bricx-mfa` is mapped before the window opens, so the first elevated request already needs MFA, and the expiry job's own `users.mfa_check` row clears it. Same signature, owner, `search_path` and grants as 0006 (EXECUTE `bricx_relay` only).

`app.access_grants_due(p_limit integer)`: SECURITY DEFINER as `bricx_owner`, `search_path = pg_catalog, pg_temp`, EXECUTE revoked from PUBLIC and `bricx_app`, granted to `bricx_relay` only (the `app.mfa_state()` pattern): the open grants past `expires_at` in every organisation, oldest first, at most 1000. It writes nothing. Nothing in SQL computes a hash or inserts an audit row (condition 4): the former `app.expire_access_grant()` of the plan does not exist.

`bricx.outbox.not_before timestamptz` (D-G; amends ADR 0056): `bricx_app` may set it on INSERT (`insertOutbox(tx, topic, payload, id, { notBefore })`); the relay's claim returns `delayMs` from the database clock (0 when unset or past, capped at `MAX_DELAY_MS`), and the publisher adds the job delayed by it, so the outbox never holds a long-lived row and a crash between the add and the COMMIT is still one job (jobId = the outbox id). New topic `access_grants.expire` (queue `access`, keys `grantId`, `userId`, the delivery options of `users.mfa_check`: 40 attempts, 1 s doubling, capped at 60 s).

### The grants source (DW2, DW5)

`DbGrantsSource` takes the app's `Clock` and, in the same `withTx()` as the membership rows, reads the user's grants active at that instant (bound as a parameter, never `now()`: `starts_at <= t < expires_at`, not revoked, newest first, at most `MAX_ACCESS_GRANTS` 1000). `buildAccess()` merges them with the membership grants: an org key is an org grant, a project key a project grant on its `scope_id` (merged per permission with the membership's projects); site, own, scope-less and scoped-org keys are dropped, an unknown key counted and logged once. `allProjects` and `projectIds` come from the memberships alone, so an elevation never sets `app.project_ids = '*'` (D-B, DW5): an elevated member runs with their own project ids. Server-side expiry is therefore effective at the instant, independent of any job: the next request after `expires_at` no longer holds the key (the integration suite moves a second app's clock across both boundaries: `starts_at == t` active, `expires_at == t` not).

### The API (DW3; D-D ★ changed, owner conditions 5 and 6)

Module `access-grants` (`/v1/access-grants`, every write `@Idempotent`):

- `POST` `{userId, permission, scopeId?, reason, startsAt?, expiresAt}` → 201 (`org.access_grant.grant.org`, then the checks above in order: identity, policy, self, scope, window, escalation, then one transaction: the per-user count under the advisory lock, the insert, the membership checks, the `access_grants.expire` outbox row with `not_before = expiresAt`, the `users.mfa_check` row, the audit event `org.access_grant.grant` with `after` `{userId, permission, scopeId, startsAt, expiresAt, reason}`). The reason lives in the audit event and the row only: no log line carries it (condition 6, tested with a sentinel).
- `GET` lists the open grants (not revoked, not expired at the Clock; a pending one is open), newest first, at most 100, `?userId=` filters; `GET /:id`; both `org.access_grant.read.org`.
- `DELETE /:id` → 204 with `org.access_grant.revoke.org` alone, no `holdsAll` (condition 5: an owner revokes a grant a lesser revoker could not have granted, tested); sets `revoked_at`/`revoked_by`, audits `org.access_grant.revoke` (before/after), enqueues `users.mfa_check`; 409 when already revoked or expired. Sessions are kept (D-D as changed): grants are recomputed on every request, so the key is gone on the next call, as the P5-05 demotion ruling; the owner revokes sessions separately with P5-03's endpoint.
- Removal ends elevations (PR #71 review, amendment 2): in the same transaction as the memberships module's `remove()` (an org membership) and `unassign()` (a project membership), the user's open grants end: every open grant in the organisation for `remove()`, those scoped to that project for `unassign()` (open = not revoked, not expired, `expires_at` after now; a pending grant included). `revoked_by` is the remover, each grant gets one `org.access_grant.revoke` event with `after.cause` = `org.member.remove` or `project.member.unassign`, the member event counts them (`accessGrantsRevoked`), and the transaction keeps its one `users.mfa_check` row. A user removed and re-invited inside a grant's window therefore holds no elevated key. The memberships repository writes `access_grants` itself (`endAccessGrantsOf`), because the access-grants module imports the memberships public API and a call back would be a cycle. **For architect review.**
- `GET /v1/me/access-grants`: the caller's active grants with `expiresAt` (the P7 countdown; P7-06 Also line). No grant needed.

Responses carry `active` (judged at the Clock) and `expiredAt`; `openapi.json` and `packages/api-client` are regenerated. Every refusal is the P4-07 error model (422 `validation:invalid_value` naming the path, 403 `forbidden`, 404 `not_found`, 409 `request.conflict`).

### SoD (D-E ★, DW6)

An elevation changes what an actor may do, never who the actor is. `checkSod` keys the history on `actorId` per `chainId`, so an elevated user who performed `request` on a chain is still refused `approve` on it (`packages/permissions/test/sod.test.ts`); P5-07 enforces this in the API, P5-06 ships the statement and the test. No SoD override exists (P3 ruling). A `finance.*` elevation therefore never lets the grantee approve a chain they requested; the DW6 `checkSod` test stays as the proof.

### D2: a second approver in every organisation (constraint for P5-07)

The owner decided D2 (`pending.md`, recorded at P3-05) on 2026-10-22 at 11:18Z: option (a). A second approver is mandatory in every organisation, single-member organisations included. There is no self-approval, no owner override and no delayed self-approval. P5-07 (SoD enforcement in the API) implements it: when no member other than the requester can approve, the action stays pending with the reason `sod_no_approver` until a second approver exists; its tests include a single-member organisation. Onboarding and invitations (P6-06) prompt the owner to invite a second member before finance workflows are used. P5-06 changes nothing for D2 beyond this record: elevations never change the SoD actor, as above.

### The expiry job and the sweep (DW4, D-G ★ as changed; owner conditions 3, 4 and 6)

The worker's `access_grants.expire` consumer (`apps/worker/src/access/`, queue `access`, concurrency 1) runs, per grant, ONE `withTx()` as `bricx_app` in the grant's organisation (a second pool the worker opens from `DATABASE_URL` and pings at boot, `app_database_unavailable`; the `app.user_id` of the context is the grant's user and only feeds RLS):

1. `expireAccessGrant()`: `expired_at = now()` (the database clock) on an open grant past `expires_at`, else the row's state and no change;
2. when it changed, the audit event `org.access_grant.expire` as actor `system` (`actor_type 'system'`, `actor_id NULL`) through the shared recorder, with `before`/`after` the row's audited columns (never the reason, which the worker never reads), correlation id = the outbox id, `occurred_at` from the worker's injected Clock;
3. one `users.mfa_check` row for the user.

All or nothing: the row, its event and the check commit together, so a grant is audited exactly once and never expired without its event (the live suite counts the rows after a replay). An open or pending grant (an early job: clock skew, or a row the consumer reached before its time) THROWS `AccessNotDueError`: BullMQ retries on the topic's backoff, and the job never completes as a no-op (condition 3; the early job of the live suite expired on attempt 4, one event). A revoked or already expired grant is `access.expire_noop`; a row the transaction cannot see is `access.grant_missing`. Live, the production relay at its defaults published the row at once as a delayed job and the consumer logged `access.expired` 70 ms after `expires_at`.

The sweep (`access_grants.sweep`, the worker's own job, not an outbox topic): one BullMQ job scheduler on queue `access`, every 5 minutes, upserted at boot by every worker (`upsertJobScheduler`, one schedule across N workers, condition 6; proven live with four registrations). Its body reads `app.access_grants_due(100)` through `withRelayTx()` and expires each grant exactly as above with correlation `sweep.<grant id>`, going on past a failing one (the job fails, so the next run retries). A lost delayed job is recorded within 5 minutes. Semgrep `bricx-relay-tx-outside-relay` now excludes `apps/worker/src/access/` with a known-good fixture: the third use of ADR 0056's exception (relay, MFA truth, this read).

Logs: `access.expired` (`outboxId`, `grantId`, `userId`, `orgId`, `source` job/sweep, `attempt`), `access.expire_noop` (with the state), `access.grant_missing`, `access.sweep` (counts), `access.retry` (`notDue`, the SQLSTATE), `access.rejected`, `access.expire_failed` (ids, attempts, SQLSTATE; P13-05 alerts on it), `access.sweep_failed`. Never a reason, a value or a message.

### One audit recorder, two callers (owner condition 4)

The hash chain is computed in one place. The recorder moves from `apps/api/src/modules/audit` to `packages/db/src/audit.ts` as `recordAuditEvent(tx, {clock, ids, actor}, event, origin)` (`@bricx/db/audit`): validation, the per-org advisory lock, the READ COMMITTED check, the chain head, `hash = sha256(prev ‖ JCS(row))`, the INSERT, unchanged line for line but for the actor: `user` (`app.current_user_id()`, the API's `AuditService.record()`, which keeps its signature and adds the request origin) or `system` (the worker's expiry consumer). `bricx_relay` gets no INSERT on `bricx.audit_events` and no chain logic exists in SQL (amends ADR 0055). `canonicalize` becomes a `packages/db` dependency (already an allowed package; the DEPENDENCIES.md row names both homes). The P4-05 validator and hash suites also run in `packages/db`, plus a recorder suite over a fake transaction; `audit:verify` is untouched.

### MFA (D-F, DW7)

At grant, revoke and expiry the transaction writes one `users.mfa_check` row; the P5-05 consumer reads `app.mfa_state()` v2 and maps or clears `bricx-mfa`. Live: a `finance.*` elevation whose `starts_at` was still 30 s ahead mapped the realm role (condition 2); once it was revoked and the last finance elevation expired, the expiry's own check cleared it. The consumer reads the truth per job, so an older check in the queue may apply a newer state first (convergent, `changed: false` on the later one).

## Consequences

- Elevations are rows, so every P5-05 guarantee holds for them: tenant isolation, own-row reads, no sync, the generated policies, the guard's allowlist.
- The worker now holds `bricx_app` credentials (`DATABASE_URL`) beside `bricx_relay`'s, for this consumer alone; every statement it runs is inside `withTx()` in one organisation. The alternative, chain logic in SQL or an audit INSERT for `bricx_relay`, is what condition 4 rules out. **Accepted risk** (owner, PR #71 review): a leaked worker environment can do whatever `bricx_app` can in any organisation it names in `withTx()`, not only expire grants. P13-01 replaces it with a dedicated narrow worker database role (P13-01 Also line).
- Two clocks: the API judges `active` at the injected Clock (a bind parameter); `expired_at` is the database clock. A skewed database would record the expiry early or late and never grant access (the API side rules); a job that runs before the database agrees is retried, not completed. **For architect review.**
- `app.mfa_state()` counts a grant until `expired_at` is set, so between `expires_at` and the job (milliseconds; at most 5 minutes after a lost job) the realm role stays mapped: MFA is asked a little longer, never a little less.
- An elevation on a project the user is not a member of grants the key at that project but adds no project id (RLS keeps the rows hidden); the API refuses such a grant (409), and removing or unassigning the membership ends the grant in the same transaction (amendment 2), so this only concerns a project membership closed some other way. `MAX_ACCESS_GRANTS` 1000 bounds the read. The members list's `mfaRequired` is computed from memberships alone (the database's `app.mfa_state()` is the truth the worker maps). **For architect review**, all three.
- BullMQ delayed jobs survive a Valkey restart only with persistence (the dev stack has it; P13-01 Also line); the sweep covers a lost one within 5 minutes.
- Also lines: P5-07 (D2 = (a): `sod_no_approver`, tests including a single-member organisation; consider a second approver for finance-key elevations), P6-06 (prompt the owner to invite a second member before finance workflows), P6-05 (site scope), P7-06 (the countdown from `GET /v1/me/access-grants`), P8-02 (elevations in the device's grant set and stream scope), P13-05 (`access.expire_failed`), P14-06 (reconcile `expired_at` against the chain).

## Alternatives considered

- A SECURITY DEFINER `app.expire_access_grant()` that updates, audits and enqueues in SQL (the plan's first shape): rejected by condition 4 (chain logic outside the recorder; an audit INSERT reachable by `bricx_relay`).
- Recording the expiry event later, from the API, on the next request that touches the grant: the expiry would not be audited at expiry.
- A separate system user id in the transaction context: a `TxContext` change (ADR 0053) for no gain; the actor is explicit in the recorder.
- Sweep only, no `not_before`: an expiry audited up to 5 minutes late; the owner chose the delayed job plus the sweep.
- Checking a granter against the merged grants (the first shape of this PR): an elevated user could pass the key on, and an elevation of `org.access_grant.grant.org` could hand out the power to elevate; rejected in the owner's review (amendment 3).
- Leaving a removed member's grants to their natural end: a re-invite inside the window would bring the key back; rejected in the owner's review (amendment 2).
- Closing the user's sessions on revoke: the owner chose to keep them (the key is gone on the next request; sessions are revoked with P5-03's endpoint).
