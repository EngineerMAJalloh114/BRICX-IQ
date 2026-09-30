# @bricx/tsconfig-smoke

Private proof package for `@bricx/tsconfig`. It holds no product code.

Each tsconfig here extends a shared config **by package name**, the way real
packages will, and type-checks one empty file (`src/empty.ts`):

| File | Extends |
|------|---------|
| `tsconfig.json` | `@bricx/tsconfig/base.json` |
| `tsconfig.node.json` | `@bricx/tsconfig/node.json` |
| `tsconfig.web.json` | `@bricx/tsconfig/web.json` |
| `tsconfig.react-native.json` | `@bricx/tsconfig/react-native.json` |

## Running the checks

- `pnpm -r exec tsc --noEmit` (P1-01 Verify) runs `tsc` in every workspace
  package with its default `tsconfig.json`, so it covers **base** here.
- All four configs:

  ```bash
  pnpm --filter @bricx/tsconfig-smoke check:configs
  ```

The node, web and react-native checks get wired into the Turborepo
`typecheck` task at P1-02.
