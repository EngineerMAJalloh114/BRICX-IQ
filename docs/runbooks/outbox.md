# Transactional outbox (P4-06, ADR 0056)

Side effects (jobs, notifications, payments, webhooks out) are never enqueued from a request (CLAUDE.md rule 5). The API writes a row to `bricx.outbox` in the same transaction as the change it belongs to (`OutboxService.enqueue(tx, topic, payload)`, which calls `insertOutbox()` from `@bricx/db/outbox`). The worker's relay publishes committed rows to BullMQ, with jobId = the outbox id, and marks them published in the same transaction.

## Running the relay

```bash
pnpm dev:up        # Valkey runs with --maxmemory-policy noeviction
pnpm db:migrate
pnpm dev:worker    # builds apps/worker and runs it with .env
```

The worker refuses to start (`worker.boot_failed`, exit 1) with one of these codes:

| code | meaning |
| --- | --- |
| `valkey_unavailable` | Valkey cannot be reached at `VALKEY_URL`. |
| `valkey_eviction_policy` | Valkey's `maxmemory-policy` is not `noeviction`: an evicting Valkey can drop jobs the outbox already marked published. |
| `database_unavailable` | Postgres cannot be reached at `RELAY_DATABASE_URL`. |
| `relay_role` | `RELAY_DATABASE_URL` does not log in as `bricx_relay`. |

A bad environment exits 1 before any of these, naming keys only.

## Logs

| msg | level | meaning |
| --- | --- | --- |
| `worker.started` / `worker.stopped` | info | Boot finished; SIGTERM or SIGINT stopped the relay after the batch in flight. |
| `outbox.relay_unavailable` | warn | Valkey (`dependency: "valkey"`) or Postgres (`"database"`) failed. Rows stay pending, attempts unchanged; the relay backs off 1 s doubling to 30 s. Logged when an outage starts, then at most once a minute. |
| `outbox.relay_recovered` | info | The first good batch after an outage. |
| `outbox.dead_letter` | error | A row failed `OUTBOX_DEAD_LETTER_AFTER` times (default 10) for a reason of its own (`last_error`: `unknown_topic`, `invalid_payload`, `payload_too_large`, `publish_rejected`). Fields: `outboxId`, `orgId`, `topic`, `attempts`, `lastError`. |

Row failures back off by min(2^attempts s, 300 s). Logs carry ids, topics and codes, never a payload.

A batch holds its transaction for at most the 15 s batch deadline plus one 5 s Valkey command. `bricx_relay` has `idle_in_transaction_session_timeout = '30s'`, so a relay that stalls inside a transaction for longer loses it (its claimed rows stay pending, attempts unchanged) and the rows are free for the next batch. If you raise `batchDeadlineMs` or `commandTimeoutMs` in `apps/worker/src/relay/relay.ts`, raise the role's timeout in `01-bootstrap.sh` and `tooling/db-bootstrap/src/checks.ts` with them: the worker's `relay-idle-timeout` test fails when the margin drops below 5 s.

## Inspecting the outbox

Every statement here runs as `bricx_relay` (`RELAY_DATABASE_URL`): `bricx.outbox` has FORCE ROW LEVEL SECURITY and only `bricx_relay` has policies that see every org. As `bricx_owner` or `bricx_app` these queries see nothing.

```bash
psql "$RELAY_DATABASE_URL"
```

```sql
-- Pending, by topic
SELECT topic, count(*), min(created_at) FROM bricx.outbox
WHERE published_at IS NULL AND dead_at IS NULL GROUP BY topic;
-- Dead letters
SELECT id, org_id, topic, attempts, last_error, dead_at FROM bricx.outbox
WHERE dead_at IS NOT NULL ORDER BY dead_at;
```

## Re-driving a dead letter

Fix the cause first (deploy the consumer of an unknown topic, or the publisher fix). Then, for each dead row, as `bricx_relay`:

```bash
psql "$RELAY_DATABASE_URL" -v ON_ERROR_STOP=1 -v outbox_id=<the row's id>
```

<!-- redrive-sql -->
```sql
UPDATE bricx.outbox
SET dead_at = NULL, attempts = 0, next_attempt_at = now(), last_error = NULL
WHERE id = :'outbox_id' AND dead_at IS NOT NULL;
```

psql prints `UPDATE 1`; the relay publishes the row on its next batch. `UPDATE 0` means the id is wrong or the row is not dead; running it twice is harmless. The integration test `apps/worker/test/relay.int.test.ts` (done when 9) runs this exact block as `bricx_relay`.

The same statement as `bricx_owner` updates 0 rows (FORCE RLS: the owner has no outbox policy). Deleting rows is not possible for any role today; retention is a P13 task (partition drop or an explicit owner DELETE policy).
