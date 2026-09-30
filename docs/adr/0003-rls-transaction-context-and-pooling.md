# 0003. RLS request context, non-owner app role and transaction pooling

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C3

## Context

Stack v1 said "Drizzle + RLS" without specifying how the tenant context reaches Postgres. RLS is useless if the application role owns the tables (owners bypass RLS unless forced) or if session variables leak across pooled connections.

## Decision

Every request runs inside a transaction that executes `SET LOCAL app.org_id / app.user_id / app.project_ids`; RLS policies read these values with `current_setting(...)`. The application connects as a **non-owner, non-BYPASSRLS** role. Connection pooling uses PgBouncer/RDS Proxy in **transaction** mode. All DB access goes through `withTx()`; the raw pool is never imported.

## Consequences

Positive:
- RLS is actually enforced for application queries.
- `SET LOCAL` scopes the context to one transaction, so it cannot leak to the next user of a pooled connection.

Negative:
- Every query, including reads, must run inside a transaction, adding a small per-request overhead. (architect-reviewed 2026-09-30)
- Transaction-mode pooling rules out session-level features (session advisory locks, `LISTEN/NOTIFY`, session prepared statements) on the app connection. (architect-reviewed 2026-09-30)
- Migrations and bootstrap need a separate owner role and connection, so there are at least two credentials to manage per environment. (architect-reviewed 2026-09-30)

## Alternatives rejected

- **App role that owns the tables, or has BYPASSRLS**: silently disables RLS.
- **Session-level `SET` or session-mode pooling**: context can leak across pooled connections.
