# 0038. Override `handlebars` to 4.7.10 until eslint-plugin-boundaries ships a patched dependency

- Status: Accepted; amended by [0058](0058-openapi-document-generated-client.md) (an override key may also be one `parent>name` selector of two plain package names, pinning only that parent's copy; same ADR and DEPENDENCIES.md rules; every snapshot of the parent must resolve the pinned version, stale when the parent or the dependency is gone, never alongside a global override of the same name; first use `@nestjs/swagger>js-yaml` 5.4.3)
- Date: 2026-10-12
- Deciders: Mohamed Abass Jalloh
- Source: P1-06c (owner's brief and plan approval with conditions 1–4, 2026-10-12: A1 global override, B1 permanent override guard); ADR 0023 (dependency policy), ADR 0031 (CI `security` job), ADR 0037 (audit ignores)

## Override

- Override: `handlebars` 4.7.10
- Remove when: an `eslint-plugin-boundaries` release (and the `@boundaries/elements` release it depends on) requires `handlebars` 4.7.10 or later. Dependabot's grouped boundaries bump (ADR 0033) is the prompt: drop this override and this ADR line in that PR, and the guard proves the lockfile still holds no vulnerable version.

## Context

From 2026-10-12 the CI `security` job (`pnpm audit:prod`) is red on `main` and on every PR. Three advisories were published against `handlebars` 4.7.9. Checked on 2026-10-12 against the npm advisory service:

| Advisory | Severity | CWE | Vulnerable |
|---|---|---|---|
| [GHSA-p8wg-vrv2-v86f](https://github.com/advisories/GHSA-p8wg-vrv2-v86f), JavaScript injection via own property check bypass | critical | CWE-184, CWE-1289 | `>=3.0.0 <=4.7.9` |
| [GHSA-8r5x-fm3f-whwj](https://github.com/advisories/GHSA-8r5x-fm3f-whwj), JavaScript injection via AST type confusion in `compile` (CVSS 3.1 9.8) | critical | CWE-94, CWE-843 | `>=4.0.0 <=4.7.9` |
| [GHSA-xw65-4hp5-5hc7](https://github.com/advisories/GHSA-xw65-4hp5-5hc7), JavaScript injection via unsafe inline embedding of precompiled templates (CVSS 3.1 4.7) | moderate | CWE-116 | `>=4.0.0 <=4.7.9` |

- **How we reach it:** `tooling/eslint` (`@bricx/eslint-config`) > `eslint-plugin-boundaries` 7.2.0 > `handlebars`, and > `@boundaries/elements` 3.1.1 > `handlebars`. Both pin `handlebars` **exactly** at 4.7.9, so a normal update cannot move it. They use it to compile message and pattern templates from our own ESLint config, not user input.
- **No upstream fix:** `eslint-plugin-boundaries` 7.2.0 (2026-08-09) is the latest release, and every 7.x release pins `handlebars` 4.7.9. `@boundaries/elements` 3.1.1 (2026-08-09) is its latest release and pins it too.
- **Patched release:** `handlebars` 4.7.10, the npm `latest`. It has the same dependencies as 4.7.9 (only the `minimist` floor moves to `^1.2.8`, which the lockfile already resolves) and no install scripts.

### 7-day rule (each new version at least 7 days old)

Checked against the npm registry at install time:

- Published: **2026-10-05T22:37:37.837Z**.
- Seven full days ended: 2026-10-12T22:37:37.837Z.
- Registry re-checked and `pnpm install` run: **2026-10-12T22:47:13Z**. The release was 7 days 9 minutes 35 seconds old.
- **It passed with a margin of only minutes (9 min 35 s), not days.** (for architect review)
- Integrity (registry `dist.integrity`, equal to the `pnpm-lock.yaml` resolution): `sha512-P5VJMVM7qgBn6vjXMw8WG9uVI+ncf2pi72j4de4yz5ZULLj2RGqLYaKOYGsgyrViQ0tePOVlN1tDCCXXtFqXKg==`. Tarball `https://registry.npmjs.org/handlebars/-/handlebars-4.7.10.tgz`, shasum `12419ea1b41391b3ffcf003f2164dcbce090c417`.

## Decision

- **One global, exact override** in `pnpm-workspace.yaml`: `overrides: handlebars: 4.7.10` (A1). It covers both paths and any future one. pnpm 10.34.6 honours it there and records it in `pnpm-lock.yaml`'s `overrides:` block. The lockfile change is only `handlebars` 4.7.9 → 4.7.10.
- **No audit ignore.** `auditConfig.ignoreGhsas` still lists only the braces id (ADR 0037). If an advisory is fixed by an override, it is never also ignored.
- **Guard in `check:workspace`, proven on every run by 20 fixtures in `scripts/guard-fixtures/overrides/`** (B1). Every override must meet all of these:
  - its key is a plain package name (no `a>b` selectors, no `name@range` keys) and its value is an exact version (no `^`, `~`, range or dist-tag);
  - it is set only in `pnpm-workspace.yaml`, a block mapping, one package per line. `package.json`'s `pnpm.overrides` and `resolutions` (which pnpm also reads) fail;
  - an Accepted ADR records it with a `- Override: \`name\` version` line at the same version, and a non-empty `- Remove when:` line;
  - its package is listed in `docs/DEPENDENCIES.md` (an override is a dependency, ADR 0023);
  - `pnpm-lock.yaml` resolves that version and no other version of the package;
  - **stale:** it fails if the package is no longer in `pnpm-lock.yaml` at all.

  `pnpm audit:prod` runs the same checks before the audit and prints `OVERRIDE handlebars 4.7.10 per docs/adr/0038-override-handlebars.md`.
- **What keeps it honest after it ships:** the guard fails `pnpm verify` and CI if the override drifts, loosens, loses its ADR or row, or outlives its package. The CI `security` job still fails on any new `handlebars` advisory, including one against 4.7.10. A Dependabot bump of the boundaries group that brings a patched pin makes the override redundant, and the "Remove when" line says to drop it then.

## Alternatives rejected

- **Upgrade `eslint-plugin-boundaries`:** there is no newer release, and every 7.x release pins `handlebars` 4.7.9.
- **Scoped overrides (`eslint-plugin-boundaries>handlebars`, `@boundaries/elements>handlebars`; A2):** these must be kept in step with the plugin's internal layout, and a third path would stay vulnerable. Nothing else in the workspace uses `handlebars`, so a global override changes nothing else.
- **Ignore the three advisories with a dated ADR, as ADR 0037 does:** a patched release exists, so ignoring would keep known-vulnerable code for no reason. The owner ruled out an ignore for this task.
- **Wait for a boundaries release:** `main` and every PR stay red with no end date.

## Consequences

Positive:
- `security` is green again on `main` with no new ignore. The audit's only ignore is still braces (ADR 0037).
- Every future override needs an ADR, a removal trigger, an exact version and a DEPENDENCIES.md row, and it cannot linger once its package is gone.

Negative:
- We run `handlebars` 4.7.10 under plugins that declare and test against 4.7.9 exactly. The eslint-smoke fixtures exercise `eslint-plugin-boundaries` on every `pnpm verify`, but they do not cover every template feature. (for architect review)
- 4.7.10 cleared the 7-day rule by 9 minutes 35 seconds, so it had less community exposure than the rule normally gives. (for architect review)
- The lockfile reader is line-based (keys of the `packages:` and `snapshots:` sections), so a pnpm lockfile format change must re-run the fixtures. CI does that on every run. (for architect review)
- Someone must remove the override when boundaries catches up, or the stale-override check fails if the package later leaves the tree. Until then, Dependabot cannot move `handlebars` past 4.7.10 on its own: a later patch needs this ADR line and the override changed together. (for architect review)
