# 0063. Devices and sessions

- Status: Accepted; amended 2026-10-21 after the owner's PR #60 review (session lists: open rows only, newest first, at most 100; `DEVICES_MAX_PER_USER` caps a user's non-revoked devices; the P5-04 note on `sessions.revoked` and the retention line below); amended by [0065](0065-immediate-revocation.md) (P5-04: `sessions.revoked` carries `cause` and delivery options, one `sync.revoke` row per closed session goes with it, and the worker consumes `sessions.revoked`); amended by [0066](0066-grants-roles-project-overrides.md) (P5-05: the sessions module's public port `revokeOfUserInTx()` lets a membership removal close the user's sessions in the org in its own transaction with cause `admin`; the guard checks the membership before the session row, so a removed member is 403 `membership_missing` and no row is created for a non-member)
- Date: 2026-10-21
- Deciders: Mohamed Abass Jalloh
- Source: P5-03 (task plan approved 2026-10-21 with decisions 1–5 and 7 as the ★ defaults, decision 6 changed, and owner conditions 1–7); P5 phase rulings D6 and D9 (ADR 0060); the P5-02 review points filed as P5-03 Also lines; ADR 0048 (catalogue), ADR 0053 (request context), ADR 0054 (RLS), ADR 0055 (audit), ADR 0056 (outbox), ADR 0062 (token validation)

## Context

P5-02 gave every request a verified user and an organisation hint. Nothing yet knew which device a request came from, when a sign-in happened, or how to end one: a stolen access token lived its 300 s, a refresh token its 12 h idle, and an administrator had no way to end a user's sessions. ROADMAP P5-03 asks for `devices`, `sessions`, the `X-Device-Id` header and three endpoints; ruling D9 (whether those rows are per user or per organisation) was open, and ruling D6 says an organisation may only shorten the realm's idle timeout.

## Decision

### D9: devices are user-level, sessions are org-level (decision 1 ★)

- `bricx.devices (id, user_id → users, platform ios|android|web, name 1–100, created_at, last_seen_at, trusted default false, revoked_at)`, migration `0005_devices_sessions`. The id is the UUIDv7 the device makes for itself once (CLAUDE.md rule 6); a device that signs into two organisations is still one device, so the row has no `org_id`. Global like `users`: on `USER_TABLES`, ENABLE + FORCE RLS, own rows only (`user_id = app.current_user_id()`), through the new `enableOwnedRls(table, column, { update })` in `@bricx/db/rls` (which `enableUsersRls()` now reuses, byte-identical output). `bricx_app` may SELECT, INSERT and UPDATE its own rows, and UPDATE only the columns `name`, `last_seen_at` and `revoked_at` (`GRANT UPDATE (…)`, owner condition 1): never `user_id`, `id` or `trusted` (P5-07 decides who sets it). A `BEFORE UPDATE OF revoked_at` trigger (`bricx.forbid_unrevoke()`) raises 42501 when a set `revoked_at` changes, so a revoke is final. No DELETE or TRUNCATE.
- `bricx.sessions (id, org_id, user_id → users, device_id → devices nullable, keycloak_sid, created_at, last_seen_at, revoked_at)`, UNIQUE `(org_id, keycloak_sid)`: one row per organisation signed into per Keycloak session. On `TENANT_TABLES` as the new catalogue resource `org.session` (actions `read` and `revoke` at org scope; owner holds both, auditor reads; amends ADR 0048), so an administrator's reach is the organisation's rows, plus the own-row policies `enableOwnRowPolicies(table, "user_id")` (`user_id = app.current_user_id()` in any org) so a user lists and ends their own sessions across organisations with no grant (owner condition 3). `last_seen_at` is added to the ROADMAP's columns for the idle check. The same trigger forbids un-revoking, and `bricx.sessions_immutable()` keeps `id`, `org_id`, `user_id`, `keycloak_sid` and `created_at` fixed, so the app role can only bind a device, touch `last_seen_at` and close a row.
- The RLS coverage test seeds foreign-key parents first (`users` → `devices` → `sessions`) and proves a child seeded first is refused (23503) (P5 Also, P4 point 13). The integration test covers every policy, grant and column privilege, and the three condition-1 behaviours (changing `user_id`, setting `trusted`, un-revoking: each fails).
- Rejected: both tables org-level (a device row per organisation, duplicate devices, a broken primary key); both user-level (an administrator could never see a session in their organisation without a definer function).

