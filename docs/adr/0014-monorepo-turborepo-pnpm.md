# 0014. Monorepo: Turborepo + pnpm workspaces

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C14

## Context

Stack v1 left the monorepo tool open: Turborepo **or** Nx. The repo holds an Expo client, a NestJS API, a worker and shared packages.

## Decision

Use **Turborepo + pnpm workspaces**, with Turborepo remote cache in CI.

## Consequences

Positive:
- Lighter than Nx.
- First-class Expo monorepo support.

Negative:
- No built-in code generators or project graph tooling like Nx; module boundaries are enforced with ESLint (`eslint-plugin-boundaries`) instead. (architect-reviewed 2026-09-30)
- The remote cache is another piece of CI infrastructure to configure and secure. (architect-reviewed 2026-09-30)

## Alternatives rejected

- **Nx**: v1 alternative; banned in DEPENDENCIES.md.
- **Lerna**: banned in DEPENDENCIES.md.
