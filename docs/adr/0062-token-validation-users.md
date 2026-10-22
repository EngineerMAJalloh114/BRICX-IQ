# 0062. Bearer-token validation, user provisioning and OpenAPI exposure

- Status: Accepted; amended by [0063](0063-devices-sessions.md) (`sid` is a required claim; `reasonFor()` maps an unclassified `jose` error to 401 `token_malformed`, only JWKS failures give 503; a `sub` that fails the printable-ASCII check is 401 `subject_missing` before provisioning; the guard then tracks the session and the device, and `AuthModule` is global and exports the app's `Clock`); amended by [0065](0065-immediate-revocation.md) (P5-04: between provisioning and session tracking the guard checks the org-scoped revocation keys in Valkey, a hit is 401 `session_expired` with reason `revoked_sid` or `revoked_user`, and an unreachable Valkey is 503 `server_unavailable`, fail closed); amended by [0066](0066-grants-roles-project-overrides.md) (P5-05: `DbGrantsSource` replaces `noGrants` in production; the request's organisation is `X-Org-Id` else the claim, refused with 403 `org_invalid`, `org_missing` or `membership_missing` before anything is written; `Access` carries `allProjects`)
- Date: 2026-10-21
- Deciders: Mohamed Abass Jalloh
- Source: P5-02 (task plan approved 2026-10-21 with decisions 1–7 as the ★ defaults and owner conditions 1–8); P5 phase rulings D1, D3, D7 and D8 (ADR 0060); P4 exit rulings, points 23 and 25; ADR 0061 (`jose`); ADR 0047 (error codes); ADR 0053 (request context, `withTx()`); ADR 0054 (RLS and the migrator guard); ADR 0057 (error model); ADR 0058 (OpenAPI); ADR 0059 (module template)

## Context

Until P5-02 every API test reached a route through one of eight hand-copied test identity guards, and a real request without an identity was 401 `session_expired` (ADR 0057). P5-02 replaces that with real bearer tokens from the P5-01 realm: the API must verify Keycloak's access tokens, map a token's `sub` to a `users` row, and fill the request context, without letting personal data reach a log line and without granting anything before P5-05 brings memberships and roles.

## Decision

### Log redaction first (P4 points 23 and 25)

- `@bricx/db/log` is the `err` serializer of the API's and the worker's pino instances. An error with a database error anywhere in its cause chain (a SQLSTATE, Drizzle's `DrizzleQueryError`, `TransactionCommitError`) is logged as its type, the SQLSTATE, the constraint, schema, table and column names and its stack frames only: no message, no cause, no pg `detail`, `where`, `internalQuery` or parameters. Any other `Error` keeps type, message, stack and a bounded cause chain; a non-`Error` value is logged by its type only.
- Sentinel tests write a value that violates a unique constraint through real requests and fail if it reaches the captured request log, the error-handler line, the outbox relay's log or the worker's log.
- A pool client of `openDatabase()` that emits `'error'` while checked out does not crash the process (`packages/db` test, which fails directly without `keepClientsQuiet()`).

### Token verification (decisions 3 and 4, owner condition 5)

- One global `AuthGuard` (`APP_GUARD` in `AuthModule`), deny by default. `@Public()` (metadata plus the OpenAPI extension `x-bricx-public`) marks the two health routes and, when exposure is `public`, `/openapi.json`. A test calls every operation of the production app without a token: each is 401 except the public ones, and the public set is exactly the health routes.
- The header must be `Bearer <three base64url segments>`, at most 8 192 characters of token.
- `jose` `jwtVerify()` with `algorithms: ["RS256"]` only, `issuer` = `KEYCLOAK_ISSUER`, `audience` = `bricx-api` (a constant), `exp`, `iss` and `aud` required, a 5 s `clockTolerance`, and `currentDate` from the injected `Clock`, never the process clock.
- After `jwtVerify()`: `sub` must be a non-empty string of at most 255 characters, and Keycloak's payload claim `typ` must be `Bearer`, so ID and refresh tokens are refused. (jose's own `typ` option checks the JOSE header, which Keycloak sets to `JWT`, so the claim is checked in code.)
- Keys come from `${issuer}/protocol/openid-connect/certs` through `createRemoteJWKSet()`: a 5 s fetch timeout, a 30 s cooldown before an unknown `kid` may refetch, keys refetched after 10 minutes (for architect review). jose does not remember a failed fetch, so the verifier does: after a failure, requests answer 503 for 5 s on the `Clock` without fetching. A missing or ambiguous `kid` is the token's fault and does not start that cooldown. Tests prove one fetch for many requests, a bounded number of fetches for many unknown-`kid` tokens, rotation (with the cooldown overridden to 0), the failure cooldown and the timeout.

### One answer for every failure (decision 2, owner condition 4, ruling D3)

- Every token failure is the new error code `unauthenticated` (401, `WWW-Authenticate: Bearer`), with an identical body whatever the reason; it is in `ERROR_CODES`, the en/fr/ar error keys (fr and ar machine-drafted) and the OpenAPI problem schema, and `packages/api-client` is regenerated. A valid token without a valid `org_id` is 403 `forbidden`. An unreachable JWKS is 503 `server_unavailable`, never 401.
- The reason goes only to the log: one `auth.failed` warning line `{ reason }` with the request's correlation id. Reasons: `token_missing`, `token_malformed`, `alg_refused`, `key_unknown`, `signature_invalid`, `issuer_mismatch`, `audience_mismatch`, `expired`, `not_yet_valid`, `subject_missing`, `type_refused`, `org_missing`, `jwks_unavailable`. The line never carries the token, the `sub` or any personal data (sentinel tests).
- A failed token writes no `audit_events` row and no `users` row (count before and after, ruling D3).