### Session tracking in the guard

- `sid` is a required access-token claim (missing, empty or non-string: 401 `token_malformed`); Keycloak 26 sets it on access tokens and the live test pins it. After verification and provisioning, the guard tracks one `sessions` row per `(org_id, keycloak_sid)` inside `withTx()`: inserted on first sight (`INSERT … ON CONFLICT DO NOTHING`, then the winner's row is read, so ten parallel first requests give one row), `last_seen_at` touched at most once per `USERS_LAST_SEEN_THROTTLE_SECONDS` (the same interval as `users`), on the injected `Clock`. The identity carries `sessionId` and `deviceId`.
- One `auth.session_started` info line `{ sessionId, userId, orgId }` on insert; the `sid` never reaches a log (sentinel test).

### D6: the idle timeout (decision 5 ★, owner condition 7)

- `OrgSessionPolicy.idleSeconds(orgId)` is a port; the guard uses `min(value, 43 200)`, the realm's `ssoSessionIdleTimeout` pinned by a unit test that reads `realm-bricx.json`. A value that is not a positive integer falls back to the realm's. The production binding returns the realm value until P6-03 stores the organisation's value; an organisation value can therefore shorten the limit and never lengthen it (tested with 600 s, 100 000 s and −1).
- A session whose `revoked_at` is set is 401 `session_expired` (reason `session_revoked`); one whose `last_seen_at` is older than the limit is closed (`revoked_at` set and committed before the refusal) and 401 `session_expired` (reason `session_idle`); the next request is `session_revoked`. `session_expired` keeps ADR 0057's code (the client signs in again) and now sends `WWW-Authenticate: Bearer` like `unauthenticated` (for architect review). A session row belonging to another user (the same `sid` in the same organisation) is `session_user_mismatch` (401 `session_expired`).

### Device binding (decision 4 ★, owner condition 4)

- `X-Device-Id` absent: the session has no device (the web PWA before registration). Present: it must be one canonical UUID (checked before provisioning) naming a non-revoked device of this user; it then binds the session (`device_id`, set once) and reaches the identity and the audit origin. Unknown, revoked or another user's device, or a session already bound to another device, is 401 `unauthenticated` (reasons `device_unknown`, `device_revoked`, `device_mismatch`), and no session row is written.
- `@RegistersDevice()` (metadata plus the OpenAPI extension `x-bricx-registers-device`) marks the one route that accepts an unregistered header, `POST /v1/devices`; a test walks every operation of the production document and proves that set. Device binding is advisory until P5-07: it is not an authentication factor, and `trusted` is written by nobody.

### Endpoints (`modules/devices`, `modules/sessions`)

- `POST /v1/devices` (`@RegistersDevice()`, 201): body `{ id, platform, name }`; the header must equal the body id (else 400 `request.malformed`); inserts the caller's row and binds the current session. The same id for the same user is idempotent (201, the row unchanged, nothing written); another user's id is 409 `request.conflict` (the unique index, caught in the repository); a revoked device is 409. The route takes no `Idempotency-Key`: the id itself is the key (for architect review).
- `GET /v1/devices`: the caller's non-revoked devices, by id, at most `DEVICES_MAX_PER_USER` (PR #60 review, fix 2: the config key, `@bricx/config` `devices.maxPerUser`, 1–1000, default 20). A registration that would be the user's cap-plus-one non-revoked device is 409 `request.conflict` and writes nothing; the count is taken under a transaction-scoped advisory lock on the user (`pg_advisory_xact_lock(hashtextextended(user_id, 0))`), so two registrations racing for the last slot are serialised; revoking a device frees its slot; re-registering an existing id does not count. `DELETE /v1/devices/:id` (204): sets `revoked_at` and, in the same transaction, closes every open session of the caller on that device in every organisation; another user's device or an unknown id is 404 `not_found`; a second revoke is 204 and writes nothing.
- `GET /v1/sessions`: the caller's open sessions (`revoked_at IS NULL`) in every organisation, newest first (by id: UUIDv7, so creation order), at most 100 (`SESSION_LIST_LIMIT`; PR #60 review, fix 1), the current one marked; the Keycloak session id never leaves the server. Closed sessions are never listed; the audit trail holds the history. `DELETE /v1/sessions/:id` (204): closes one of the caller's sessions in any organisation; another user's is 404.
- `POST /v1/users/:userId/sessions/revoke` (200 `{ revoked: [ids] }`): closes the user's open sessions in the request's organisation; needs `org.session.revoke.org`. `GET /v1/users/:userId/sessions` (added so condition 3 can be tested at the ability layer, for architect review): the user's open sessions in the request's organisation, newest first, at most 100 (the same rule as the own list); needs `org.session.read.org`. Both are 403 under the production `noGrants` source until P5-05 binds grants (decision 2 ★: shipped gated by deny-all, tested with the production source; the grant is org-scoped, so an owner in one organisation closes nothing elsewhere). An unknown user is 200 with `[]`, never a leak.
- The ability check (`can()` over `abilityFor()`) runs before any database work; RLS limits the administrator's statements to the organisation underneath; the repository always adds `user_id` (and `org_id` for the administrator) so the ability is the only thing deciding whose rows are touched.

### Audit and outbox (decision 6 changed, owner conditions 2 and 6)

- Every revoke, in one transaction: the rows closed, one `sessions.revoked` outbox row per closed session (`{ sessionId, userId, orgId, keycloakSid }`, no names; topic registered in `@bricx/db/outbox`, queue `sessions`; since P5-04 also `cause`, plus one `sync.revoke` row `{ sessionId, userId, orgId }` on queue `sync`, [0065](0065-immediate-revocation.md)) under the request's organisation, then one `org.session.revoke` audit event in the request's organisation's chain listing every closed session with its `org_id` and `user_id`, the cause (`self`, `device` or `admin`) and the target (session, device or user id). A revoke that closes nothing writes nothing; a failed outbox insert rolls the close back (tested with a refusing trigger). P5-04 consumes the topic; until then the relay publishes it to an unconsumed queue, which it tolerates (worker test: no retry storm, no poison row). Note for P5-04: the outbox row's `org_id` is the request's organisation (a device revoke, or a self revoke from another organisation, closes sessions of other organisations), so the consumer must take the session's organisation from the payload's `orgId`, never from the row's `org_id`.
- Device registration is audited as `org.device.register` (entity `org.device`, ids only: the user and the session) in the request's organisation's chain; a device revoke as `org.device.revoke` with the sessions closed (for architect review). Provisioning stays unaudited (ADR 0062): no membership exists then, so no chain belongs to it; a device registration happens inside an organisation's session and so has one.

### P5-02 review points (decision 7 ★)

- `reasonFor()` maps an unclassified `jose` error to 401 `token_malformed`; only `JWKSTimeout`, `JWKSInvalid`, `JWKInvalid` and a failed fetch give 503. A signed token whose `sub` fails the printable-ASCII check is refused as 401 `subject_missing` before provisioning, never 500.

### Wiring

- `AuthModule` is global and exports the app's `Clock` (`CLOCK`), so the devices and sessions modules stamp rows on the clock the guard judges them by; `AuditModule` keeps its own binding. The services' dependencies are typed by what they use (`TransactionRunner`, `AuditRecorder`, `OutboxWriter`, the ports the controllers call), with the classes as injection tokens, so unit tests hand in plain objects.

## Consequences

- Positive: a lost device or a leaving user is cut off at the next request, in every organisation they were signed into, with an audit trail and an outbox event for P5-04.
- Positive: the column-level grants and triggers make a revoke final at the database, whatever the app does.
- Retention: closed `sessions` rows and revoked `devices` rows are kept until a retention job removes them (no DELETE policy; `bricx_owner` is bound by FORCE); the owner decides the policy (partition drop or an explicit `bricx_owner` DELETE policy) together with the outbox's and the idempotency keys' (ROADMAP P5-03 Also line).
- Negative: one more statement per request (the session row; throttled touches); measured in the integration suite, no pool change.
- Negative: the administrator routes do nothing for a real user until P5-05.
- Negative: `sessions.revoked` is relayed to a queue nobody consumes until P5-04.

## Alternatives rejected

- A session row per organisation on the device (both org-level): see D9.
- Requiring `X-Device-Id` on every route: the web PWA has no device before registration, and the binding is advisory until P5-07.
- A new error code for a revoked or idle session: `session_expired` already tells the client to sign in again.
- One audit event per affected organisation's chain: the actor acts in one organisation; the event there lists the others' ids, and each organisation's own `sessions` rows carry the close.
