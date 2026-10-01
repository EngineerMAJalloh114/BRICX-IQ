# 0033. Dependency updates: Dependabot, exact pins, grouped, never auto-merged

- Status: Accepted
- Date: 2026-10-01
- Deciders: Mohamed Abass Jalloh
- Source: DEPENDENCIES.md §7 ("Renovate (or Dependabot)"); ADR 0023; P1-06 ruling G1 (2026-10-01)

## Context

ADR 0023 pins exact versions and says "Renovate raises upgrades"; DEPENDENCIES.md allows Renovate or Dependabot. Updates must keep exact pins, be grouped, and never merge without the owner.

## Decision

- **Dependabot** (`.github/dependabot.yml`), weekly, for `npm` (the pnpm workspace, root directory) and `github-actions` (`.github/workflows` and `.github/actions/setup`). This amends ADR 0023: Dependabot, not Renovate, raises upgrades. ADR 0023's text is unchanged.
- **Exact pins:** `versioning-strategy: increase` writes the new exact version; `check:workspace` fails on any non-exact version (ADR 0031), so a range can never land.
- **Grouping:** npm minor and patch updates in one group; each npm major is its own PR, because a major needs an ADR review. All action updates in one group; Dependabot updates the SHA and its version comment together.
- **Never auto-merge:** Dependabot only opens PRs; no workflow, setting or app merges them. Their authors are `dependabot[bot]`, so the owner's approval counts under the review ruleset (docs/runbooks/github-settings.md).
- **Conventional titles:** prefixes `build(deps)` and `ci(deps)` pass the pr-title job.

## Consequences

Positive:
- Native to GitHub: no third-party app with write access and no extra token.
- Ranges and unlisted packages cannot land, whoever opens the PR.

Negative:
- Dependabot does not update version notes in docs/DEPENDENCIES.md, nor the gitleaks pin (`scripts/gitleaks-pin.mjs`); those stay manual. (for architect review)
- A Dependabot PR that needs a new transitive peer, or a new package name, fails `check:workspace` until DEPENDENCIES.md and an ADR are updated by hand. (for architect review)

## Alternatives rejected

- **Renovate (G2):** can update DEPENDENCIES.md through regex managers, but needs the Mend GitHub App with write access or a self-hosted workflow holding a write token.
