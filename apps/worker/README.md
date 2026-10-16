# @bricx/worker

Background work (P4-06, [ADR 0056](../../docs/adr/0056-transactional-outbox.md)). Today it runs the outbox relay; queue consumers arrive with their features (P8 onward).

```bash
pnpm dev:worker                              # from the repo root: build, load ../../.env, run the relay
pnpm --filter @bricx/worker test             # unit tests (fakes, no Docker)
pnpm --filter @bricx/worker test:integration # Testcontainers: Postgres, Valkey
```

- `src/main.ts` calls `loadWorkerConfig()` from `@bricx/config/worker` before loading anything else and exits 1 naming the bad keys (never their values). It reads no env file; only the `dev` script passes `--env-file`.
- `src/relay/boot.ts`: refuses to start (`worker.boot_failed` with a code) unless Valkey answers and its `maxmemory-policy` is `noeviction`, and `RELAY_DATABASE_URL` reaches Postgres as `bricx_relay`. SIGTERM/SIGINT stop the relay after the batch in flight and exit 0.
- `src/relay/relay.ts`: one `withRelayTx()` per batch; claim with `FOR UPDATE SKIP LOCKED`, add each row to its topic's queue with jobId = outbox id, mark published in the same transaction. Valkey or Postgres failures never count an attempt; row failures dead-letter at `OUTBOX_DEAD_LETTER_AFTER`.
- The only code that imports BullMQ (Semgrep `bricx-bullmq-outside-worker`) and the only user of `withRelayTx()` (`bricx-relay-tx-outside-relay`).
- Operating it: [docs/runbooks/outbox.md](../../docs/runbooks/outbox.md).
