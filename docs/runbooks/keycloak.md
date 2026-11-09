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

Four settings are the exception: the password policy and the three admin-event settings reach a running realm through `pnpm keycloak:reconcile`, which `pnpm dev:up` runs (below; ADR 0081).

Shared environments never re-import over a live realm. Realm changes are applied there by the P13-01 step, with a drift check against the file (ADR 0060): `pnpm keycloak:reconcile --check`, then the apply, for the managed settings.

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

## Realm settings on a running realm: `pnpm keycloak:reconcile` (P6-05e, ADR 0081)

Four settings reach a running realm without a reset: `passwordPolicy`, `adminEventsEnabled`, `adminEventsDetailsEnabled` and the attribute `adminEventsExpiration`. `pnpm dev:up` runs this after the stack is healthy; to run it yourself:

```bash
pnpm keycloak:reconcile --check   # prints "drift <field>" per difference, exits 1 on drift; changes nothing
pnpm keycloak:reconcile           # applies them: "applied <field>" per change, or "in sync"
```

It reads `KEYCLOAK_ISSUER`, `KEYCLOAK_ADMIN_USERNAME` and `KEYCLOAK_ADMIN_PASSWORD` from `.env`, signs in as the bootstrap admin and does a read-modify-write of the whole realm representation (only the four settings change; every other setting, attribute and client stays as it is). It prints field names, never values. It refuses a Keycloak that is not on localhost, 127.0.0.1 or [::1] unless `--allow-remote` is passed. Exit codes: 0 in sync or applied, 1 drift (with `--check`), 2 refused or failed (the message is a code such as `remote_refused` or `http_error (HTTP 401)`).

Any other change to the realm file still needs `pnpm dev:reset && pnpm dev:up` locally.

Cells (P13-01): the deploy runs `pnpm keycloak:reconcile --check --allow-remote`, then the apply, with an admin client credential from the secret store; it never re-imports. Run the database migration (0012 and later) and the worker before or with the API; the realm step is independent.

## Password policy and the denylist

The realm refuses a password shorter than 12 or longer than 128 characters, equal to the username or the e-mail, equal to one of the last five, or on the denylist (any letter case). The rules hold on every path: the user's own forms and the admin API (`POST /users` with credentials, `PUT /users/{id}/reset-password`). Existing passwords are not checked until they are changed; nobody is force-reset.

The denylist is `infrastructure/docker/keycloak/password-blacklists/bricx-common-passwords.txt`, copied into the image (not the data volume). Its `NOTICE` gives the source, licence, sha256 values and the transform. To update it, follow the NOTICE, then `pnpm dev:up` (it rebuilds the image) and the realm tests. If the file is missing from the image, Keycloak refuses to start: that is intended.

## Admin events

Every admin action (user, credential, client, role, realm changes) is recorded without its representation and kept 365 days. Read them with the admin token from above:

```bash
curl -s -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:8080/admin/realms/bricx/admin-events?max=50"
```

Locally they live in the dev-file database (`pnpm dev:reset` deletes them). P13-05 ships them to CloudWatch with the same retention.

## MFA for owners and administrators

Owners, every holder of a `finance.*` key and every holder of an org-admin key (`MFA_ADMIN_PERMISSIONS` in `@bricx/permissions/mfa`) get the realm role `bricx-mfa` from the worker and sign in with OTP. At `acr` `pwd` an admin action is 401 `permission.step_up_required`; a user's own session and device revoke (`DELETE /v1/sessions/:id`, `DELETE /v1/devices/:id`) work at `pwd`, so a lost device can always be cut off. After `pnpm db:migrate` applies 0012, start the worker: it maps the role for administrators who existed before (the backfill rows). Until it has, they get the step-up, never access without MFA.

## Lost second factor (owner or administrator)

Nobody in an organisation can reset their own OTP or anyone else's: no organisation role holds Keycloak's `manage-users`, and there is no self-approval or owner override (ADR 0067), also in a single-owner organisation. It is a platform operator procedure (P14-06 writes it in full):

1. A support request names the user and the organisation. An operator verifies the person's identity out of band (not by the account's own e-mail or phone alone).
2. A second operator approves; the requester is never the approver.
3. The operator, with realm `manage-users` in that cell, removes the user's OTP credential (Admin console → Users → the user → Credentials → Delete OTP, or `DELETE /admin/realms/bricx/users/{id}/credentials/{credentialId}`). The user keeps `bricx-mfa` and sets up a new OTP at the next sign-in.
4. The action is an admin event; the operator links it from the support ticket.

Locally (dev stack only) the bootstrap admin can do step 3 directly.

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
