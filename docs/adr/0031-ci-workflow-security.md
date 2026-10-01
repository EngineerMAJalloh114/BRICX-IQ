# 0031. CI workflow: security rules, pinned actions and local-only Turbo cache

- Status: Accepted
- Date: 2026-10-01
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P1-06; ADR 0023 (dependency policy); ADR 0030 (gitleaks, "CI is the gate"); P1-06 rulings A1, C1, D1, E1, F1, H1, I1, J1, K1, M1 and additions 1–2 (2026-10-01)

## Context

Until P1-06 nothing enforced the rules outside a contributor's machine: the git hooks bind humans by convention and the agent by deny rule (ADR 0030), and the dependency allow-list (ADR 0023) was checked only in review. P1-06 adds GitHub Actions CI. A CI workflow is itself an attack surface: third-party actions run with the job's token, and event data such as a PR title is attacker-controlled text.

## Decision

- **One workflow, `.github/workflows/ci.yml`,** on `pull_request` (opened, edited, synchronize, reopened, ready_for_review) and on `push` to `main`. Jobs: `install`, then `verify`, `security` and `pr-title` in parallel (A1). Every job runs on every event, including a title edit: a skipped job counts as passing for branch protection, so a skip could turn a red check green.
- **Actions pinned by full commit SHA with a version comment.** The only third-party actions are `actions/checkout` `3d3c42e5aac5ba805825da76410c181273ba90b1` (v7.0.1), `actions/setup-node` `820762786026740c76f36085b0efc47a31fe5020` (v7.0.0) and `pnpm/action-setup` `ea17c68df8912ef543352723c149a84f56e3d413` (v6.1.0). Each SHA was resolved with `git ls-remote` and a tag fetch, and cross-checked against the version in the action's files at that SHA on raw.githubusercontent.com (codeload.github.com is blocked from the agent environment). `actions/checkout` is new to DEPENDENCIES.md §8 with this ADR. The pnpm store is cached by setup-node, so `actions/cache` is not used. Shared setup lives in the local composite action `.github/actions/setup` (pnpm from `packageManager`, Node from `.nvmrc`, frozen install, fails if Node's major differs from `.nvmrc`).
- **Least privilege.** Top-level `permissions: contents: read`; no job widens it, because no job writes anything (no SARIF upload, no PR comments). `actions/checkout` runs with `persist-credentials: false`.
- **No `pull_request_target`.** The PR title reaches the shell only through `env: PR_TITLE` and is printed with `printf '%s'`; no `${{ }}` appears inside any `run:` script.
- **pr-title:** on a PR, commitlint checks the PR title, which becomes the squash commit on `main`; on a push to `main`, it checks the head commit's subject (that squash title), so the job never skips. PR titles use `<type>(<scope>): <summary> (<task-id>)` (CLAUDE.md workflow step 6, E1).
- **security:** `pnpm tools:gitleaks` installs the pinned, checksum-verified binary (ADR 0030); `gitleaks-staged.mjs --selftest` generates a fake GitHub token at runtime in a throwaway repo under the OS temp dir and fails unless gitleaks reports it; `--history` scans every commit reachable from `HEAD` with `fetch-depth: 0` and fails on a shallow clone or zero commits (C1); `pnpm audit:prod` runs `pnpm audit --prod` and fails if there are no production dependencies.
- **Environment:** `HUSKY=0`, `TURBO_TELEMETRY_DISABLED=1`, `TURBO_CACHE=local:rw`. The Turbo remote cache stays off; no `TURBO_TOKEN` or `TURBO_TEAM` may appear.
- **Turbo cache fix (F1).** The P1-03b note "second verify misses vitest-smoke lint/typecheck once on a fresh checkout" was caused by Vitest writing `node_modules/.vite/vitest/<hash>/results.json` inside `tooling/vitest-smoke` and its fixtures: the typecheck and lint inputs (`**/*.json`) hashed these gitignored files, so every run that executed the vitest-smoke tests changed the inputs of the next lint and typecheck. Both input lists now exclude `**/node_modules/**`. `pnpm check:turbo-cache` runs in CI after `pnpm verify` and fails if any cacheable verify task would miss, or if there is none.
- **Permanent guards in `check:workspace` (`scripts/guards.mjs`), each proven by fixtures in `scripts/guard-fixtures/` on every run:** every workflow and composite action follows the rules above (SHA pins with version comment, exact `contents: read`, no job-level permissions, no `pull_request_target`, no `${{ }}` in `run:`, the three env settings, no Turbo token) (I1); every `package.json` dependency is an exact version (H1); every dependency name is listed in docs/DEPENDENCIES.md, which implements ADR 0023's CI enforcement (addition 1).
- **No integration job yet.** No integration test exists, and a job may not pass on zero work. Trigger: add the integration job with the first Testcontainers test (P2-02's `db-roles.int.test.ts` or P4, whichever comes first).
- **CODEOWNERS** covers the ROADMAP paths plus `.github/`, `.claude/`, `CLAUDE.md` and `scripts/gitleaks-*.mjs` (M1). **Branch protection** is applied by the owner from `docs/runbooks/github-settings.md` (J1, K1).
- **The `salvage/v0` gitleaks finding.** Scanning all refs finds one generic-api-key hit: `PS_JWT_KEY` in `docker-compose.yml:32` at commit `2d221c5` on `salvage/v0`. The architect checked it on 2026-10-01: it is the base64url form of the dev placeholder "dev-only-secret-change-me…" from that branch's `.env.example`, not a real credential, so no rotation is needed. CI scans `HEAD`'s history (everything that can reach `main`), not `salvage/v0`, which is never merged.

## Consequences

Positive:
- Hooks are no longer the only gate: a `--no-verify` commit, an unlisted or ranged dependency, a secret in history or a non-conventional squash title fails CI.
- A tag moved by an attacker cannot change which action code runs.
- Turbo's local cache is trustworthy on a fresh checkout, which is a precondition for any future shared cache.

Negative:
- The workflow guard reads YAML line by line. It is written for our plain workflow style, and an unusual construct (flow-style mappings, anchors) could slip past it. (for architect review)
- Action SHAs were verified through GitHub's git endpoint and raw.githubusercontent.com only, both GitHub-operated; the owner spot-checks them on github.com. (for architect review)
- `pnpm audit` depends on the npm advisory service; an outage turns the security job red without a code change. (for architect review)
- Running every job on a title edit costs a full CI run per edit. (for architect review)
- The history scan does not cover branches that are never merged (such as `salvage/v0`). (for architect review)

## Alternatives rejected

- **`pull_request_target`, or `${{ github.event.pull_request.title }}` inside `run:`:** script injection from attacker-controlled text.
- **Tag pins (`@v7`):** a moved tag runs new code silently.
- **Skipping jobs on title edits:** a skipped required check counts as passing.
- **Scanning all refs (C2):** would fail on the `salvage/v0` placeholder and need a committed ignore entry.
- **Turbo remote cache now:** not until local caching is proven stable and an owner decision covers its trust model.
