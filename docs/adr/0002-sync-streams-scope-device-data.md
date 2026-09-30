# 0002. Sync streams duplicate tenant and project scoping (RLS does not cover replication)

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C2

## Context

Stack v1 assumed Postgres row-level security "enforces isolation" for sync too. It does not: **RLS does not apply to logical replication.** PowerSync reads through a replication role that bypasses RLS, so a bug in sync rules would leak another tenant's data to devices without RLS ever being consulted.

## Decision

Tenant and project scoping for device downloads is duplicated in **PowerSync Sync Streams / sync rules**. These rules are generated from the same permission catalogue (`@bricx/permissions`) as CASL and RLS, and every synced table is covered by a leak test.

## Consequences

Positive:
- Closes the gap where a sync-rule bug would leak another tenant's data to devices.
- One permission catalogue drives all authorization layers, so they cannot drift apart silently.

Negative:
- Authorization for synced data is expressed twice (RLS and sync streams), which adds generator code and test surface. (proposed — needs review)
- Every new synced table needs a stream scope and a leak test before it can ship, which slows feature work slightly. (proposed — needs review)
- The generator depends on PowerSync's sync-rule format; changes upstream require generator changes. (proposed — needs review)

## Alternatives rejected

- **Relying on RLS alone for sync isolation** (v1 assumption): technically wrong, because the replication role bypasses RLS.
