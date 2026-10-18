# @bricx/keycloak-realm

Proves the bricx Keycloak realm (ROADMAP P5-01, ADR 0060). Docker (with the Compose plugin) is needed for the integration tests.

```bash
pnpm test               # policy tests on infrastructure/keycloak/realm-bricx.json
pnpm test:integration   # from the repo root (turbo, never cached), or in this package
```

- `test/realm-policy.test.ts`: every security setting in the realm file (clients, PKCE, token and session lifetimes, the MFA flow, WebAuthn, brute force, `org_id`, events), with no secrets, users or literal localhost.
- `test/normalise.test.ts`: the comparison helpers in `src/` that the import test relies on, each rule with a case that must report a problem.
- `test/realm-import.int.test.ts`: two fresh Keycloaks import the file. Every value it sets is what each one holds (admin API partial export and user profile), and both hold the identical realm. The live server refuses logins without PKCE S256, implicit logins, unknown redirect URIs, and every grant type on `bricx-api`.

Keycloak is built from `infrastructure/docker/keycloak/Dockerfile` (the optimized image compose.yml builds) and started with the command, environment and realm bind mount from `docker compose config` on the real compose.yml and `.env.example`. The bootstrap admin is a throwaway identity per run.
