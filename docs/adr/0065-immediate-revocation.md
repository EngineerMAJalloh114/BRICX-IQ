# 0065. Immediate revocation

- Status: Accepted
- Date: 2026-10-21
- Deciders: Mohamed Abass Jalloh
- Source: P5-04 (task plan approved 2026-10-21 at 16:23Z with decisions 1–3 and 5–8 as proposed, decisions 4 and 9 changed, and owner conditions 1–8); P5 phase ruling D10 (`assertSessionActive()` for the sync token); ADR 0056 (the outbox and its relay), ADR 0060 (the `bricx` realm; section 3b, the `bricx-worker` service account), ADR 0062 (token validation), ADR 0063 (devices and sessions), ADR 0064 (`@keycloak/keycloak-admin-client`).

## Context

P5-03 closes sessions in the database: a revoked session's next request is 401 `session_expired` from its row. Two things outlive that row. The access token stays valid for the realm's 300 s, and a request for an organisation where the user has no session row yet (a fresh login, or a token used in a second organisation) would start a new row for a user an administrator just barred. The refresh token in the Keycloak session outlives it too: Keycloak does not know BRICX revoked anything, so a refresh mints a new access token. P5-04 closes both gaps: a revocation must be visible to the API within 1 s and must end the Keycloak session, and the sync service (P8) must be able to refuse a revoked session a token.

The request must not call Keycloak: side effects go through the outbox (CLAUDE.md rule 5), and a Keycloak outage must not fail a revoke.

## Decision

### The write path (decisions 1, 5 and 8)

The API writes nothing to Valkey and never calls Keycloak's admin API. The revoking transaction (ADR 0063) writes, per closed session, one `sessions.revoked` row, whose payload now carries `cause` (`self`, `device` or `admin`), and one `sync.revoke` row (`{ sessionId, userId, orgId }`, queue `sync`, consumed at P8-02). The relay publishes them after COMMIT.

A BullMQ Worker in `apps/worker` on queue `sessions` consumes `sessions.revoked`, in this order: it SETs the revocation keys with the TTL, then ends the Keycloak session (`DELETE /admin/realms/bricx/sessions/{sid}`, a 404 is already ended), then logs one `revocation.applied` line with ids. The organisation comes from the payload (the organisation the session was signed into), never from the job's `orgId` (the request's). A bad payload is rejected without retry.

`OUTBOX_TOPICS` entries may carry delivery options (`attempts`, `backoffMs`, `maxBackoffMs`), which the relay passes to the add as the job's attempts and an `outbox` backoff the consumer resolves with `deliveryBackoffMs()` (amends ADR 0056). `sessions.revoked` is delivered up to 40 times, 1 s doubling, capped at 60 s (about 40 min); every attempt sets the keys first, so they are refreshed while Keycloak is down (the cap is below the TTL). The last failure logs `revocation.keycloak_failed` (session id, attempts, HTTP status; P13-05 alerts on it) and the job stays failed for the 24 h retention. The API-side revocation holds throughout; only the refresh token outlives it, and only while Keycloak is down.

### The keys (decision 4 changed, owner condition 1)

The keys are organisation-scoped: `revoked:sid:<orgId>:<keycloakSid>` for every closed session, and `revoked:user:<orgId>:<userId>` for an administrator's revoke-by-user. An organisation-A administrator bars the user from organisation A for the TTL; the same user's fresh login works in organisation B at once. The Keycloak session is organisation-agnostic, so ending it forces a re-login everywhere; accepted.

The TTL is the worker's `REVOCATION_TTL_SECONDS`: default 330, floor 305 (the realm's 300 s access token lifespan plus the guard's 5 s clock tolerance), ceiling 3600. The keys are written with `SET … EX` (idempotent).

### The guard check (decision 6)

After provisioning and before the sessions row is touched, the guard reads both keys in one `MGET` on a dedicated lazy ioredis client (no offline queue, no retries, 500 ms bound). A hit is 401 `session_expired` with the `auth.failed` reason `revoked_sid` or `revoked_user`, and nothing is written. The database check of ADR 0063 stays: a tracked revoked row is 401 with no relay latency.

Valkey unreachable fails closed: 503 `server_unavailable` and one `auth.revocation_unavailable` warning (P13-05 alerts on it). The key is the only thing that stops a still-valid token of a barred user where no session row exists, and a cache outage must not become a 300 s bypass on a financial platform. Valkey is already required by the worker at boot and probed by the API's readiness.

### `assertSessionActive()` (decision 7, phase ruling D10)

The sessions module's public API exports `assertSessionActive(sessionId)`: the row exists for the current user, is not revoked, is not idle under the organisation's policy, and neither key exists for its organisation; otherwise `ApiError("session_expired")`, or `server_unavailable` when Valkey does not answer. `GET /v1/sync/token` (P8-01) must call it before issuing a sync token.

### The worker (decisions 2, 3; owner conditions 2 and 3)

The worker reaches Keycloak with `@keycloak/keycloak-admin-client` 26.8.1 (ADR 0064) as the realm's `bricx-worker` service account (ADR 0060 section 3b: client credentials only, `realm-management` `manage-users`, the least Keycloak accepts for ending a session; what the account can and cannot do is probed live and recorded there). It requests the account's token at boot and refuses to start without it (`keycloak_unavailable`, a code only), and again whenever the token is about to expire. Its keys: `KEYCLOAK_ISSUER` (the API's rule; the admin base URL is the issuer minus `/realms/<realm>`), `KEYCLOAK_WORKER_CLIENT_SECRET` (a `Secret`, 16–256 characters) and `REVOCATION_TTL_SECONDS`.

### The 1 s Done-when (decision 9 changed, owner condition 4)

The relay's idle poll is 250 ms in production (1 s before). The end-to-end proof runs with the production default: a revoke through the API, then the same token's next request and a fresh login in the revoked organisation are 401 from the keys alone (the sessions row deleted with the Testcontainers superuser connection, owner condition 5), measured from the revoke response and printed; the budget is 1 s.

### Logs (decision 10)

No new audit events: `org.session.revoke` (ADR 0063) already records every revoke, and the worker has no audit role. Every log line carries ids, counts and codes only: never a Keycloak session id, a token, a secret or a driver message.

## Consequences

- One Valkey round trip per authenticated request, after the token check and before any write.
- Valkey down means 503 for every authenticated request, not a bypass. Readiness already reports it.
- A user revoked in organisation A for a cause other than `admin` keeps working in organisation B with the same token until its Keycloak session is ended (seconds, once the relay and consumer run); the `sid` key is per organisation.
- `manage-users` is wider than ending sessions; P13-01 narrows it (ADR 0060).
- A consumer failure never loses a revoke: the job is retried from Valkey, and a worker restart re-requests its token.

## Alternatives rejected

- **Calling Keycloak from the request**: a network side effect outside the transaction, and a Keycloak outage would fail revokes (rule 5).
- **Global user keys** (`revoked:user:<userId>`, the plan's ★): barred the user in every organisation for the TTL; the owner chose organisation-scoped keys.
- **Failing open when Valkey is down**: a cache outage would be a 300 s bypass for a barred user's still-valid token.
- **Keeping the idle poll at 1 s** (the plan's ★): the owner chose 250 ms so a revoke reaches the consumer well inside the 1 s Done-when.
- **Writing the keys from the API in the revoke request**: faster, but a write to Valkey outside the transaction (rule 5) that a rollback cannot undo.
