# @bricx/worker

Background work (P4-06, [ADR 0056](../../docs/adr/0056-transactional-outbox.md)): the outbox relay and the queue consumers that arrive with their features (P5-04 `sessions.revoked`, P5-05 `users.mfa_check`; more from P8 onward).

```bash
pnpm dev:worker                              # from the repo root: build, load ../../.env, run the relay
pnpm --filter @bricx/worker test             # unit tests (fakes, no Docker)
pnpm --filter @bricx/worker test:integration # Testcontainers: Postgres, Valkey
```

- `src/main.ts` calls `loadWorkerConfig()` from `@bricx/config/worker` before loading anything else and exits 1 naming the bad keys (never their values). It reads no env file; only the `dev` script passes `--env-file`.
- `src/relay/boot.ts`: refuses to start (`worker.boot_failed` with a code) unless Valkey answers and its `maxmemory-policy` is `noeviction`, and `RELAY_DATABASE_URL` reaches Postgres as `bricx_relay`. SIGTERM/SIGINT stop the relay after the batch in flight and exit 0.
- `src/relay/relay.ts`: one `withRelayTx()` per batch; claim with `FOR UPDATE SKIP LOCKED`, add each row to its topic's queue with jobId = outbox id, mark published in the same transaction. Valkey or Postgres failures never count an attempt; row failures dead-letter at `OUTBOX_DEAD_LETTER_AFTER`.
- `src/revocation/consumer.ts` (P5-04, [ADR 0065](../../docs/adr/0065-immediate-revocation.md)): the `sessions.revoked` consumer on queue `sessions`: sets the org-scoped `revoked:*` keys in Valkey with `REVOCATION_TTL_SECONDS`, then ends the Keycloak session through `src/revocation/keycloak.ts` (the `bricx-worker` service account; the admin client with a per-request timeout, `REQUEST_TIMEOUT_MS`).
- `src/mfa/consumer.ts` (P5-05, [ADR 0066](../../docs/adr/0066-grants-roles-project-overrides.md)): the `users.mfa_check` consumer on queue `users`: reads the truth with `app.mfa_state()` through `src/mfa/truth.ts` (the relay's transaction; never a flag from the payload) and maps or clears the realm role `bricx-mfa` (`ensureRealmRole`). Logs `mfa.applied`, `mfa.user_missing`, `mfa.retry`, `mfa.keycloak_failed` (ids and counts only).
- `src/outbox-job.ts`: what both consumers share of a relay-published job (its shape, the `outbox` backoff strategy that resolves the topic's delivery options, the HTTP status of a failure).
- The only code that imports BullMQ (Semgrep `bricx-bullmq-outside-worker`) and, with `packages/db`, the only user of `withRelayTx()` (`bricx-relay-tx-outside-relay`: `src/relay/` and `src/mfa/`).
- Operating it: [docs/runbooks/outbox.md](../../docs/runbooks/outbox.md).
