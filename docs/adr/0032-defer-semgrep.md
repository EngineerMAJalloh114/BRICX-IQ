# 0032. Defer Semgrep until the first package with source code

- Status: Accepted
- Date: 2026-10-01
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP.md P1-06 step 1; DEPENDENCIES.md §7 (Semgrep, P1); P1-06 ruling B2 (2026-10-01)

## Context

ROADMAP P1-06 lists Semgrep (SAST) in the security job. On 2026-10-01 the repository holds only tooling: configs, smoke fixtures and root scripts. The latest Semgrep is 1.178.0 (`semgrep/semgrep:1.178.0@sha256:32e459968daabe7ab86968184a29109b9564aa00392401156f9788452b42786b`). Registry rulesets (`p/javascript`, `p/github-actions`) are fetched live at run time and are not versioned, so a new upstream rule can turn unchanged code red.

## Decision

- Semgrep is **not** run in CI in P1-06.
- **Trigger:** adopt Semgrep with the first P3 package that has a `src/` directory.
- **When adopted, rules must be pinned:** a vendored snapshot of the chosen rules committed to the repo, never live registry rulesets. The Semgrep image or binary is pinned by version and digest or checksum, and the adoption task records both in DEPENDENCIES.md §7.

## Consequences

Positive:
- No CI check that does little work today, and no live rules that change without review.

Negative:
- Until the trigger, there is no SAST. Workflow injection is covered by the `check:workspace` workflow guard (ADR 0031), not by Semgrep's GitHub Actions rules. (for architect review)
- Vendored rules must be refreshed by hand to pick up new detections. (for architect review)

## Alternatives rejected

- **Adopt now with live registry rulesets (B1):** non-deterministic results, and little code to scan.
