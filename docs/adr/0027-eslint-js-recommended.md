# 0027. Adopt `@eslint/js` recommended for JS/.mjs files

- Status: Accepted; amended by [ADR 0029](0029-adopt-eslint-10.md) (2026-10-01): `@eslint/js` major must equal `eslint` major, replacing "same version"
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P1-03; ADR 0023 (dependency policy); P1-03 ruling C

## Context

typescript-eslint's `strict-type-checked` set covers TypeScript rules only. It relies on ESLint's core rules for everything else, and those rules ship in `@eslint/js`, which DEPENDENCIES.md did not list. The repo already has JS/.mjs files that must be linted: `tooling/eslint/index.mjs`, `tooling/eslint-smoke/check.mjs`, `scripts/check-workspace-scripts.mjs` and the root `eslint.config.mjs`. ADR 0023 requires an ADR for every new dependency.

## Decision

- Add **`@eslint/js`** as an exact-pinned dependency of `@bricx/eslint-config` (`tooling/eslint`). Its version always matches `eslint` (**9.39.5**), because it is ESLint's own rule package.
- `bricxConfig` applies `js.configs.recommended` to TS and JS/.mjs files. JS files are also type-checked through `checkJs`, so `no-undef` is off for them and TypeScript reports undefined names instead.
- `tooling/eslint-smoke` proves it with a fixture (`no-debugger` in a `.mjs` file).

## Consequences

Positive:
- ESLint core rules (for example `no-debugger` and `no-dupe-keys`) apply to every JS and TS file.
- Config and script files get the same lint gate as source code.

Negative:
- `@eslint/js` must be bumped in step with `eslint`, including at the ESLint 10 decision in pending.md.

## Alternatives rejected

- **typescript-eslint only:** leaves JS/.mjs files without core rules.
- **Relying on the copy of `@eslint/js` that `eslint` installs itself:** it is a phantom dependency under pnpm, with no pinned version of its own.
