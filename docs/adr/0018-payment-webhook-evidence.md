# 0018. Payment webhooks: store raw evidence, verify, dedupe, process via outbox

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C18

## Context

Stack v1 said "webhooks" generically. Payments must only be confirmed by verified evidence, and replay must be possible.

## Decision

Store the **raw payload and headers** in `payment_webhook_events` before processing; verify the provider signature; dedupe by provider event id; process through the outbox (ADR 0006). Payments are confirmed only by a verified webhook or a server-to-server check.

## Consequences

Positive:
- Payments are only "confirmed" by verified evidence.
- Stored raw events make replay possible.

Negative:
- Raw payloads may contain personal or financial data, so the table needs encryption, retention rules and restricted access. (architect-reviewed 2026-09-30)
- Each provider adapter must implement its own signature scheme and pass contract tests. (architect-reviewed 2026-09-30)

## Alternatives rejected

- **Processing webhooks directly without storing raw evidence** (v1, generic): no verifiable evidence and no replay.
