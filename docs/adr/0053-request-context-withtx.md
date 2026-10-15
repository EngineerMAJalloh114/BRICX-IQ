# 0053. Request context and `withTx()`

- Status: Accepted
- Date: 2026-10-15
- Deciders: Mohamed Abass Jalloh
- Source: P4-03 (task plan approved 2026-10-15 17:16Z: all ★ with changes 1–4; P4 phase plan approved 11:06Z, change 5: the Semgrep SQL rule is a Done-when item); CLAUDE.md rules 3, 4 and 11; ADR 0003 (RLS context, transaction pooling), ADR 0035 (database roles), ADR 0040 (`withTx()` lives in `packages/db`), ADR 0043 (Semgrep), ADR 0051 (`apps/api`, the readiness probe), ADR 0052 (the migrator).

## Context

ROADMAP P4-03 asks for an AsyncLocalStorage request context (`userId, orgId, projectIds[], roles, deviceId, ip, geo?, correlationId`), a `withTx(fn)` that opens a transaction as `bricx_app` and sets `app.org_id`, `app.user_id` and `app.project_ids` with `set_config(..., true)`, repositories that receive `tx`, and a lint rule against the raw pool. Done when an integration test proves that a query with no context returns zero rows from tenant tables.

Constraints already decided:
- `withTx()` lives in `packages/db` with no Nest imports; `apps/api` only wires it to the request context (ADR 0040).
- The app role is non-owner and non-BYPASSRLS, behind a transaction-mode pooler, so the context must be transaction-local (ADR 0003).

No tenant table exists yet: P4-04 builds the RLS framework, and P4-05 adds `audit_events`, the first tenant table.

## Decision

**`packages/db` (`@bricx/db/database`)**
- `withTx(context, fn)` is a method of the handle `openDatabase()` returns, so the pool stays private. The context is explicit (`{ orgId, userId, projectIds }`), so the P6-05b seed can pass its own.
- `fn` receives a Drizzle node-postgres transaction; the package exports its type as `Tx`.
- **Before any connection:**
  - The context is validated and frozen into a copy (owner change 4). `orgId` and `userId` must be canonical lower-case UUIDs of any version: Keycloak user ids are v4.
  - `projectIds` must be unique UUIDs, at most `MAX_PROJECT_IDS` = 1000 (for architect review). The length is checked before any element is read.
  - A bad context is `InvalidTxContextError`, naming the field and never the value.
- **One statement sets the context:** `set_config(name, value, true)` for `app.org_id`, `app.user_id`, `app.project_ids` and `statement_timeout`, with every value a bind parameter.
  - `app.project_ids` is a Postgres array literal `{…}`, so P4-04 can cast it to `uuid[]`.
  - `statement_timeout` defaults to 30 s (`statementTimeoutMs`; for architect review).
- **Errors:**
  - A failure to connect or to set the context is `DatabaseUnavailableError`, with no detail, and `fn` never runs.
  - An error from `fn` rolls back and is rethrown unchanged.
  - `withTx()` inside a `withTx()` callback is `NestedTransactionError` (an AsyncLocalStorage marker); parallel calls outside a transaction are not nested.
- **Timeouts:** `queryTimeoutMs` (the client-side read timeout) is a separate option. The readiness pool keeps it at its 2 s bound; the API's request pool sets it to 35 s, so Postgres cancels a slow statement at 30 s first (for architect review).

**`apps/api` (`src/common/db/`)**
- **`context.hook.ts`** (owner change 1): a Fastify `onRequest` hook creates the store with `AsyncLocalStorage.run(store, done)`.
  - `correlationId` is the request id (`x-request-id`).
  - `ip` is Fastify's `request.ip`. trustProxy stays off until P13-02 (owner change 4, an "Also" line).
  - `deviceId` is `x-device-id` when it is a canonical UUID, otherwise undefined. It is untrusted until P5 device binding.
  - `geo` is undefined.
  - A POST whose body arrives in chunks over a real socket keeps the context through guards, interceptors and the handler (tested on Node 24 and Fastify 5.12.5). No hook re-enters the context: a `preValidation` re-entry was tried and removed, because the tests pass without it.
- **`request-context.ts`:** `setIdentity()` sets the identity once, before the handler; P5's auth guard will call it. `currentRequestContext()` reads the context.
- **`context.interceptor.ts`** (global) only reads and validates. It validates the identity (the same validator as `withTx`, plus at most 64 roles of 1–100 characters), then freezes the context. An invalid identity fails the request with a 500 and no detail, before the handler; later changes are `RequestContextSealedError`.
- **`TxRunner.run(fn)`** calls `withTx()` with the identity's org, user and projects. Outside a request it throws `NoRequestContextError`; without an identity (no authentication before P5), `NoTenantContextError`. Both happen before any connection.
- **`DatabaseModule`** (global) owns the request pool: 10 connections, closed on shutdown. The readiness probe keeps its own small pool (owner change 2).

**Done-when fixture** (owner change 3). Tests apply a fixture migration through the real migrator, as `bricx_owner`: `bricx.tenant_probe` with FORCE RLS and one policy with `USING` and `WITH CHECK` on `NULLIF(current_setting('app.org_id', true), '')::uuid`. Rows are seeded under each org's context.

**Semgrep** (Done-when; the step-3 lint rule). Each file holds one rule (G8), so there are two new rules:
- `bricx-raw-sql-outside-withtx` (everywhere): `sql.raw(…)`, and the driver client under a Drizzle transaction (`$client`, `session.client`).
- `bricx-db-query-outside-withtx` (`packages/db/src`): `.query(` or `.connect(` outside `database.ts` (the ping and `withTx`) and `migrate.ts` (the migrator's own `bricx_owner` client).

Outside `packages/db`, the existing `bricx-raw-pg-outside-db` still forbids the driver itself. The pool lives in `packages/db`, so the ROADMAP's `apps/api/src/common/db` path for the lint rule does not apply (ADR 0040, consequence).

No new package: `drizzle-orm` 0.45.4 is added to `apps/api` as a devDependency for its integration test, at the version `packages/db` already uses (DEPENDENCIES.md lists it for the api via `@bricx/db`).

## Alternatives rejected

- **AsyncLocalStorage inside `packages/db`:** it ties the package to the request lifecycle, and the seed would need a request context too.
- **A raw `pg` client for `fn`:** repositories would build SQL by hand. Drizzle's `sql` template binds every value.
- **Creating the store in the interceptor:** guards run before interceptors, so P5's auth guard could not write the identity into it (owner change 1).
- **Savepoints for a nested `withTx()`:** a second context inside a transaction would be ambiguous. Code inside a transaction uses the `tx` it has.
- **One pool for requests and the readiness probe:** under load a busy request pool would fail the probe (owner change 2).

## Consequences

- After `set_config(…, true)` and COMMIT, the setting reads `''`, not NULL, in that session (tested). Every P4-04 policy must use `NULLIF(current_setting(…, true), '')`.
- The context is transaction-local, so it never outlives its transaction on a pooled connection (tested on a one-connection pool). This also holds behind a transaction-mode pooler (ADR 0003).
- Before P5, no request has an identity, so `TxRunner` refuses every tenant query. Health routes do not use it.
- The request context's `ip` is the load balancer's address until P13-02 sets trustProxy ("Also" line).
- `deviceId` comes from a client header and must not be trusted for authorization until P5 binds devices. (for architect review)
- `geo` stays undefined until a later task supplies it.
