# 0026. TypeScript stays on 5.9.x

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/adr/pending.md (TypeScript major row); ROADMAP.md P1-01 and P1-03

## Context

P1-01 pinned TypeScript 5.9.3, the latest 5.x, and recorded the major version as a pending decision needed by P1-03, because typescript-eslint limits which TypeScript versions it supports. On 2026-09-30 npm has TypeScript 5.9.3, 6.0.3 and 7.0.2 (`latest`).

Evidence from P1-03 (Node 24.21.0, eslint 9.39.5, typescript-eslint 8.71.0, type-aware rules on):

| TypeScript | typescript-eslint 8.71.0 | Result |
|---|---|---|
| 5.9.3 | inside peer range `>=4.8.4 <6.1.0` | Works |
| 6.0.3 | inside peer range | Works; identical type-aware errors to 5.9.3 |
| 7.0.2 | outside peer range (canary has the same range) | npm refuses the peer. Forced install: ESLint crashes with "typescript-eslint does not support TS 7.0" (tracking issue typescript-eslint#10940) |

## Decision

- **Stay on TypeScript 5.9.x** (5.9.3 pinned). DEPENDENCIES.md's baseline "TypeScript 5.x" is unchanged.
- **Revisit trigger:** typescript-eslint supports TypeScript 7 (issue #10940). Moving to 6.x alone is not planned: it gains nothing for linting and would change the 5.x baseline.

## Consequences

Positive:
- Type-aware linting (strict-type-checked) works on a supported, tested combination.
- One compiler version for `tsc` and ESLint.

Negative:
- The repo does not get TypeScript 7's faster native compiler until typescript-eslint supports it.

## Alternatives rejected

- **TypeScript 6.0.x:** works, but gives no benefit to lint or build today and breaks the 5.x baseline.
- **TypeScript 7.0.x:** typescript-eslint 8.71.0 refuses to run with it.
