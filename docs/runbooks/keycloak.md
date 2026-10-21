# Keycloak realm (dev stack)

The bricx realm is `infrastructure/keycloak/realm-bricx.json` (P5-01, ADR 0060). The dev stack's Keycloak is built from `infrastructure/docker/keycloak/Dockerfile` (an optimized image) and imports the file at start.

## The file is the initial state only

Keycloak imports with `IGNORE_EXISTING`: it reads the file only when the `bricx` realm does not exist yet. A change to the file does **not** reach a running stack on its own.

To apply a realm change locally (this deletes every local Keycloak user and session, and all other local stack data):

```bash
pnpm dev:reset   # deletes the local stack's volumes, keycloak-data included
pnpm dev:up      # builds the image if needed, imports the realm into the empty volume
```

Check it worked:

```bash
curl -s http://127.0.0.1:8080/realms/bricx/.well-known/openid-configuration | head -c 200
```

Shared environments never re-import over a live realm. Realm changes are applied there by the P13-01 step, with a drift check against the file (ADR 0060).

## Changing the realm

1. Edit `realm-bricx.json`. Never add human users, secret values or a literal localhost: the policy test refuses them (the one `users` entry is the worker's service account, and the one `secret` is the `${KEYCLOAK_WORKER_CLIENT_SECRET}` placeholder; P5-04, ADR 0060 section 3b).
2. Update `tooling/keycloak-realm/test/realm-policy.test.ts` if a security setting changes (tests first).
3. Run `pnpm --filter @bricx/keycloak-realm test` and `pnpm --filter @bricx/keycloak-realm test:integration`. The import test imports the file into two fresh Keycloaks and checks every value the file sets; the login test signs in headless (OTP, refresh, password reset through a test SMTP sink).
4. `pnpm dev:reset && pnpm dev:up` to see it locally.

To see what Keycloak holds, use the admin API's partial export (the integration test does the same):

```bash
TOKEN=$(curl -s -d grant_type=password -d client_id=admin-cli \
  -d username="$KEYCLOAK_ADMIN_USERNAME" -d password="$KEYCLOAK_ADMIN_PASSWORD" \
  http://127.0.0.1:8080/realms/master/protocol/openid-connect/token | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')
curl -s -X POST -H "Authorization: Bearer $TOKEN" \
  "http://127.0.0.1:8080/admin/realms/bricx/partial-export?exportClients=true&exportGroupsAndRoles=true"
```

(Load `.env` into the shell first for the admin variables.)

## E-mail (password reset)

SMTP is deployment configuration, set per environment by P13-01; the realm file sets none (ADR 0060). In the dev stack Keycloak therefore sends no e-mail, and "Forgot password?" stops at sending the link. To try a reset locally, point the running realm at Mailpit (lost at the next `pnpm dev:reset`):

```bash
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"smtpServer":{"host":"mailpit","port":"1025","from":"keycloak@bricx.local"}}' \
  http://127.0.0.1:8080/admin/realms/bricx
```

Then open the link from Mailpit's web UI at http://127.0.0.1:8025. A reset signs the user in at `acr` `pwd`, never `mfa` (ADR 0060).

## Upgrading Keycloak

Change the `FROM` digest in both stages of the Dockerfile and the `keycloak/keycloak` row in `docs/DEPENDENCIES.md` together. `check:workspace` refuses an unpinned or unlisted `FROM`. Then run the integration tests: a new version that imports the file differently fails them.
