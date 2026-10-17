# 0057. Error model and idempotency keys: problem+json envelopes, `@Idempotent()`, `bricx.idempotency_keys`

- Status: Accepted
- Date: 2026-10-16
- Deciders: Mohamed Abass Jalloh
- Source: P4-07 (task plan approved 2026-10-16 18:39Z: decisions 1a, 2a, 3a, 4, 5b with the existing `app.current_user_id()`, 6a, 7 and 8, plus conditions 1–6); the P4 phase plan (D10 error model, D11 idempotency); CLAUDE.md rules 3, 4, 6, 8 and 12; ADR 0023 (dependency policy), ADR 0047 (the error envelope and `@bricx/validation`), ADR 0051 (`apps/api`), ADR 0052 (migrations), ADR 0053 (`withTx()`, the request context), ADR 0054 (RLS framework), ADR 0056 (system tenant tables).

## Context

ROADMAP P4-07 asks for RFC 9457 problem+json responses, namespaced and i18n-keyed error codes, and an `Idempotency-Key` middleware storing `(key, user, route, request_hash, response)` for 24 h on every POST that creates money or stock movements, done when a replayed POST returns the identical response without a second write. The P4-06 review added: the API's pg pools need the per-client error listener the relay's pool has, so an idle-client error cannot crash the process.

ADR 0047 already fixed the envelope `{ status, code, key, traceId?, issues?, truncated? }` with eight one-segment codes and a 32-hex-digit W3C trace id. The API had no exception filter yet: Nest's default answered `{ statusCode, message }` and a `TxRunner.run()` without an identity was a bare 500.

## Decision

### The error-code registry is namespaced (decision 1a; amends ADR 0047)

`ERROR_CODES` in `@bricx/validation/codes` keeps the eight P3-04 codes and adds, in this order: `request.malformed` (400), `request.body_too_large` (413), `request.unsupported_media_type` (415), `request.conflict` (409), `idempotency.key_missing` (400), `idempotency.key_invalid` (400), `idempotency.key_reused` (422), `idempotency.response_too_large` (500). A code matches `ERROR_CODE_PATTERN` `^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}$`; `isErrorCode()` is a Set lookup (never a property read). Each code has `errors:<code>` in en, fr and ar (fr and ar machine-drafted, ADR 0046) with a drift test. Only a code a test raises is registered (condition 4): `request.method_not_allowed` is not, because Fastify answers 404, not 405, for an unknown method on a known route (proved in `errors.test.ts`).

### The envelope and the trace id (decision 2a; amends ADR 0047)

The body is the ADR 0047 envelope unchanged, sent as `application/problem+json`; every member is an RFC 9457 extension, there is no `type`, `title` or `detail`. `traceId` is the API's correlation id (`x-request-id`, ADR 0051): `LIMITS.traceId` is 128 and the format `^[A-Za-z0-9._-]{1,128}$`, so a UUIDv7 and a W3C trace id both fit. The client renders `key`; a message never leaves the server.

### One filter, one pure mapping (decision 3a)

`apps/api/src/common/errors/`: `ApiError(code)` and `ValidationError(envelope)` for handlers, `BoundaryPipe(schema)` over `parseAtBoundary()` (P4-08 replaces it with nestjs-zod; the error path stays), `problemFor(error)` (pure: the thrown value → a code and a log level) and `ProblemFilter` (global `APP_FILTER`). Mapping, in order: `ApiError` → its code; `ValidationError` → `validation_failed` with its issues; `IdempotencyError` `response_too_large` → `idempotency.response_too_large`, other codes → `generic`; `IdempotencyMisuseError` → `generic`; `NoTenantContextError` → `session_expired` (401); `DatabaseUnavailableError` → `server_unavailable`; `TransactionCommitError` by SQLSTATE (below); Nest `HttpException` and Fastify's own errors (`statusCode` + `code`) by status (400 malformed, 401, 403, 404, 409 conflict, 413, 415, 422, 429, 502–504 unavailable, else `generic`); a driver error inside the handler by SQLSTATE, read through Drizzle's wrapper (`sqlstateOf()`: classes 08, 53, 57 → `server_unavailable`; 40001, 40P01 → `request.conflict`; else `generic`), and a node-postgres connection failure without one (a socket errno, "Connection terminated…", "…not queryable") → `server_unavailable` (for architect review); anything else → `generic`.

