# 0028. Test harness: Vitest 5, pinned vite, swc preset

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P1-04; ADR 0023 (dependency policy); P1-04 rulings A1 and B1

## Context

STACK.md names Vitest with `unplugin-swc` for NestJS decorators, and DEPENDENCIES.md lists `vitest`, `@vitest/coverage-v8`, `unplugin-swc` and `@swc/core`, but no major version for any of them. On 2026-09-30 npm has Vitest 5.0.3 (`latest`; 5.0.0 was published on 2026-09-03) and 4.1.11 on the V4 tag. Both passed the same trial (projects, swc decorator metadata, path-keyed coverage thresholds).

In Vitest 5, `vite` moved from a dependency to a peer dependency. pnpm installs it automatically (`auto-install-peers=true`), but then no `package.json` names its version. Vitest 5 also no longer reads a `vitest.workspace.ts` file (deprecated in 3.2, removed in 4); projects are declared in the root config.

## Decision

- **Vitest 5.0.3** and **`@vitest/coverage-v8` 5.0.3** (always the same version) as exact root devDependencies. The root runs the `vitest` binary.
- **`vite` 8.3.1**, **`unplugin-swc` 2.0.0** (the only 2.x) and **`@swc/core` 1.16.13** as exact-pinned `dependencies` of `@bricx/vitest-config` (`tooling/vitest`). `apps/api` and `apps/worker` get swc through its `swcPreset` from P4.
- `tooling/vitest-smoke` fails if vitest resolves a different `vite` than the pinned one, so a bump of one without the other cannot pass `pnpm verify`.
- **`@swc/core`'s postinstall stays unapproved.** It only checks that the native binary loads and, if it does not, installs `@swc/wasm` from the network as a fallback. The binary arrives through the platform optional dependency (for example `@swc/core-linux-x64-gnu`), and every test passes without the script. `vite`, `rolldown` and `lightningcss` have no install scripts.
- `swcPreset` sets swc's decorator options itself (`tsconfigFile: false`, legacy decorators, `decoratorMetadata`), so it does not depend on each package's tsconfig.

## Consequences

Positive:
- One known Vitest, vite and swc version across the repo, raised by Renovate.
- NestJS constructor injection metadata (`design:paramtypes`) is emitted in tests, proven by a fixture with a control.

Negative:
- `vite` and `vitest` must be bumped together; the smoke check fails until they match.
- Vitest 5.0.x is four weeks old; early patch releases are likely.
- Vite 8's default (oxc) transform also emits decorator metadata when a tsconfig sets `emitDecoratorMetadata`. The swc preset stays the documented path for api/worker (STACK.md); P4 may revisit this with evidence.

## Alternatives rejected

- **Vitest 4.1.11:** the maintenance line; it would need a major upgrade soon after P4.
- **Leaving `vite` as an auto-installed peer:** its version would change silently whenever the lockfile is re-resolved.
- **`unplugin-swc` 1.6.0:** superseded by 2.0.0, which passes the same fixtures.
