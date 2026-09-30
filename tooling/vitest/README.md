# @bricx/vitest-config

Shared Vitest presets for BRICX IQ (ROADMAP P1-04, ADR 0028). Each package
that has tests adds a `vitest.config.mts` and a `test` script:

```ts
// packages/money/vitest.config.mts
import { defaultPreset } from "@bricx/vitest-config";

export default defaultPreset({ packageDir: import.meta.dirname });
```

```json
{ "scripts": { "test": "vitest run --coverage" } }
```

| Export               | What it does                                                                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defaultPreset`      | Tests in `src/` and `test/` (`*.test.*`, `*.spec.*`); v8 coverage over every `src/` file, tested or not                                                |
| `swcPreset`          | `defaultPreset` plus `unplugin-swc`: legacy decorators and decorator metadata (`design:paramtypes`) for NestJS in `apps/api` and `apps/worker` from P4 |
| `coverageConfig`     | The v8 coverage block; the root `vitest.config.mts` uses it for whole-repo runs                                                                        |
| `coverageThresholds` | Line thresholds: 70% everywhere, 95% under `STRICT_PATHS` (`packages/money`, `packages/permissions`, `apps/api/src/modules/ledger`)                    |

## Thresholds keyed by path

Vitest matches a glob threshold against file paths relative to the run's
root. `coverageThresholds` rewrites each strict path relative to that root,
so the same rule applies wherever the run starts:

| Run root         | Strict glob                                                                      |
| ---------------- | -------------------------------------------------------------------------------- |
| `packages/money` | `**` (the whole package)                                                         |
| `apps/api`       | `src/modules/ledger/**`                                                          |
| repo root        | `packages/money/**`, `packages/permissions/**`, `apps/api/src/modules/ledger/**` |

A new package under a strict path gets 95% as soon as it exists; nothing
needs configuring. The global 70% counts every file, strict ones included.

## Rules

- A run with no test files fails. Vitest's pass-on-no-tests option is banned:
  `check:workspace` fails if it appears in any `package.json` or Vitest/Vite config.
- Every package under `apps/` and `packages/` needs a `test` script
  (`check:workspace`); `tooling/` is exempt.
- Turbo test inputs include `tooling/vitest/*.{mjs,json}` and `pnpm-lock.yaml`,
  so a preset change or any dependency change re-runs every package's tests.

Every behaviour is proven in [`tooling/vitest-smoke`](../vitest-smoke/README.md).
