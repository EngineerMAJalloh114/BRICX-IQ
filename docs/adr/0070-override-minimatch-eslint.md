# 0070. Override `minimatch` to 11.0.1 for the ESLint toolchain until ESLint and its dependencies accept a fixed release

- Status: Accepted
- Date: 2026-11-04
- Deciders: Mohamed Abass Jalloh
- Source: maintenance chore, no ROADMAP id (owner's condition C1, 2026-11-04: fold GHSA-g3hv-75wg-m249 into the deepmerge PR. Try an ADR 0038 override to `minimatch` 11.0.1 first and keep it if lint and `pnpm verify --force` stay green; otherwise write a tooling-only ignore); ADR 0023 (dependency policy), ADR 0038 (overrides, amended by ADR 0058 for scoped `parent>name` keys), ADR 0069 (the same PR)

## Override

- Override: `eslint>minimatch` 11.0.1
- Override: `@eslint/config-array>minimatch` 11.0.1
- Override: `@typescript-eslint/typescript-estree>minimatch` 11.0.1
- Remove when: `eslint`, `@eslint/config-array` and `@typescript-eslint/typescript-estree` releases we adopt each declare a `minimatch` range that includes 11.0.1 or later, or 10.x gets a fixed release. Dependabot's grouped ESLint bumps (ADR 0033) are the prompt. Drop these three keys and these lines in that PR. `pnpm audit:prod` then proves no vulnerable `minimatch` is left in the production audit.

## Context

On 2026-11-04 `pnpm audit --prod` reported a second advisory next to the deepmerge one (ADR 0069):

- **Advisory:** [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), "minimatch has potential denial of service via globparts amplification" (CWE-405), moderate.
- **Vulnerable:** `<11.0.1`. **Fixed:** 11.0.1, published 2026-10-27T22:26:03Z. A fix exists, so this is an override, not an ignore.
- **How we reach it:** `tooling__eslint > eslint > minimatch` 10.2.6. The same 10.2.6 copy is also used by `@eslint/config-array` 0.23.5 (`^10.2.4`) and `@typescript-eslint/typescript-estree` 8.71.1 (`^10.2.2`). `eslint` 10.12.0 declares `^10.2.5`. None of these ranges admits 11.x, and no 10.x fix exists, so only an override reaches the fix.
- **Who controls the input:** ESLint's glob patterns come from our own `eslint.config.mjs`, our shared config and our file paths. Nothing user-controlled reaches it, and no package under `apps/` or `packages/` has this copy in its production closure.

Checked on 2026-11-04 against the registry:

- `minimatch` 11.0.1: licence BlueOak-1.0.0, no install scripts, integrity `sha512-t+Vn6DX4wPCxS23y03C0uhF7S1jpi1GfqPrnlEipCJaA2ykiNbMkVlDutZtmvLfRcUN6R8AYVlzTsQrT4RZoLQ==`.
- Its dependencies:
  - `brace-expansion` 5.0.12: already in the lockfile, MIT, published 2026-09-14.
  - `@isaacs/nonrecursive-glob-match` 1.0.2: new, BlueOak-1.0.0, no dependencies, no install scripts, published 2026-10-28T01:01:43Z, integrity `sha512-GJPHIgPPtFl+nLhFHyF0zZoFcOFLsZWbHFFzo+Zr+PWDXJbl9hHxb2w+9SiF2fHmLgKaXIpUzQo3SbBBZ9WObw==`.
- All of these passed the 7-day rule at install time (`pnpm install --config.minimumReleaseAge=10080`).

## Decision

- **Three scoped overrides** (ADR 0038 as amended by ADR 0058), one for each parent that resolved `minimatch` 10.2.6: `eslint>minimatch`, `@eslint/config-array>minimatch` and `@typescript-eslint/typescript-estree>minimatch`, each 11.0.1.
  - Not a global `minimatch` override. That would also replace 5.1.9 (`readdir-glob`) and 9.0.9 (`glob`) under `testcontainers`. Those are dev-only, outside the production audit, and use older APIs.
  - The lockfile now holds `minimatch` 5.1.9, 9.0.9 and 11.0.1, and no 10.2.6.
- **Proof that 11.0.1 works for the toolchain:** with the override installed, `pnpm turbo run typecheck lint test typecheck:root lint:root format:check i18n:check --force --continue` passed 58 of 58 tasks with none cached. This includes every package's lint, `lint:root` and `@bricx/eslint-smoke`, whose fixtures check that each expected lint error still fires. `pnpm verify --force` then passed on the committed head. So the fallback named in the owner's condition (a tooling-only ignore under ADR 0037 rules) is not needed.
- **DEPENDENCIES.md** gets a `minimatch` row. The three overrides are printed on every `pnpm audit:prod` run (`OVERRIDE eslint>minimatch 11.0.1 per …`).

## Alternatives rejected

- **A tooling-only ignore under ADR 0037 rules:** the owner's fallback for the case where the override broke lint or verify. It did not, and a fix that exists beats an ignore.
- **A global `minimatch` override:** too wide (see above).
- **Waiting for ESLint to widen its range:** `main` and every PR stay red with no end date.

## Consequences

Positive:
- `pnpm audit:prod` is green again, together with ADR 0069. The production audit holds no vulnerable `minimatch`.

Negative:
- ESLint and two of its dependencies run on a major version of `minimatch` their ranges do not declare. The lint suites and `@bricx/eslint-smoke` are the evidence. A subtle glob-matching change in rarely used patterns would show up as files missing from lint, which the smoke fixtures do not fully cover. (architect-reviewed 2026-11-05)
- One new transitive package, `@isaacs/nonrecursive-glob-match`, from the same author as `minimatch`. (architect-reviewed 2026-11-05)
