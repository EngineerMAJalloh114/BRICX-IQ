# 0016. API contract: nestjs-zod → OpenAPI → orval client

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C16

## Context

Stack v1 said "OpenAPI client" without saying how the contract is produced or consumed. The client must never drift from the server, and Zod is already the shared validation library.

## Decision

Use **nestjs-zod** (Zod → DTO + OpenAPI 3.1) on the API, and **orval** (OpenAPI → typed fetch client + TanStack Query hooks) to generate `packages/api-client` (`pnpm gen:api`).

## Consequences

Positive:
- Zod stays the single source of validation truth.
- The client never drifts from the server.

Negative:
- Zod 4 support across nestjs-zod and orval must be confirmed at P1; if either lags, the repo stays on Zod 3.x (per DEPENDENCIES.md).
- The generated client must be regenerated and committed on every API change, adding a CI drift check. (proposed — needs review)

## Alternatives rejected

- **`axios`**: banned in DEPENDENCIES.md; use `fetch` via the orval client.
- **`class-validator`**: banned in DEPENDENCIES.md; use Zod.
