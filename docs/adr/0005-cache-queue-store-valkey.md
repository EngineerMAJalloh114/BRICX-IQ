# 0005. Cache and queue store: Valkey

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C5

## Context

Stack v1 named Redis for cache, queues and revocation lists. v2 prefers a store with a clear licence and lower managed cost, without changing the client libraries.

## Decision

Use **Valkey** (Redis-compatible, BSD licence), with ElastiCache for Valkey in the cloud and `valkey/valkey:8` locally. BullMQ and ioredis work unchanged.

## Consequences

Positive:
- Clear open-source licence.
- Lower managed cost.
- BullMQ and ioredis work unchanged.

Negative:
- Valkey and Redis may diverge over time; Redis-only features or docs may not apply, and compatibility has to be checked on upgrades. (proposed — needs review)
- Some third-party tooling and documentation assume Redis by name. (proposed — needs review)

## Alternatives rejected

- **Redis**: licence clarity and cost.
- **`redis` (node-redis) client**: banned in DEPENDENCIES.md; use `ioredis`.
