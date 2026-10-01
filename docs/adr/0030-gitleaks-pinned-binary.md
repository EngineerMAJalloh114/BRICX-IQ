# 0030. gitleaks as a pinned, checksum-verified binary

- Status: Accepted
- Date: 2026-10-01
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P1-05; DEPENDENCIES.md §7 (gitleaks); ADR 0023 (dependency policy); P1-05 rulings A1, B1, C1, D1, E1 and the agent hook-bypass addition

## Context

P1-05 adds commit hooks: lint-staged and commitlint (npm packages listed in DEPENDENCIES.md §1) and gitleaks secret scanning. gitleaks is a Go binary, not an npm package, so `pnpm install` cannot pin or verify it, and ADR 0023 requires an ADR for how it enters the repo.

On 2026-10-01 the latest gitleaks release is v8.30.1 (2026-02-21); proxy.golang.org lists no v9 module. The release publishes `gitleaks_8.30.1_checksums.txt` but no signature or attestation for it. The Linux x64 archive downloaded from the release matched that file: `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb`. The `gitleaks` binary inside it has SHA-256 `88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509`.

The developer machines are Linux x64 under WSL, and the cloud agent environment is Linux x64. gitleaks over main's full history (11 commits) and over the working tree found no leaks.

## Decision

- **Pin:** `scripts/gitleaks-pin.mjs` holds the version (8.30.1), the platform (`linux-x64`), the archive SHA-256 and the binary SHA-256. A bump changes all three together and updates the DEPENDENCIES.md §7 row.
- **Install (A1, manual):** `pnpm tools:gitleaks` runs `scripts/install-gitleaks.mjs`. It downloads the release archive, refuses to install on an archive hash mismatch, extracts it in a temp dir, refuses on a binary hash mismatch, and only then copies the binary to `.tools/gitleaks/8.30.1/gitleaks`. `.tools/` is gitignored. On any refusal it exits 1 and writes nothing to `.tools/`. `pnpm install` does not download it.
- **Platform (B1):** only Linux x64 is pinned. Any other platform is refused by the installer and blocked by the hook, with a message pointing to WSL. Trigger: when a macOS/Windows contributor joins, pin and TEST that platform's hash on their machine.
- **Hooks fail closed:** husky 9 installs the hooks through `prepare`. `.husky/pre-commit` runs, under `set -e`:
  1. `gitleaks-staged.mjs --check`: blocks the commit with `Install it with: pnpm tools:gitleaks` when the binary is missing, its SHA-256 differs from the pin (re-checked on every commit), or the platform is not pinned;
  2. `lint-staged`: `eslint --fix` and `prettier --write` on the staged files;
  3. `gitleaks-staged.mjs --scan`: `gitleaks git --staged --redact` on the final staged content; any finding or error blocks the commit. Every gitleaks run uses `--redact`, so a caught secret is never echoed.
- **commit-msg:** commitlint with `@commitlint/config-conventional` and an enforced scope list (C1); the scope stays optional. New areas add their scope in the task that creates them.
- **Permanent guard (D1):** `check:workspace` fails if either hook is missing or its commands differ from the expected list and order, if `prepare` is not `husky`, if `.tools/` is not gitignored, or if the DEPENDENCIES.md gitleaks row does not name the pinned version.
- **Agent bypass denied:** `.claude/settings.json` denies `git commit *--no-verify*`, `git commit -n*`, `git commit * -n*`, `git commit -an*`, `git commit * -an*`, `git push *--no-verify*`, `HUSKY=0*`, `export HUSKY=0*`, `env HUSKY=0*`, `git -c *hooksPath*` and `git config *hooksPath*` (any scope: `--global`, `--local` or none; reading the value is denied too). Each rule is proven by a permission_denial test with a no-rule control (the P0-03 method).

## Consequences

Positive:
- A secret in staged changes, a non-conventional message or an unformatted staged file is caught before the commit exists.
- A missing, corrupt or swapped gitleaks binary blocks commits instead of silently skipping the scan.
- The pinned hashes mean a re-published release asset cannot be installed silently.

Negative:
- Hooks bind humans by convention and the agent by deny rule; CI (P1-06) is the gate for both. `git commit --no-verify`, `HUSKY=0`, or a clone where `pnpm install` never ran (no `core.hooksPath`) skips every hook. (architect-reviewed 2026-10-01)
- Deny rules match literal command text. Tested on 2026-10-01, these are still NOT blocked: wrappers such as `bash -c "git commit --no-verify ..."`, and combined short flags other than `-an` (for example `git commit -sn ...`). No wildcard pattern covers every combination without blocking normal messages: `git commit -*n *` also denies `git commit -m "chore: run tests"` (tested), so it was rejected. A chained command (`git add a && git commit --no-verify ...`) is blocked. `git commit * -n*` and `git commit * -an*` also block an inline `-m` message containing ` -n` or ` -an`; use `git commit -F <file>` then. (architect-reviewed 2026-10-01)
- The checksums file is not signed, so the pin is only as trustworthy as the GitHub release on 2026-10-01. (architect-reviewed 2026-10-01)
- Contributors on macOS or native Windows cannot commit until their platform is pinned and tested (B1 trigger above). (architect-reviewed 2026-10-01)
- Every fresh clone needs one network download from github.com before the first commit. (architect-reviewed 2026-10-01)

## Follow-ups for P1-06 (logged in ROADMAP.md and PROGRESS.md)

- Run gitleaks over the full git history in CI, with the same pinned version and checksum.
- Check the PR title with commitlint: squash merges put the PR title on main, and the commit-msg hook never sees it. Main already holds one such commit that fails commitlint: `P0-01: record architecture decisions as ADRs (#4)`.

## Alternatives rejected

- **Install on `pnpm install` (A2):** adds a GitHub download to every install and to CI.
- **Pin macOS and Windows hashes now (B2):** untested hashes would pass review without proof that the binary runs.
- **A gitleaks npm wrapper or Docker image:** not in DEPENDENCIES.md, and they add a second distribution channel to trust.
- **Skip the scan when gitleaks is missing:** a silent skip is exactly the failure this ADR prevents.
