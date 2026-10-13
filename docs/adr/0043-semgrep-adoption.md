# 0043. Adopt Semgrep: pinned image, rules written for this repo

- Status: Accepted
- Date: 2026-10-13
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P3-01b; ADR 0032 (trigger reached with `@bricx/ids`, PR #27); P3-01b requirements 1–10 and plan approval with change 1a–1g (2026-10-13); DEPENDENCIES.md §7

Amends ADR 0032.

## Context

ADR 0032 deferred Semgrep until the first P3 package with `src/`. `@bricx/ids` (P3-01, ADR 0041) reached that trigger. ADR 0032 binds the adoption: a rule snapshot committed to the repo (no live registry rulesets, no network fetch of rules at run time), and Semgrep pinned by version and digest or checksum, both in DEPENDENCIES.md §7.

**Distribution, measured 2026-10-13.** The latest Semgrep, 1.180.0, was published 2026-10-07T23:24:26Z (PyPI), 5.6 days before: it fails the 7-day rule (ADR 0023). 1.179.0 was published 2026-10-02T00:10:47Z (PyPI); its Docker Hub tag `semgrep/semgrep:1.179.0` was pushed 2026-10-02T00:02:27Z. Three ways to pin it:

- **Image by digest:** one index digest pins the CLI, the engine and every Python dependency. 429 MB compressed for linux/amd64 (1.56 GB on disk); the pull took 40 s in the agent container. It runs with `--network none`.
- **pip `--require-hashes`:** `semgrep==1.179.0` installs 66 Python packages, each needing a hash pin and a 7-day check, and adds Python to the toolchain. The install took 54 s.
- **A binary like gitleaks (ADR 0030):** the CLI that takes `--metrics`, `--error` and `--strict` is the Python wrapper; the engine (`semgrep-core`, 257 MB) ships inside the wheel. There is no standalone CLI binary to checksum (inferred: the agent environment could not list the GitHub release assets).

Docker Hub limits anonymous pulls. P2-01b and P3-01 hit 429 in the agent container, and during this task a pull of an image already on disk failed 3 times with 429 on the manifest HEAD request. The CI `integration` job already pulls 3 Docker Hub images anonymously on every run.

**Rules: the licence.** The plan proposed vendoring rules from `semgrep/semgrep-rules`. The architect rejected that (change 1, 2026-10-13): the Semgrep Rules License v1.0 permits use for "internal business purposes" only and states "This license does not allow you to distribute the rules, or to make them available to others as a service". This repository is public, so a committed copy is distribution. Registry rules fetched at run time are ruled out by ADR 0032 itself. So the rules are written for this repo, under the repo's own licence, from first principles against our code; no Semgrep rule is copied or closely paraphrased.

**What already covers the same ground.** The ADR 0031 guard (`workflowProblems` in `scripts/guards.mjs`) rejects `${{ }}` anywhere inside `run:`, `pull_request_target`, actions not pinned by full commit SHA with a version comment, job-level `permissions:`, `if:`, and remote Turbo cache tokens. ESLint (`tooling/eslint`) rejects `parseFloat`/`parseInt`/`Number(` on an identifier or property named like money (everywhere), `Date.now()`, zero-argument `new Date()` and `Math.random()` in `packages/domain` and `packages/ids/src`, and, through typescript-eslint `no-implied-eval` (strictTypeChecked), `new Function` and string timers. Semgrep rules duplicate none of that.

## Decision

**Pin and run (approved D1, D4).** `scripts/semgrep-pin.mjs` holds `semgrep/semgrep` 1.179.0, the index digest `sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b` and the linux/amd64 digest `sha256:cab19964e6c93019934252a9cd591d9b27df1e5b5d1734b26f4069ae51c295f8`, and every argument. `scripts/semgrep.mjs` runs `docker run --rm --network none` with the rules mounted read-only at `/rules` and the target read-only at `/src`, then `semgrep scan --config /rules --metrics=off --disable-version-check --strict` (plus `--error` for the scan, `--json` for the self-test). No `auto`, `p/`, `r/` or URL config exists anywhere. The image is pulled by digest, 3 attempts with backoff; a failed pull fails the run, never skips it. When the image with that digest is already on disk, the pull is skipped: a digest names exactly one content, so the local image is the pinned one, and pulling again only spends Docker Hub's rate limit (for architect review). `pnpm semgrep` runs the scan locally (Docker required).

**Rules (change 1a–1d).** `tooling/semgrep/rules/` holds 12 rule files, one rule each, named `bricx-<id>.yaml`, each with a message, `severity: ERROR` and a CWE or CLAUDE.md/ADR reference. `paths` include/exclude keep rules for code that does not exist yet inert: they scan nothing until the package or folder appears. Semgrep path patterns match at any depth (`packages/db/` also matches `x/packages/db/`).

| Rule | Catches | Not covered elsewhere because |
|---|---|---|
| `bricx-gha-untrusted-checkout` | `actions/checkout` with a PR head ref/sha in a `workflow_run` or `pull_request_target` workflow | the guard forbids `pull_request_target` but not `workflow_run` (overlap: `pull_request_target`) |
| `bricx-gha-secrets-inherit` | `secrets: inherit` | not in the guard |
| `bricx-gha-curl-pipe-shell` | `curl`/`wget` piped into a shell in `run:` | not in the guard |
| `bricx-gha-untrusted-in-script-input` | `${{ github.event.* }}`, `github.head_ref` or `inputs.*` in the `script:` of `actions/github-script` | the guard checks `run:` only |
| `bricx-child-process-shell` | `child_process` calls with `shell` not `false` | no ESLint rule |
| `bricx-child-process-exec` | `exec`/`execSync` with a non-literal command; `spawn`/`execFile` of `sh -c` with a non-literal string | no ESLint rule |
| `bricx-regexp-non-literal` | `new RegExp(x)` / `RegExp(x)` from a non-literal | no ESLint rule |
| `bricx-eval` | `eval`, `globalThis.eval`, indirect `(0, eval)` | `no-implied-eval` covers `new Function` and string timers, not `eval` |
| `bricx-clock-in-money-permissions` | `Date.now()`, `new Date()`, `Math.random()` in `packages/money/src` and `packages/permissions/src` (rule 7) | ESLint covers `packages/domain` and `packages/ids/src` only; inert until those packages have source |
| `bricx-money-float-coercion` | unary `+` on money names; `parseFloat`/`parseInt`/`Number` where a money name is nested or a computed key (rule 1) | the ESLint selector sees only a direct identifier or property; the rule leaves those cases to ESLint |
| `bricx-raw-pg-outside-db` | importing `pg`, `pg-pool`, `postgres`, `drizzle-orm/node-postgres` or `drizzle-orm/postgres-js` outside `packages/db` (rule 4) | no ESLint rule; excludes `tooling/db-bootstrap`, whose integration tests connect as each role to prove the roles themselves (ADR 0035) |
| `bricx-bullmq-outside-outbox` | `Queue#add`/`addBulk` on a BullMQ `Queue` outside `apps/worker/src/relay` (rule 5, P4-06) | no ESLint rule; inert until BullMQ is used |

Not added, because the ADR 0031 guard already enforces it: `${{ }}` in `run:` and actions not pinned by SHA.

**Self-test (approved D6, change 1d).** Every rule has a known-bad and a known-good fixture under `tooling/semgrep/selftest/{bad,good}/`, at paths that mirror the repo so `paths` filters apply. `expected.json` lists, per rule id, the exact known-bad `path:line` findings and the known-good files. `node scripts/semgrep.mjs --selftest` fails on a missed line, an extra finding, any finding in the known-good tree, or any Semgrep error.

**Manifest (change 1e).** `tooling/semgrep/MANIFEST.json` lists each rule file with its SHA-256 and nothing else (no upstream source). It sits beside `rules/`, not in it, because `--config /rules` would try to load it. The DEPENDENCIES.md §7 row names its SHA-256, so a rule change needs the matching row in the same reviewed commit. `scripts/semgrep.mjs` refuses to run when the rule files differ from the manifest.

**What is scanned (approved D5).** `.semgrepignore` replaces Semgrep's built-in list (which skips `test/` and `tests/`), so tests are scanned. It skips exactly `node_modules/`, `.tools/`, `scripts/guard-fixtures/` (deliberately bad workflows that prove the ADR 0031 and 0034 guards) and `tooling/semgrep/` (the rules and the known-bad fixtures, which the self-test scans on purpose). Semgrep also skips what `.gitignore` ignores and, in a git checkout, scans tracked files only.

**CI (requirement 4).** The `security` job runs, after gitleaks: `node scripts/semgrep.mjs --selftest`, then `node scripts/semgrep.mjs --scan`. No `if:`, no `continue-on-error`, SHA-pinned actions and `contents: read` as ADR 0031 requires. Any finding fails the job.

**Guards in `check:workspace` (approved D8, requirement 5).** `semgrepAllProblems` in `scripts/guards.mjs`, proven by 44 fixtures in `scripts/guard-fixtures/semgrep/`:

- G1: the §7 Semgrep row names `semgrep/semgrep:<version>@<index digest>` and the amd64 digest; exactly one such row.
- G2: the version is exact; both digests are `sha256:` plus 64 hex; the image is `semgrep/semgrep`.
- G3: the manifest exists, has only `description` and `rules`, and lists exactly the rule files with matching SHA-256.
- G4: the §7 row names the manifest's SHA-256.
- G5: the `security` job holds the self-test run line and then the scan run line, each exactly once, nowhere else, with no `if:` and no `continue-on-error`.
- G6: `--network none`, `--rm`, read-only mounts; `--metrics=off`, `--disable-version-check`, `--strict` in both runs and `--error` in the scan; exactly one config, `/rules`; no registry, URL or `auto` config; the runner names no other rules source.
- G7: `.semgrepignore` holds exactly the approved list.
- G8: one rule per `bricx-<id>.yaml` file, id equal to the file name, a message, `severity: ERROR`, a `cwe` or `bricx-rule` reference, and a self-test entry for every rule (and a rule for every entry, with every listed fixture file present).

**Review (approved D9).** CODEOWNERS adds `/tooling/semgrep/`, `/.semgrepignore` and `/scripts/semgrep*.mjs`: a new or changed rule is a commit the owner reviews.

**Triage of `main` (requirement 6, change 1g),** with these rules, at `acaaafd`: 3 findings. Fixed: `scripts/guards.mjs` built a RegExp from an audit advisory id (now a line comparison); `tooling/vitest-smoke/check.mjs` built its ANSI-stripping RegExp from a string (now `util.stripVTControlCharacters`). Suppressed inline with a reason: `scripts/pr-title-step.mjs` runs `bash -e -c` on the `run:` block of this repo's own pr-title step, exactly as CI runs it; the title under test reaches it only through `env`, and the canary proves it is never executed.

**Revisit (change 1f)** when the Semgrep Rules License changes to allow redistribution, or when the owner decides to use registry rules in a private repository.

## Consequences

Positive:
- SAST runs on every PR and push, with rules that only change through a reviewed commit, and cannot reach the network.
- Project rules ESLint does not cover (raw pool, outbox, clock and money in packages ESLint does not scope, workflow gaps) fail CI.
- A rule that stops matching fails the self-test instead of passing silently.

Negative:
- Coverage given up versus the registry: the registry's JavaScript, TypeScript and GitHub Actions packs (about 70 rules in the folders the plan selected) also detect DOM XSS sinks, prototype pollution, path traversal through non-literal file names, SQL injection through string-built queries for `pg`, `knex` and others, JWT misuse, weak or deprecated crypto, NestJS open redirect and wildcard CORS, insecure HTTP requests, ReDoS-prone literals and unsafe dynamic method calls. None of that is covered here until we write a rule for it. (for architect review)
- Rules are written and maintained by hand; each new detection costs a rule, two fixtures and a manifest update. (for architect review)
- The image is 429 MB compressed (1.56 GB on disk) and adds about 55–70 s to the `security` job (pull 40 s, self-test and scan about 15 s each, measured in the agent container). (for architect review)
- Docker Hub's anonymous rate limit can fail the job; the pull is retried 3 times and never skipped, so a 429 storm turns CI red until it passes. A local run needs Docker. (for architect review)
- Dependabot does not see a pin inside a `.mjs` file: version bumps are manual, with the 7-day rule. (for architect review)
- The digest-on-disk shortcut trusts the local Docker image store. (for architect review)
- Only the 12 rules' patterns are checked; Semgrep's community engine does no cross-file taint tracking. (for architect review)

## Alternatives rejected

- **Vendor `semgrep/semgrep-rules` (plan D2/D3):** the Rules License forbids distribution, and this repo is public (architect, change 1).
- **Registry rules at run time:** not versioned, and network-fetched (ADR 0032).
- **pip with `--require-hashes`:** 66 Python packages to pin, hash and check against the 7-day rule, and Python added to the toolchain.
- **A pinned binary:** no standalone CLI binary exists; the engine alone does not take the CLI flags.
