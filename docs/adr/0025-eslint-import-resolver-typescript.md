# 0025. Add `eslint-import-resolver-typescript` for import boundaries

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P1-03 step 2; ADR 0023 (dependency policy); P1-03 ruling A

## Context

P1-03 enforces import boundaries with `eslint-plugin-boundaries` 7.2.0: `packages/*` never import `apps/*`, `packages/domain` imports only `@bricx/ids` and `@bricx/money`, and an api module imports another module only through its `public-api.ts`.

The plugin's bundled resolver (`eslint-import-resolver-node`) does not read package `exports` and cannot map a TypeScript `./x.js` import to `x.ts`. In a scratch workspace it classified `@bricx/money` as an external npm package and missed a relative import from a package into an app. The boundary rules then pass for the wrong reason.

## Decision

- Add **`eslint-import-resolver-typescript`**, exact-pinned at **4.4.5** (ISC), as a dependency of `@bricx/eslint-config` (`tooling/eslint`), and list it in DEPENDENCIES.md §1.
- `@bricx/eslint-config` sets it as the `import/resolver`, reading every workspace package's `tsconfig.json`.
- Its native dependency `unrs-resolver` ships a `postinstall` script. It stays **unapproved** in pnpm (not in `onlyBuiltDependencies`); the prebuilt platform binary installs through optional dependencies and linting works without the script. pnpm prints an "Ignored build scripts" warning on install.

## Consequences

Positive:
- Boundaries are checked on resolved file paths, so deep imports (`@bricx/money/src/x`) and relative imports are caught, not only bare package names.
- `tooling/eslint-smoke` proves every boundary with a violation fixture and an allowed control.

Negative:
- One more native binary in the supply chain (`unrs-resolver`, via platform-specific optional packages).
- The smoke fixtures resolve `@bricx/*` through tsconfig `paths`, not through real pnpm workspace links. P3 must prove the boundaries on the real workspace layout.

## Alternatives rejected

- **Bundled node resolver:** misses `exports`, `.js`→`.ts` and relative cross-package imports (shown in P1-03 scratch tests).
- **Matching by package name only (no resolver):** no new dependency, but misses deep and relative imports.
- **`import/no-restricted-paths` (eslint-plugin-import):** a second import plugin next to `eslint-plugin-boundaries`, which DEPENDENCIES.md already chose.
