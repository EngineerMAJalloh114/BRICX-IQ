# 0037. Production audit ignores GHSA-vfj7-8cjw-p6xm (braces), for tooling only and until a fixed date

- Status: Accepted
- Date: 2026-10-06
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P1-06b; ADR 0023 (dependency policy), ADR 0031 (CI `security` job runs `pnpm audit --prod`); owner's decision "Ignore via ADR" and approval with changes 1–4 (2026-10-06)

## Ignored advisory

- Advisory: GHSA-vfj7-8cjw-p6xm
- Package: `braces`
- Revisit by: 2027-01-04

## Context

On 2026-10-06 the CI `security` job turned red on `main` and on every PR. `pnpm audit --prod` reports one advisory. It was published after `main` last passed. No dependency changed.

Verified on 2026-10-06 against the npm advisory service and the registry:

- **Advisory:** [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), "braces vulnerable to stack-exhaustion denial of service through deeply nested patterns".
- **Severity:** high (CVSS 3.1 7.5, `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H`).
- **Weakness:** CWE-674 (uncontrolled recursion).
- **Vulnerable versions:** `<=3.0.3`.
- **No patched release exists:** the advisory lists "Patched versions: <0.0.0". The latest `braces` is 3.0.3, published 2024-05-21, and it is the version we have.
- **How we reach it:** `pnpm audit` reports one path, `tooling__eslint > eslint-plugin-boundaries > micromatch > braces`. The importer is `@bricx/eslint-config`, the shared ESLint config, which `pnpm audit --prod` counts as production because the config package needs its plugins at runtime. No package under `apps/` or `packages/` has `braces` in its production closure. `pnpm ls -r --prod --depth Infinity` shows this, and the guard below checks it on every run.
- **Who controls the input:** the attack needs an attacker-controlled brace pattern, such as `{a,{b,{c,…}}}` nested thousands deep, passed to `braces` (through micromatch). Here micromatch receives:
  - the element and rule patterns in our own ESLint config (`tooling/eslint/index.mjs`);
  - templates in those patterns, filled from our own directory names;
  - our file paths, as the value being matched, not as the pattern.

  None of this is user input. The worst case is that someone commits a malicious pattern to the ESLint config, which makes their own lint run crash. Code review and CODEOWNERS already cover that file.

## Decision

- **Ignore exactly this advisory by id.** `pnpm-workspace.yaml` sets `auditConfig.ignoreGhsas: [GHSA-vfj7-8cjw-p6xm]`, and pnpm 10.34.6 honours it there. `package.json`'s `pnpm.auditConfig` is the fallback if a pnpm version stops reading it, and the guard rejects using both. Only `ignoreGhsas` is allowed: no `ignoreCves`, no severity, no audit level in `pnpm-workspace.yaml` or `.npmrc`. `pnpm audit --prod` still fails on any other advisory, including another one in `braces`.
- **Guard in `check:workspace`, proven by 24 fixtures in `scripts/guard-fixtures/audit-ignores/` on every run.** Each ignored id must meet all of these:
  - it is a well-formed GHSA id;
  - an Accepted ADR records it, with `- Advisory:`, `- Package:` and `- Revisit by:` lines;
  - **reachability:** the named package is not in the production closure of any importer under `apps/` or `packages/`. Workspace links are followed through the linked package's own production dependencies, and subtrees that `pnpm ls` prints once and marks `deduped` elsewhere are expanded from their full occurrence (one expanded nowhere fails). `tooling/*` and the root may reach it;
  - **expiry:** the guard fails after the `Revisit by` date and prints a warning during the last 30 days.

  The same checks run in `pnpm audit:prod` before the audit.
- **Revisit by 2027-01-04.** Extending the date needs an amendment to this ADR (a later `- Revisit by:` line, with the reason) or a new ADR. Either way it is a reviewed change, and the guard takes the latest date.
- **Loud on every audit run.** `pnpm audit:prod` prints `IGNORING GHSA-vfj7-8cjw-p6xm (braces) per docs/adr/0037-audit-ignore-braces.md, revisit by 2027-01-04` before the audit. pnpm's own summary then reports "(1 ignored)".
- **Remove the ignore** when a patched `braces` ships (Dependabot proposes the bump, ADR 0033), or when `eslint-plugin-boundaries` stops depending on it. If `braces` ever enters an `apps/` or `packages/` production closure, the guard fails, and the ignore must be replaced by a fix.

## Alternatives rejected

- **`pnpm.overrides` to a fixed version:** no patched version exists. Overriding to another major (`braces` 2.x is also vulnerable) or to a fork would mean an unreviewed package, which ADR 0023 forbids.
- **Dropping `--prod`:** this widens the audit to every dev dependency and does not remove this advisory. The red check stays.
- **Lowering the audit level (`--audit-level critical`):** this hides every future high advisory in every package to silence one in a lint plugin. One reviewed id with an expiry is narrower.
- **Waiting for a patch:** `main` and every PR stay red with no end date, so the `security` check stops meaning anything.
- **Excluding tooling packages from the production audit:** this hides every advisory in tooling, not only this one. It is a broader policy change than one dated ignore.

## Consequences

Positive:
- `security` is green again and still fails on every other advisory.
- The ignore cannot outlive its date, spread to runtime packages, or be added silently. Any new ignore needs its own ADR and is printed on every audit run.

Negative:
- A known high-severity denial-of-service stays in the lint toolchain until a fix ships. (for architect review)
- Vite bundles its own copy of `braces` into `vite/dist` (its LICENSE lists it), and the audit and this guard only see installed packages. Vite runs in tests and dev tooling only, on our own config. (for architect review)
- The reachability check reads `pnpm ls -r --prod --depth Infinity --json`. This adds about half a second to `check:workspace`, and its output format is pnpm's, so a pnpm major bump must re-run the fixtures. CI does that on every run. (for architect review)
- The `pnpm-workspace.yaml` reader is line-based, like the compose guard. Unusual YAML (flow style, anchors) is rejected rather than understood. (for architect review)
- Someone must act before 2027-01-04, or `pnpm verify` and CI fail on that date. The 30-day warning is the reminder. (for architect review)
