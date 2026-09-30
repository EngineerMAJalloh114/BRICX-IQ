# 0015. Runtime versions: Node.js 24 LTS and PostgreSQL 18

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C15

## Context

Stack v1 said "Node.js LTS" without a version. Unversioned runtimes make builds unreproducible for Claude Code and for developers.

## Decision

- **Node.js 24 LTS**, pinned via `.nvmrc` and `engines`.
- **PostgreSQL 18**, for native `uuidv7()`.
- Fall back to PostgreSQL 17 + app-side UUIDv7 only if the managed provider lags.

## Consequences

Positive:
- Explicit versions make builds reproducible.
- Native `uuidv7()` in the database.

Negative:
- PostgreSQL 18 support on managed providers (RDS/Aurora, and extensions such as PostGIS) may lag; the fallback path must stay possible. (architect-reviewed 2026-09-30)
- Pinned runtimes need deliberate upgrade work when each version reaches end of life. (architect-reviewed 2026-09-30)

## Alternatives rejected

- **Unversioned "Node.js LTS"** (v1): not reproducible.
- **PostgreSQL 17 as the primary target**: kept only as the fallback when the managed provider lags.
