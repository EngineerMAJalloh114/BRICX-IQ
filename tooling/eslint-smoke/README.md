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
Rules for every package are proved in `packages/db`, which has no extra rule;
`packages/ids/src` holds only the `@bricx/ids` rules (no workspace package, npm
module or Node built-in; no `Date.now()`, `new Date()` or `Math.random()`),
and `packages/ids/test/allowed.ts` proves tests are exempt. `packages/validation`
(P3-04, ADR 0047) holds the `@bricx/validation` rules: its source may import
ids, money, i18n, its own `data/` and `zod` only; ids, money, i18n and domain
hold an `imports-validation-violation.ts`, and money an `imports-i18n-violation.ts`.
`packages/permissions` (P3-05, ADR 0048) holds the `@bricx/permissions` rules:
its source may import ids, `@casl/ability` and its own files, and i18n for
types only (`imports-i18n-value-violation.ts` fails); ids, money, i18n,
validation and domain hold an `imports-permissions-violation.ts`.
`packages/domain` (P3-06, ADR 0049) holds the `@bricx/domain` rules on its
`src/` only: its source may import ids, money, its own `data/` and i18n for
types only (`imports-i18n-value-violation.ts` fails), and
`packages/domain/test/allowed.ts` proves tests are exempt from the boundary
and clock rules.
`apps/api/src` (P4-01, ADR 0051) holds the `bricx/nest-modules` probes:
`nest-module-allowed.ts` (a decorated empty class) produces no error and
`static-class-violation.ts` (an undecorated static-only class) fails
`no-extraneous-class`.
`check-real.mjs` repeats the probes at the real package paths.
Files named `*-violation.*` must fail with the listed error; files named
`allowed.ts` are controls that must produce no error (domain → ids/money and i18n types,
module → another module's `public-api.ts`, `Date.now()` outside domain and
ids source, `Number(count)`, ids source → its own files, `new Date(value)`,
ids tests → Node, npm, money, `Date.now()`, `Math.random()`).

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

## Real workspace check (P3-01, ADR 0041)

`check-real.mjs` lints probe text with the repository's own
`eslint.config.mjs` at real paths in `packages/ids`. At
`packages/ids/src/uuid-v7.ts` it must report exactly: a Node built-in, an npm
module and a workspace package import (`../../config/src/api.js`, the real
package on disk), `Date.now()` and `Math.random()`. At
`packages/ids/test/generator.test.ts` it must report nothing, because tests
may use all of these. The proof through pnpm workspace links comes with
P3-02, the first package that depends on `@bricx/ids`. `turbo.json` adds the
`packages/ids` and `packages/config` files it depends on to the lint inputs.

## Running

```bash
pnpm --filter @bricx/eslint-smoke check:rules   # fixtures, then the real workspace check
```
