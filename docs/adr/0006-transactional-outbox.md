# 0006. Side effects through a transactional outbox

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C6

## Context

Stack v1 enqueued BullMQ jobs directly from request handlers. A job enqueued outside the database transaction can fire for a payment that was rolled back, or be lost after a commit. That is unacceptable for money.

## Decision

Every write that triggers side effects (jobs, notifications, payments, outbound webhooks) writes a row to a **transactional outbox** table in the same database transaction. A relay (in `apps/worker`) publishes outbox rows to BullMQ. Request code never enqueues BullMQ jobs directly.

## Consequences

Positive:
- A side effect exists if and only if its transaction committed.
- No lost jobs after a commit and no jobs for rolled-back work.

Negative:
- Side effects are delayed by relay latency; outbox lag must be monitored and alerted on. (proposed — needs review)
- Delivery is at-least-once, so every consumer must be idempotent. (proposed — needs review)
- The relay is another component to operate, and the outbox table needs cleanup or partitioning as it grows. (proposed — needs review)

## Alternatives rejected

- **Enqueue BullMQ jobs directly from the request** (v1): jobs can fire for rolled-back transactions or be lost after commit.
