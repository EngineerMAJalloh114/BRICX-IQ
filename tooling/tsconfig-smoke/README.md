# @bricx/tsconfig-smoke

Private proof package for `@bricx/tsconfig`. It holds no product code.

Each tsconfig here extends a shared config **by package name**, the way real
packages will, and type-checks one empty file (`src/empty.ts`):

| File                         | Extends                             |
| ---------------------------- | ----------------------------------- |
| `tsconfig.json`              | `@bricx/tsconfig/base.json`         |
| `tsconfig.node.json`         | `@bricx/tsconfig/node.json`         |
| `tsconfig.web.json`          | `@bricx/tsconfig/web.json`          |
| `tsconfig.react-native.json` | `@bricx/tsconfig/react-native.json` |

## Running the checks

- `pnpm verify` (or `pnpm typecheck`) runs the Turborepo `typecheck` task,
  which runs `check:configs` here, so **all four** configs are checked.
- `pnpm -r exec tsc --noEmit` (P1-01 Verify) runs `tsc` in every workspace
  package with its default `tsconfig.json`, so it covers **base** only.
- All four configs directly:

  ```bash
  pnpm --filter @bricx/tsconfig-smoke check:configs
  ```

Every `tsc -p` call passes `--noEmit`: when a config's `extends` cannot be
resolved, `tsc` falls back to default options and would otherwise emit
`src/empty.js`.
