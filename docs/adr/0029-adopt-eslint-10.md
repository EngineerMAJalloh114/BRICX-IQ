# 0029. Adopt ESLint 10

- Status: Accepted
- Date: 2026-10-01
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P1-03b; pending.md "ESLint major" row; ADR 0023 (dependency policy); ADR 0027 (amended here); P1-03b rulings A, B and C

## Context

P1-03 pinned ESLint 9.39.5 and left the major version open in pending.md, needed before P3. On 2026-10-01 npm has `eslint` 10.11.0 (`latest`) and 9.39.5 (`maintenance`), and marks 9.39.5 deprecated: "This version is no longer supported."

ESLint 10 supports Node `^20.19.0 || ^22.13.0 || >=24`, so it runs on our Node 24 (ADR 0015).

ESLint 10 no longer depends on `@eslint/js`, and `@eslint/js` now has its own version numbers. The newest `@eslint/js` is 10.0.1, with a peer range of `eslint ^10.0.0`. ADR 0027's rule that `@eslint/js` has "the same version as eslint" can no longer hold.

Declared `eslint` peer ranges of the versions already pinned (none of them changes):

| Package | Version | `eslint` peer range |
|---|---|---|
| typescript-eslint | 8.71.0 | `^8.57.0 \|\| ^9.0.0 \|\| ^10.0.0` (10 added in 8.56.0) |
| eslint-plugin-boundaries | 7.2.0 | `>=6.0.0` |
| eslint-config-prettier | 10.1.8 | `>=7.0.0` |
| eslint-import-resolver-typescript | 4.4.5 | `*` |

Only typescript-eslint names 10 explicitly. For eslint-plugin-boundaries, the architect's evidence is its CHANGELOG entry for 6.0.1 (2026-03-20), issue #438: "Fix createConfig helper types when used in ESLint v10.x; compatible with eslint v9 and v10." Our pinned 7.2.0 includes that change. Its rules read `context.filename`, the replacement for the `context.getFilename()` that ESLint 10 removed. Its dependency `eslint-module-utils` 2.12.1 calls the removed methods only as a fallback when `context.filename` / `context.sourceCode` are missing, so on ESLint 10 it never reaches them.

A trial in a scratch clone (Node 24.21.0) with only the version bump passed `pnpm verify`. eslint-smoke passed 17 of 17 with `expected.json` unchanged. The three rules that ESLint 10 adds to recommended (`no-unassigned-vars`, `no-useless-assignment`, `preserve-caught-error`) were active and fired on no existing code. A fresh lockfile resolution with `strict-peer-dependencies=true` reported no peer issues.

## Decision

- **`eslint` 10.11.0**, exact, as a root devDependency and as the `@bricx/eslint-config` peer.
- **`@eslint/js` 10.0.1**, exact, as a dependency of `@bricx/eslint-config`.
- The other ESLint packages stay at their pins: typescript-eslint 8.71.0, eslint-plugin-boundaries 7.2.0, eslint-config-prettier 10.1.8 and eslint-import-resolver-typescript 4.4.5. No config change is needed.
- **Amends ADR 0027:** "`@eslint/js` major must equal `eslint` major" replaces "same version". `check:workspace` enforces it, and it also fails when the root `eslint` pin differs from the `@bricx/eslint-config` peer.
- `tooling/eslint-smoke` gains a fixture for `no-useless-assignment`, a rule new in ESLint 10's recommended set. If the config ever falls back to the ESLint 9 rule set, `pnpm verify` fails.

## Consequences

Positive:
- We pin a supported ESLint release instead of a deprecated one.
- Three more core rules apply to every JS and TS file.
- The `@eslint/js` / `eslint` pairing is checked on every `pnpm verify`, not only in review.

Negative:
- Residual risk: eslint-plugin-boundaries' own e2e suite pins eslint 9.37, so the plugin's maintainers do not test it on ESLint 10. This is mitigated by our 5 boundary fixtures in eslint-smoke, which pass on ESLint 10.
- eslint-config-prettier and eslint-import-resolver-typescript admit ESLint 10 only through open peer ranges (`>=7.0.0`, `*`), with no stated ESLint 10 support. eslint-smoke is the only proof that they work. (architect-reviewed 2026-10-01)
- `@eslint/js` bumps no longer follow `eslint` bumps automatically. A patch to one does not imply a patch to the other. (architect-reviewed 2026-10-01)

## Revisit trigger

Revisit if any eslint-plugin-boundaries release narrows its `eslint` peer range. The same applies to the other three plugins: any release whose peer range no longer includes ESLint 10.

## Alternatives rejected

- **Stay on ESLint 9.39.x:** that release is deprecated by npm, and every dependency already admits 10.
- **Keep "`@eslint/js` same version as `eslint`":** impossible, because no `@eslint/js` 10.11.0 exists.
