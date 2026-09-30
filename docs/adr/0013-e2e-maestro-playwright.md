# 0013. End-to-end testing: Maestro (mobile) and Playwright (web)

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C13

## Context

Stack v1 left mobile E2E open: Maestro **or** Detox. Field workflows must be tested under flaky network conditions.

## Decision

Use **Maestro** for mobile E2E and **Playwright** for web E2E. Unit and integration tests use Vitest.

## Consequences

Positive:
- One choice per platform.
- Maestro handles flaky field-network scenarios simply.

Negative:
- Two E2E tools and two sets of test scripts. (proposed — needs review)
- Maestro is installed as a CLI outside the pnpm workspace, so its version must be pinned in CI separately. (proposed — needs review)

## Alternatives rejected

- **Detox**: v1 alternative; banned in DEPENDENCIES.md.
- **Jest**: banned in DEPENDENCIES.md; use Vitest.
