# @bricx/vitest-smoke

Private proof package for `@bricx/vitest-config`. It holds no product code.

Its `test` script runs its own passing tests (`src/sum.test.ts`, and
`src/presets.test.ts`, which checks the presets' timeouts) with coverage,
then `check.mjs`. `check.mjs` runs every fixture in `fixtures/` in its own
`vitest run --coverage` (or the entry's own `args`) with the real presets and compares the exit code and
output with `expected.json`. It fails when:

- any outcome differs from `expected.json` (exit code, required text, forbidden text),
- a fixture has no entry in `expected.json`, or an entry has no fixture, or
- vitest resolves a different `vite` than the one `@bricx/vitest-config` pins.

It runs as part of `pnpm test` and `pnpm verify`.

## Fixtures

Each case is a small copy of the workspace layout; its `vitest.config.mts`
passes the case directory as `workspaceRoot`, so strict paths resolve inside
the fixture.

| Case                       | Setup                                                                | Must                               |
| -------------------------- | -------------------------------------------------------------------- | ---------------------------------- |
| `strict-money-below`       | `packages/money` at 80% lines                                        | fail on the 95% rule, not on 70%   |
| `strict-money-no-flag`     | `packages/money` at 80%, run as plain `vitest run` (no `--coverage`) | fail on the 95% rule               |
| `strict-money-meets`       | `packages/money` at 100%                                             | pass                               |
| `strict-permissions-below` | `packages/permissions` at 80%                                        | fail on the 95% rule               |
| `strict-ids-below`         | `packages/ids` at 80% lines (P3-01)                                  | fail on the 95% rule, not on 70%   |
| `strict-validation-below`  | `packages/validation` at 80% lines (P3-04)                           | fail on the 95% rule, not on 70%   |
| `strict-domain-below`      | `packages/domain` at 80% lines (P3-06)                               | fail on the 95% rule, not on 70%   |
| `strict-ledger-below`      | `apps/api`: ledger module at 80%, another module at 100%             | fail on `src/modules/ledger/**`    |
| `loose-meets`              | `packages/i18n`, same code and test as `strict-money-below`          | pass                               |
| `loose-below`              | `packages/i18n` at 44% (one file never tested)                       | fail on the global 70%             |
| `swc-metadata`             | `apps/api` with `swcPreset`, NestJS-style injection                  | pass (`design:paramtypes` emitted) |
| `swc-control`              | the same code and test with `defaultPreset`                          | fail (no metadata)                 |
| `zero-tests`               | `packages/ids` with no test files                                    | fail                               |
| `unit-timeout-default`     | `packages/i18n`, one correct test that takes 5.5 s                   | pass (`defaultPreset` 60 s)        |
| `unit-timeout-swc`         | the same test in `apps/api` with `swcPreset`                         | pass (inherits 60 s)               |
| `unit-timeout-control`     | the same test with Vitest's 5000 ms default put back                 | fail (`Test timed out in 5000ms`)  |

The swc fixtures stub `Reflect.metadata` in the test instead of loading
`reflect-metadata`, and their tsconfig turns on legacy decorators but not
`emitDecoratorMetadata`. Vite's default transform follows that tsconfig, so
the control compiles and fails only on the missing metadata; `swcPreset`
ignores tsconfig and emits it.

`tsc --noEmit` (this package's `typecheck`) and `eslint` also cover the
fixtures, so a fixture cannot fail for a type or syntax error.

## Running

```bash
pnpm --filter @bricx/vitest-smoke test            # own test + all fixtures
pnpm --filter @bricx/vitest-smoke check:outcomes  # fixtures only
```
