# 0001. Offline sync: PowerSync (self-hosted Open Edition)

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C1

## Context

Stack v1 left offline sync open: PowerSync **or** a custom outbox/inbox protocol. Field teams must keep working with poor or no connectivity, Postgres must stay the source of truth, and the owner must keep control of the infrastructure (spec 2.9). An open choice here blocks every offline feature.

## Decision

Use **PowerSync (self-hosted Open Edition)**. Device writes are uploaded through the NestJS API (`POST /sync/upload`), where they are validated, authorized, conflict-checked and audited before reaching Postgres; changes then replicate back down. Devices never write to Postgres directly. A custom sync protocol remains a documented fallback only.

## Consequences

Positive:
- Ships faster than building and maintaining a custom sync protocol.
- Postgres stays the single source of truth.
- Self-hosting satisfies the owner-control requirement (spec 2.9).
- Every device write passes the same API validation, CASL, RLS, conflict rules and audit as online writes.

Negative:
- We operate an additional stateful service (PowerSync) in every region cell, with its own upgrades, monitoring and backups. (proposed — needs review)
- Client SDK versions are tied to PowerSync's supported adapters for each Expo SDK, which can delay Expo upgrades. (proposed — needs review)
- Download scoping lives in sync rules outside Postgres RLS and must be maintained separately (see ADR 0002). (proposed — needs review)

## Alternatives rejected

- **Custom outbox/inbox sync protocol**: slower to build; kept only as a documented fallback.
