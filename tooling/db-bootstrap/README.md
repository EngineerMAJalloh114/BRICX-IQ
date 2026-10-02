# @bricx/db-bootstrap

Integration tests for the database bootstrap (ROADMAP P2-02, ADR 0035) and the S3 dev bucket (P2-01b, ADR 0036). Docker (with the Compose plugin) required.

```bash
pnpm test:integration   # from the repo root (turbo, never cached), or in this package
```

- `test/db-roles.int.test.ts`: the roles, privileges, schemas, extensions and publication that `infrastructure/docker/postgres/init` creates, including a real RLS proof and five sabotage cases that must each be reported. Also proves Testcontainers runs the digest-pinned Ryuk image.
- `test/s3-bucket.int.test.ts`: the `s3-init` one-shot creates the bucket when the filer answers late (fault: the `s3` container is paused while it starts; at least one attempt must fail), the s3 healthcheck fails until the bucket exists, a second run is idempotent, a filer that never answers fails loudly within bounds, and the S3 credentials work (signed PUT then GET; a wrong secret gets 403). Everything it runs comes from `docker compose config` on the real `compose.yml` and `.env.example`, including the bind-mounted `infrastructure/docker/s3/create-bucket.sh`.
- `test/powersync-health.int.test.ts`: PowerSync's healthcheck (`infrastructure/docker/powersync/healthcheck.mjs`) turns unhealthy when the publication is dropped and healthy when it is restored, and rows written while it is missing never replicate.

Both run compose.yml's images (read from compose.yml), the real init folder, `powersync.yaml` and healthcheck, and role passwords from `.env.example`; the bootstrap superuser is a throwaway identity generated per run. Checks live in `src/checks.ts` and return a list of problems. Polling is bounded; there are no fixed sleeps.
