# 0020. Region cells for data residency

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C20

## Context

Stack v1 said "multi-region" without a model. Data residency (spec 3.1) must be met without distributed transactions.

## Decision

Use **region cells**: one full stack per residency region (starting with `af-south-1` Cape Town and `eu-west-1`). A thin global **directory service** routes each organization to its cell. There is **no cross-region replication of tenant data**. An organization's data region is fixed at creation.

## Consequences

Positive:
- Meets data residency (spec 3.1).
- No distributed transactions.

Negative:
- Each cell is a full copy of the stack, so fixed infrastructure cost and operational work scale with the number of regions. (architect-reviewed 2026-09-30)
- Cross-organization features that span regions (for example a client in one cell and a contractor in another) are not possible without extra design. (architect-reviewed 2026-09-30)
- Moving an organization between regions is not supported. (architect-reviewed 2026-09-30)
- The directory service is a global dependency for login routing and must be highly available. (architect-reviewed 2026-09-30)

## Alternatives rejected

- **Generic "multi-region" with cross-region replication** (v1): conflicts with data residency and needs distributed transactions.

Final launch regions are an open business decision in `pending.md`.
