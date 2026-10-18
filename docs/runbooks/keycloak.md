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

1. Edit `realm-bricx.json`. Never add users, secrets or a literal localhost: the policy test refuses them.
2. Update `tooling/keycloak-realm/test/realm-policy.test.ts` if a security setting changes (tests first).
3. Run `pnpm --filter @bricx/keycloak-realm test` and `pnpm --filter @bricx/keycloak-realm test:integration`. The integration test imports the file into two fresh Keycloaks and checks every value the file sets.
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

## Upgrading Keycloak

Change the `FROM` digest in both stages of the Dockerfile and the `keycloak/keycloak` row in `docs/DEPENDENCIES.md` together. `check:workspace` refuses an unpinned or unlisted `FROM`. Then run the integration tests: a new version that imports the file differently fails them.
