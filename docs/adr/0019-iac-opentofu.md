# 0019. Infrastructure as code: OpenTofu

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C19

## Context

Stack v1 named Terraform. v2 prefers an open licence with the same HCL.

## Decision

Use **OpenTofu** (Terraform-compatible, same HCL) under `infrastructure/tofu`. Terraform is acceptable if the team already licenses it.

## Consequences

Positive:
- Open licence.
- Same HCL; Terraform knowledge and most providers transfer.

Negative:
- OpenTofu and Terraform may diverge; some newer Terraform features or registry modules may not be available. (proposed — needs review)

## Alternatives rejected

- **Terraform**: licence. Acceptable only if the team already licenses it.