5xx are logged at error as `request.failed` with the error (stack and causes) and the SQLSTATE when there is one; 4xx at info as `request.rejected` with the code and status only. The health routes keep terminus's body through a controller-scoped `BaseExceptionFilter` (platforms read it). The API speaks JSON only: Fastify's built-in `text/plain` parser is removed, so any other body is 415.

### `TransactionCommitError` (decision 4, condition 3; amends ADR 0053)

A failure after `fn` resolved (COMMIT refused: a `DEFERRABLE INITIALLY DEFERRED` constraint, a serialisation failure, a lost connection) is `TransactionCommitError` from `withTx()`, carrying the 5-character SQLSTATE only (no message, no cause, no query text; anything that is not five `[0-9A-Z]` is dropped). The filter maps 23505, 23503, 23P01, 40001 and 40P01 → 409 `request.conflict` (info); any other class 23 → 500 `generic` with the stack logged; everything else, 57014 included, → 503 `server_unavailable`. An error inside `fn` is still rethrown unchanged (Drizzle's wrapper with the driver's error as `cause`).

### `bricx.idempotency_keys` (decision 5b, condition 2; migration `0003_idempotency_keys`)

Columns: `id uuid` (default `uuidv7()`), `org_id`, `user_id`, `route text` ("METHOD /path", no query string), `key text`, `request_hash bytea` (32 bytes), `status smallint`, `response text` (the exact serialised body), `headers jsonb` (`content-type`, `location`, `etag` only), `created_at`, `expires_at` (default `now() + 24 h`). UNIQUE `idempotency_keys_scope (org_id, user_id, route, key)`. CHECKs: key `^[A-Za-z0-9._~-]{1,255}$`; route `^[A-Z]{3,10} /[!"$->@-~]*$` and at most 2059 bytes (Postgres bounds a regex repeat at 255); hash 32 bytes; status 100–599; response ≤ 262 144 bytes; `(response IS NULL) = (headers IS NULL)`; headers a JSON object; `expires_at > created_at`.

RLS from `enableIdempotencyRls()` (`@bricx/db/rls`, registered in `SYSTEM_TENANT_TABLES` as `idempotency`): ENABLE + FORCE; three policies `TO bricx_app` only, SELECT, INSERT and UPDATE, each `(org_id = app.current_org() AND user_id = app.current_user_id())` (the existing function; no new one); `REVOKE ALL … FROM bricx_app, bricx_readonly` then `GRANT SELECT, INSERT, UPDATE … TO bricx_app`; no DELETE policy and no policy for `bricx_owner`, `bricx_readonly` or `bricx_relay`, which see nothing under FORCE. Another user of the same org can neither read, insert as, nor update a row (integration test). Expired rows are reused in place; the purge is P13's (below).

### The statements (`@bricx/db/idempotency`)

`claimIdempotencyKey(tx, { route, key, requestHash, status })`: after validating every field (`IdempotencyError` `invalid_key`, `invalid_route`, `invalid_hash`, `invalid_status`, before any SQL), one statement: a CTE reads `app.current_org()` and `app.current_user_id()` (no context: nothing inserted, `no_tenant_context`), `INSERT … ON CONFLICT ON CONSTRAINT idempotency_keys_scope DO UPDATE SET id = uuidv7(), request_hash, status, response = NULL, headers = NULL, created_at = now(), expires_at … WHERE expires_at <= now() RETURNING id`. A returned id means claimed; otherwise the committed row is read (`{ claimed: false, stored }`, with its hash: the statement does not judge a reused key). A concurrent duplicate blocks on the unique index until the first transaction ends (condition 5, proved with `pg_stat_activity`). `storeIdempotencyResponse(tx, id, body, headers)` completes the row in the same transaction: `response_too_large` over 256 KiB of UTF-8 (before any SQL, so the transaction rolls back and nothing is written), `invalid_headers` outside the allow-list or not header-safe, `invalid_id` when the row is not this user's.

### `@Idempotent()` (decision 6a, conditions 1, 5 and 6)

