# 0017. Hash chaining required for audit events and journal entries

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C17

## Context

Stack v1 made hash chaining "optional". Financial auditability (spec 2.12) requires tamper evidence, and concurrent appends must be serialized per chain or the chain forks.

## Decision

Hash chaining is **required for `audit_events` and `journal_entries`**, with **one chain per organization**, appended under `pg_advisory_xact_lock(org)`. Both tables are append-only (app role has INSERT/SELECT only); corrections are reversing entries.

## Consequences

Positive:
- Tamper evidence for financial and audit records (spec 2.12).
- Serializing appends per organization prevents the chain from forking.

Negative:
- Appends within one organization are serialized, which caps write throughput per org for these tables. (proposed — needs review)
- Hashing depends on a canonical serialisation (RFC 8785 via `canonicalize`); any change to the canonical form breaks verification of older entries. (proposed — needs review)
- A chain-verification job and tooling must be built and run. (proposed — needs review)

## Alternatives rejected

- **Optional hash chaining** (v1): insufficient for financial auditability.
- **Unserialized appends**: the chain forks under concurrency.
