# 0044. Dependabot cooldown of 7 days

- Status: Accepted
- Date: 2026-10-13
- Deciders: Mohamed Abass Jalloh
- Source: maintenance task "Dependabot cooldown" requirements 1–5 and plan approval D1–D4 with conditions 1–3 (2026-10-13); ADR 0023 (7-day rule); ADR 0033; PR #31 follow-up

Amends ADR 0033.

## Context

ADR 0023 accepts a release only when it is at least 7 days old. ADR 0033 set up Dependabot without a cooldown, so GitHub's default applied. GitHub documents that default as 3 days: Dependabot will "Apply a default cooldown period of 3 days to version updates, even when `cooldown` is not configured" ([Dependabot options reference](https://docs.github.com/en/code-security/dependabot/working-with-dependabot/dependabot-options-reference)). Dependabot #24 and #30 therefore proposed vite 8.3.4 (5 days old) and prettier 3.9.10 (3 days old), both under the 7-day rule; PR #31 had to leave them out by hand.

What the documentation says (read 2026-10-13, same page):

- The `cooldown` keys are `default-days`, `semver-major-days`, `semver-minor-days`, `semver-patch-days`, `include` and `exclude`; "The `exclude` list always take precedence over the `include` list."
- "The `default-days` option is supported for all package managers listed," and the support table marks GitHub Actions with a check in the default-days column; NPM and Yarn are listed too.
- "The `cooldown` option is only available for *version* updates, not *security* updates." The default "does not apply to security updates" either.
- The [changelog of 2026-07-14](https://github.blog/changelog/2026-07-14-dependabot-version-updates-introduce-default-package-cooldown/): "Security updates still open immediately".

`.github/dependabot.yml` configures two ecosystems, `npm` and `github-actions`. No `docker` or `docker-compose` ecosystem is configured.

## Decision

- **`cooldown: default-days: 7`** on every configured ecosystem (`npm`, `github-actions`). `default-days` covers major, minor and patch releases alike; no `semver-*-days` is set (approved D1).
- **No `include` or `exclude` list**: every dependency waits (approved D2).
- **Security updates are not delayed.** That is Dependabot's behaviour, not a setting: the cooldown applies to version updates only.
- **Guard in `check:workspace`** (approved D3): `dependabotProblems` in `scripts/guards.mjs` reads `.github/dependabot.yml` line by line and fails when an `updates` entry has no `cooldown`, when `default-days` is missing, not a plain integer or below 7, when any `semver-*-days` is below 7, when `include`, `exclude` or an unknown key appears under `cooldown`, and when the file is missing or cannot be read (tabs, flow style, anchors and aliases, several documents, unexpected indentation, a top-level key other than `version` and `updates`). An ecosystem added later without a cooldown therefore fails. 26 fixtures in `scripts/guard-fixtures/dependabot/` prove each rule; three of them are invalid YAML on purpose and are listed in `.prettierignore`.
- ADR 0033's text is unchanged; only its status line records this amendment.

## Consequences

Positive:
- Dependabot proposes nothing the 7-day rule would reject, so its PRs no longer need releases removed by hand.
- The cooldown cannot be dropped or shortened without `check:workspace` failing.

Negative:
- A cooldown delays patch releases of non-security updates by 7 days. (for architect review)
- A fix shipped as an ordinary release, without a GitHub advisory, waits 7 days like any other release; only an advisory triggers a security update. (for architect review)
- The guard rejects any top-level key other than `version` and `updates`, so adding `registries` (a private registry) later needs a guard change in the same PR. (for architect review)
- Dependabot reads the configuration from the default branch only; whether GitHub accepts it is visible after the merge, not in this PR's CI. (for architect review)
- The Semgrep image and gitleaks pins are outside Dependabot's view; their bumps stay manual (ADR 0033, ADR 0043).

## Alternatives rejected

- **Per-SemVer days (D1 B):** setting `semver-major-days`, `semver-minor-days` and `semver-patch-days` to 7 repeats `default-days` and would only apply to ecosystems that use SemVer.
- **Keeping GitHub's 3-day default:** it contradicts ADR 0023.
