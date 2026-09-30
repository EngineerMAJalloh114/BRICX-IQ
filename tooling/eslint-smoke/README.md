# @bricx/eslint-smoke

Private proof package for `@bricx/eslint-config`. It holds no product code.

`check.mjs` lints `fixtures/` with the real `bricxConfig` and compares the
result with `expected.json` (file, line, rule, message). It fails when:

- an expected error is missing,
- any other error or warning appears, including a parse error, or
- a fixture contains an `eslint-disable` / `eslint-enable` / `/* eslint */` comment.

It runs as part of this package's `lint` script, so `pnpm verify` and
`pnpm lint` guard the rules on every run.

## Layout

`fixtures/` is a small copy of the workspace layout that the boundaries rules
match on: `packages/{money,ids,db,domain}` and `apps/api/src/modules/{finance,ledger}`.
Files named `*-violation.*` must fail with the listed error; files named
`allowed.ts` are controls that must produce no error (domain → ids/money,
module → another module's `public-api.ts`, `Date.now()` outside domain,
`Number(count)`).

## Why a fixture cannot fail for the wrong reason

- `tsc --noEmit` (this package's `typecheck`) type-checks every fixture, so a
  fixture is valid TypeScript and cannot raise type-aware errors from broken
  code.
- `@bricx/*` resolves through tsconfig `paths` to the fixture packages, so no
  import is unresolved or `any`-typed (which would set off `no-unsafe-*` rules).
- Matching is exact: any error not in `expected.json` fails the check, so a
  fixture that trips a second rule is caught.
- Each rule has an allowed control, so a rule that blocks everything fails too.
- The repo's own lint ignores `fixtures/`; only `check.mjs` lints them.

Limitation: fixtures resolve through tsconfig `paths`, not real pnpm
workspace links. P3 must prove the boundaries on the real workspace layout.

## Running

```bash
pnpm --filter @bricx/eslint-smoke check:rules
```