`IdempotencyInterceptor` is global, registered after `RequestContextInterceptor` (the context is sealed first). On an `@Idempotent()` route, before anything touches the database: a body that is not JSON is 415 `request.unsupported_media_type`; a missing `Idempotency-Key` is 400 `idempotency.key_missing`; one outside `^[A-Za-z0-9._~-]{1,255}$` (two headers included) is 400 `idempotency.key_invalid`. The fingerprint is SHA-256 over RFC 8785 canonical JSON (`canonicalize`, ADR 0017) of `{ body, query }` (no body hashes `null`); the route is `METHOD /path` without the query string; the declared status is `@HttpCode()` or 201 for POST, else 200. A route without the decorator ignores the header.

`TxRunner.run()` then claims as the transaction's first statement. A live key with a different fingerprint is 422 `idempotency.key_reused` (nothing written); the same fingerprint replays: `fn` does not run, the stored body is parsed and handed back as the result. Otherwise `fn` runs, `JSON.stringify(result)` (`"null"` for no result) and the allow-listed headers the handler set (`location`, `etag`; `content-type` defaults to `application/json; charset=utf-8`) are stored before COMMIT. The interceptor sends the stored text verbatim on the first answer and on every replay (a string with a JSON content-type, which Fastify sends as is): the same bytes, the same status and headers, the replay request's own `x-request-id`, and `Idempotent-Replayed: true` on a replay only. A handler that opens `run()` twice or never is `IdempotencyMisuseError` (500 `generic`). A handler that fails leaves no key, so a retry under the same key writes.

Stored responses are plaintext for 24 h: no secrets in idempotent responses, at most 256 KiB (condition 6). The purge is P13 (the owner has no retention policy yet; partition drop or a `bricx_owner` DELETE policy is decided then). `NoTenantContextError` → 401 is pre-P5; P5 revisits it with authentication.

### Pool error handlers (decision 7; the Also line from PR #52)

`openDatabase()` installs the same `connect` listener as `openRelayDatabase()`: every pooled client gets an error listener, so a backend terminated under a checked-out client fails that transaction and the process lives (integration tests in `packages/db` and `apps/api`: the next request works).

### Consuming `@bricx/validation` from Node (for architect review)

`@bricx/validation` and `@bricx/i18n` import their own sources with `.ts` extensions and ship JSON data; Node 24 loads the `.ts` files as is (type stripping, erasable syntax only), but refuses a JSON import without an attribute. The five JSON imports in `@bricx/validation` and `@bricx/money` now carry `with { type: "json" }` (TypeScript, Vitest and Node accept it; Metro/Hermes: must confirm at P7), and `apps/api` sets `allowImportingTsExtensions` (type-check) and `rewriteRelativeImportExtensions` (build; its own sources import with `.js`, so nothing of its output changes). `zod` 4.6.5 (already pinned repo-wide, ADR 0039) and `@bricx/validation` become `apps/api` dependencies.

## Consequences

- Every response that is not a success is one shape: `{ status, code, key, traceId, issues?, truncated? }` as `application/problem+json`; the client renders `errors:<code>`. No message, SQL, host or input value ever reaches a body.
- P9-04 and P11-03 POSTs that create money or stock movements carry `@Idempotent()` (ROADMAP Also lines); the P4-09 template shows `@Idempotent()` and `ApiError`.
- A key is scoped to (org, user, route): the same key from another user or org, or on another route, is a new request.
- `TransactionCommitError` is the first error `withTx()` raises for a failure after `fn`; repositories using deferred constraints (P9-04's balance trigger) get a 409, not a 500.
- Logs carry the SQLSTATE of every database failure behind an answer (`sqlstate` on `request.failed` and `request.rejected`).

## Alternatives rejected

- A per-route `@HttpCode`-free 200 for every idempotent route: the declared status is stored and replayed instead, so a 201 + Location is replayed as such.
- Storing the handler's result object and re-serialising on replay: the exact serialised text is stored, so byte equality holds by construction.
- A separate `app.current_user()` function: the existing `app.current_user_id()` (ADR 0054) is enough (owner's decision 5).
- 405 for an unknown method: Fastify yields 404; a code no test raises is not registered.
- Building `@bricx/validation` to a `dist/` for Node: the `.ts` sources load directly, as `@bricx/db`'s and `@bricx/ids`' already do.
