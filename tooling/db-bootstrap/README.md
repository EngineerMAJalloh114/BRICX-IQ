# @bricx/db-bootstrap

Integration tests for the database bootstrap (ROADMAP P2-02, ADR 0035). Docker required.

```bash
pnpm test:integration   # from the repo root (turbo, never cached), or in this package
```

- `test/db-roles.int.test.ts`: the roles, privileges, schemas, extensions and publication that `infrastructure/docker/postgres/init` creates, including a real RLS proof and five sabotage cases that must each be reported. Also proves Testcontainers runs the digest-pinned Ryuk image.
- `test/powersync-health.int.test.ts`: PowerSync's healthcheck (`infrastructure/docker/powersync/healthcheck.mjs`) turns unhealthy when the publication is dropped and healthy when it is restored, and rows written while it is missing never replicate.

Both run compose.yml's images (read from compose.yml), the real init folder, `powersync.yaml` and healthcheck, and role passwords from `.env.example`; the bootstrap superuser is a throwaway identity generated per run. Checks live in `src/checks.ts` and return a list of problems. Polling is bounded; there are no fixed sleeps.
