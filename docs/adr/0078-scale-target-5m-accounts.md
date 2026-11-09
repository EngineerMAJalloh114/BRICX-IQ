# 0078. Scale target: 5,000,000 registered accounts

- Status: Accepted
- Date: 2026-11-09
- Deciders: Mohamed Abass Jalloh
- Source: owner instruction 2026-11-09 ("I want it to be 5,000,000 accounts"); ADR 0020 (region cells); ADR 0017 and 0055 (per-organisation audit serialisation); ROADMAP P8-02, P14-02.

## Context

Until now the only quantified capacity figure in the repository was the P14-02 load-test scenario: 500 concurrent field users. No document stated a registered-account target, a peak-concurrency assumption or a per-cell ceiling. The owner has set the product target at 5,000,000 registered accounts.

The architecture already scales by adding region cells (ADR 0020): each cell is a full copy of the stack, the global directory only maps organisation to cell (ADR 0071), and no query crosses cells. Registered accounts are not the hard limit. Concurrent connections and per-cell component limits are.

## Decision

1. **Target.** BRICX IQ is designed for **5,000,000 registered accounts** across region cells. This is a design target, not a guarantee. Capacity is measured by P14 load tests and is not claimed until they pass.
2. **Working assumptions (owner to confirm; they size the infrastructure):** peak concurrency is 5% of registered accounts, so 250,000 concurrent users in total; five cells at launch scale, so about 1,000,000 accounts and 50,000 peak concurrent users per cell. The two launch cells are `af-south-1` and `eu-west-1` (ADR 0071); further cells follow the directory's add-a-cell procedure.
3. **Scaling model.** Capacity grows by adding cells and by sizing each cell. No cross-cell queries and no cross-cell joins. The global directory stays organisation-to-cell only.
4. **Named limits** (each has a measurement task, not an assumption):
   - PowerSync service connections per cell: every offline client holds a sync stream. This is expected to be the first ceiling.
   - Keycloak realm size per cell (about 1,000,000 users).
   - API, worker and outbox-relay throughput under burst.
   - Per-organisation serialisation of audit and ledger appends (ADR 0017, 0055): it caps write throughput for one very large organisation, not the number of organisations.
5. **Design rules that follow** (apply to every new module and are checked at review):
   - Every list endpoint uses keyset pagination and has a maximum page size.
   - No unbounded query and no unbounded response.
   - Every tenant table is indexed by `org_id` first for its hot paths.
   - Every sync stream states its connection and data budget in its task (P8-02).
6. **Measurement.** P14-02 becomes a staged k6 programme: 500, 5,000 and 50,000 concurrent users per cell, with the extrapolation to the target written up. Two spikes are added: a PowerSync capacity spike and a Keycloak 1,000,000-user realm test. Their results update this ADR.

## Consequences

- The 5,000,000 figure now appears in STACK.md and the ROADMAP, so every phase can be reviewed against it.
- Until the P14 tests pass, the product must not advertise 5,000,000 as supported capacity.
- Infrastructure cost and operational work grow with the number of cells (already accepted in ADR 0020).
- The working assumptions (5% peak, five cells) may change; they are the owner's to confirm before P13 sizing.
