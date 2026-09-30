# 0023. Dependency policy: DEPENDENCIES.md is the allow-list

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/DEPENDENCIES.md (version policy, §11 banned list); CLAUDE.md

## Context

BRICX IQ is financially sensitive and fully auditable, and much of it is built by Claude Code sessions. Unreviewed packages, duplicate tools (a second styling library, ORM or state manager) and drifting versions make builds unreproducible and widen the supply-chain attack surface.

## Decision

1. **`docs/DEPENDENCIES.md` is the allow-list.** Every package in the repo must be listed there, per workspace and phase. The banned list (§11) names duplicates and conflicts that must not be added.
2. **Exact version pinning.** Versions in `package.json` are exact (no `^` or `~`); Renovate raises upgrades.
3. **Expo-managed packages** (`expo-*`, `react`, `react-native`, `react-native-*` in the Expo SDK) are installed with `npx expo install` so versions match the SDK. Their versions are never hand-picked.
4. **Any new dependency requires an ADR**, and the ADR updates DEPENDENCIES.md in the same PR.

## Enforcement

- `.npmrc` must contain `save-exact=true`. Implemented in **P0-02**. (P0-02's step 3 in ROADMAP.md does not list this line yet; it must be added when P0-02 is done.)
- CI must fail on any dependency not listed in DEPENDENCIES.md. Implemented in **P1: task to be added**. No P1 task in ROADMAP.md covers this today; P1-06 (CI skeleton) is the nearest.

## Consequences

Positive:
- No duplicate tools in the repo.
- Reproducible installs.
- Expo packages always match the SDK.

Negative:
- Adding any package, even a small utility, needs an ADR, which slows experiments. (architect-reviewed 2026-09-30)
- DEPENDENCIES.md must be kept in sync with every `package.json`; until the CI check exists, drift is caught only in review. (architect-reviewed 2026-09-30)
- Exact pins mean a steady stream of Renovate PRs to review. (architect-reviewed 2026-09-30)

## Alternatives rejected

- **Semver ranges (`^`/`~`)**: installs drift between machines and CI.
- **No allow-list, review-only control**: duplicate tools slip in unnoticed.