### The org hint (decision 5, ruling D7)

- The `org_id` claim must be a UUIDv7; the identity's organisation is that value. It is a default-organisation hint set by an administrator on the Keycloak user, never authorisation: from P5-05 the grants come from memberships, and an org the user has no membership in grants nothing.
- The order is verify, then the org check, then provisioning, so a token without a valid `org_id` writes no `users` row.

### Users and provisioning (ruling D8, owner conditions 2 and 3, decision 6)

- `bricx.users (id uuid PK, keycloak_sub text UNIQUE 1–255, created_at, last_seen_at)`, ids UUIDv7 (checked), migration `0004_users`. The table is global (no `org_id`) but keeps ENABLE + FORCE RLS: `GLOBAL_TABLES` stays empty and the table is on a new `USER_TABLES` registry (`enableUsersRls()` in `@bricx/db/rls`), counted by the "every table in schema bricx" test.
- `bricx_app` and `bricx_readonly` may SELECT only their own row (`id = app.current_user_id()`) and write nothing; owner-side policies let `bricx_owner` (which FORCE binds) SELECT, INSERT and UPDATE so its definer function can upsert (for architect review). No DELETE policy. `users` is not in the `powersync` publication (tested).
- `app.provision_user(p_sub, p_now, p_throttle_seconds)` is the only writer: SECURITY DEFINER, owned by `bricx_owner`, `SET search_path = pg_catalog, pg_temp`, fully qualified names, EXECUTE revoked from PUBLIC and granted to `bricx_app` only. It runs inside `withTx()` with the token's org hint as `app.org_id` and a fresh UUIDv7 candidate (from the `Clock`) as `app.user_id`. A new `sub` inserts the candidate; a known `sub` keeps its id and `created_at`, and `ON CONFLICT DO UPDATE` touches only `last_seen_at`, at most once per `USERS_LAST_SEEN_THROTTLE_SECONDS` (default 300 s). It returns the user's id either way; the time comes from the `Clock`, never `now()`. Ten parallel first requests for one `sub` give one row and one id.
- The migrator guard (ADR 0054) now also refuses a SECURITY DEFINER function whose `search_path` names anything but `pg_catalog`, `pg_temp`, `bricx` and `app` (`definer_search_path`), or that PUBLIC may execute, explicitly or through the default ACL (`definer_public_execute`).
- Provisioning writes no audit row: `users` is global and `audit_events` is org-scoped and hash-chained per organisation, so a first sign-in has no chain it belongs to; the organisation a user acts in is a hint until P5-05, which audits memberships, the change that actually grants access (for architect review). Instead the guard logs one `auth.provisioned` info line `{ userId, orgId }` when a row is inserted, with no `sub` and no token.

### Identity and grants (owner condition 1)

- The request identity is `{ userId, orgId, projectIds, grants }`; roles are gone. The grants are sealed through `@bricx/permissions`' `parseGrants` (bounded, copied, frozen), and `abilityFor()` builds the CASL ability from them.
- A `GrantsSource` port supplies `{ projectIds, grants }` per user and org. Production binds `noGrants` (no projects, no grants, so the ability denies everything) until P5-05. Tests inject a source from `apps/api/test/support` through a test-only `createApp()` option; there is no role-claim shortcut in `src`. `bootstrap.ts` calls `createApp(config)` with no option (tested).
- The `UserDirectory` port is provisioning; tests without a database inject a fixed directory the same way. The clock and JWKS settings are test-only options too.

### Test support and its fence (decision 7, owner condition 7)

- `apps/api/test/support/auth.ts` runs a local RS256 issuer (a JWKS HTTP server on 127.0.0.1) that signs tokens, so every suite goes through the real guard; the eight hand-copied test identity guards are deleted.
- `@bricx/keycloak-realm/testing` (realm users, password login, token calls) is a devDependency of `apps/api` only. Live tests against the P5-01 realm cover a valid token, expiry (on the API's `Clock`), the wrong audience (a client without the audience mapper), the wrong issuer (the same realm reached as 127.0.0.1), a missing `org_id`, and key rotation through the admin API.
- Semgrep rule `bricx-src-imports-test-support` refuses, under `apps/*/src` and `packages/*/src`, any static or dynamic import of `test/support` or `@bricx/keycloak-realm/testing`, with good and bad fixtures.

### OpenAPI exposure (ruling D1)

- `OPENAPI_EXPOSURE` = `public | authenticated | off` (default `public` in development and test, `off` in production; `public` in production is a config error). `public` registers the route as `@Public()`, `authenticated` registers it behind the guard, `off` registers no controller (404). The document holder exists in every mode and `pnpm gen:api` builds the document from the app, never through the route, so every mode builds the same document (tested).
- The document declares `components.securitySchemes.bearer` (HTTP bearer, JWT) and `security: [{ bearer: [] }]` on every operation that is not public.

## Consequences

- Positive: one verification path for every route and every test; the failure reason is diagnosable from the log and invisible to a caller.
- Positive: `users` cannot be written by the app role except through one pinned, tested function, and the guard catches the next definer function that forgets its `search_path` or its PUBLIC revoke.
- Negative: until P5-05 every authenticated request is denied by the ability (no grants), so only public routes do anything for a real user.
- Negative: the API integration suite builds and starts Keycloak (one container per file).
- Negative: the JWKS settings are constants, not config (for architect review).

## Alternatives rejected

- Reusing `session_expired` for every failure: it tells a client "refresh" when the token may be forged, and mixes session expiry with authentication failure.
- An audit row for provisioning: no organisation chain to put it in (above).
- Roles from a token claim until P5-05: a shortcut that production could start relying on; grants come only through the port.
- A copy of the Keycloak helpers in `apps/api/test`: two copies to keep in step with the realm.
