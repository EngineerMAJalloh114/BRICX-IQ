# 0060. The bricx Keycloak realm as code, the optimized dev image, and the P5 phase decisions

- Status: Accepted; amended 2026-10-21 by P5-04 (ADR 0065, owner condition 2): the `bricx-worker` service account (section 3b below), so the file now holds one service-account user and one secret placeholder
- Date: 2026-10-18
- Deciders: Mohamed Abass Jalloh
- Source: P5-01. The P5 phase plan and the P5-01 task plan were approved on 2026-10-18 at 12:58Z with architect rulings D1–D10 and P5-01 conditions 1–7. Other sources: ADR 0004 (Keycloak), ADR 0019 (OpenTofu), ADR 0034 (dev stack), ADR 0042 (cold-start windows), ADR 0048 (permissions), ADR 0055 (audit), ADR 0058 (`/openapi.json`); the P4 exit rulings (point 16).

## Context

Until P5-01 the dev stack ran a placeholder realm (`bricx-placeholder`, no clients, no users) under `start-dev`, which rebuilds Quarkus on every start: about 5 minutes cold on the owner's machine (192 s augmentation + 110 s start). P5-02 needs a real issuer, audience and claims to validate tokens against.

BRICX keeps authorisation data in its own database (ADR 0048), not in tokens. Keycloak therefore cannot know which users hold finance roles, which organisation a request is for, or an organisation's idle timeout. Each of those needed a decision. The ROADMAP named an OpenTofu module (`infrastructure/tofu/modules/keycloak/*`), but nothing under `infrastructure/tofu` exists yet, and OpenTofu arrives with P13.

## Decision

### The realm file

`infrastructure/keycloak/realm-bricx.json` is a minimal realm. It names only what BRICX sets, and Keycloak fills every other field with its defaults and generated ids. It holds no human users, no secret values and no literal localhost (since P5-04 it holds one service-account user and one secret placeholder, section 3b).

1. **Realm `bricx`**: `sslRequired: external`, no self-registration, organisations feature off.
2. **`bricx-client`** (the Expo app on iOS, Android and web): public, authorization code flow only (implicit, direct access grants, device, CIBA, service accounts and token exchange off), PKCE `S256` required, `fullScopeAllowed: false`.
   - Redirect URIs (condition 6): `com.bricxiq.app://auth/callback` is fixed in the file. The web URI and origin come from the import placeholders `${KEYCLOAK_WEB_REDIRECT_URI}` and `${KEYCLOAK_WEB_ORIGIN}`.
   - Post-logout redirect URIs (architect review item 4): `com.bricxiq.app://auth/logout` and `${KEYCLOAK_WEB_LOGOUT_URI}`, in Keycloak's `##`-separated form. The import test proves no `${…}` is left in `bricx-client` after import.
   - `http://localhost:8081/...` appears only in `.env.example` as a dev-only value. A deployment that does not set one of the three variables fails closed. compose refuses to start (`:?`). Without compose, the import leaves `${…}` literal, and Keycloak 26.7.5 then refuses the client ("A redirect URI is not a valid URI", or the post-logout equivalent) and does not start. Checked live during the architect review; an earlier version of this line wrongly said the literal stayed as a URI that matches no request.
   - No wildcards anywhere.
3. **`bricx-api`**: bearer-only, every grant off (condition 5). Keycloak 26.7.5 accepts bearer-only on import. The live test proves the server refuses all of these with the client's real secret: password, client credentials, refresh, token exchange, authorization code, device, CIBA and browser logins.
   - An audience mapper (scope `bricx-api-audience`) puts `bricx-api` in `bricx-client`'s access tokens, for P5-02's `aud` check.
3b. **`bricx-worker`** (P5-04, ADR 0065, owner condition 2; amendment of 2026-10-21): the worker's service account, which ends revoked sessions through the admin API. Confidential, `serviceAccountsEnabled`, every login flow and grant off except client credentials, no refresh token, no redirect URIs, `fullScopeAllowed: false`. Its secret is the import placeholder `${KEYCLOAK_WORKER_CLIENT_SECRET}` (dev-only value in `.env.example`, passed by compose like the web placeholders; each deployment sets and rotates its own). The file's one `users` entry is the service-account user (`serviceAccountClientId: bricx-worker`) with exactly the `realm-management` client role `manage-users`, no realm role and no credential; the client scope `bricx-worker-roles` (a client-role mapper for `realm-management`, access token only) and a scope mapping limited to `manage-users` put that one role in its token as `resource_access`.
   - Why `manage-users`: `DELETE /admin/realms/bricx/sessions/{id}` requires `users().requireManage()`, and Keycloak has no narrower role for ending sessions.
   - What the live probe showed (realm-import.int.test.ts, Keycloak 26.7.5): with that token the worker ends a real session (204, then 404; the refresh token is then refused) and **cannot** map `realm-admin` to any user or to itself (403), create a client (403), list clients (403), read `realm-management`'s roles (403) or change the realm (403). It **can** map `manage-users` to another user and reset any user's password: `manage-users` is user management, so a leaked worker secret lets an attacker hand that role to a user of their own and take over accounts, though never reach `realm-admin`. Known risk, recorded for the owner; the P13-01 Also line narrows it (Keycloak's fine-grained admin permissions for a session-only scope, or a separate client for the role changes P5-05 needs, plus secret rotation). Until then the secret lives only in the deployment's secret store, and the worker holds it as a `Secret`.
4. **Tokens and sessions**:
   - Access tokens live 300 s.
   - Refresh tokens rotate (`revokeRefreshToken`, max reuse 0).
   - A refresh keeps the assurance the login reached (architect review item 2). `realm-login.int.test.ts` logs in headless and refreshes once. A `bricx-mfa` user who passed OTP keeps `acr` `mfa`, the same `auth_time` and the same session, and gets a new refresh token; the old one is then refused (`invalid_grant`). A password-only user's `acr` `pwd` stays `pwd`.
   - SSO and offline sessions end after 12 h idle, with a 7-day maximum lifespan (for architect review). Client sessions inherit both.
5. **Scopes**: the file defines every client scope the realm has. `bricx-client` gets only `basic` (`sub`, `auth_time`), `acr`, `web-origins`, `bricx-profile`, `bricx-api-audience` and `bricx-org`.
   - It gets no `roles` scope, so no role reaches a token.
   - It gets no `offline_access` scope (for architect review).
   - `bricx-profile` puts name, e-mail and locale in the ID token and userinfo only, never in the access token (for architect review).
6. **MFA for finance roles** (D5, condition 4): realm role `bricx-mfa` is a login policy flag, not an authorisation role, and P5-05 sets it. The browser flow `bricx browser` runs:
   - `auth-cookie`, ALTERNATIVE;
   - else `bricx forms`, ALTERNATIVE, made of two CONDITIONAL subflows:
     - `bricx pwd`: Condition - Level of Authentication 1, then username and password;
     - `bricx mfa`: Condition - user role `bricx-mfa` and Condition - Level of Authentication 2, then the OTP form. A user without OTP configured is sent to set it up.

   The realm attribute `acr.loa.map` is `{"pwd":1,"mfa":2}`, and `bricx-client` asks for `mfa` by default (non-essential). A `bricx-mfa` user therefore authenticates with OTP and gets `acr` `mfa`, while everyone else gets `acr` `pwd`. The `acr` scope's mapper puts it in access and ID tokens.
   - A scripted login during P5-01 confirmed both paths; the log is with the PR's proofs. The committed live login test is a P5-07 Also line.
   - P5-07 refuses finance permissions without `acr` `mfa`, with a step-up error code.
7. **WebAuthn passwordless** (architect review item 1): what P5-01 delivers is exactly the policy and registration, not sign-in.
   - Policy: user verification required, resident key required, relying party name `BRICX IQ`.
   - Registration: the required action `webauthn-register-passwordless` is enabled and is not a default action, so a user registers a passkey only when an admin or the app asks them to. The live test reads it back.
   - Sign-in: **none yet**. No browser flow has a `webauthn-authenticator-passwordless` step, so a registered passkey cannot be used to sign in; both tests assert this. The sign-in path (a passkey alternative to the password step, with `acr` mapping and a live test) is a P7-05 Also line, where the app's login screen is built.
8. **Required actions** are listed in the file, because a file that lists `requiredActions` replaces Keycloak's defaults (checked live: listing one action left only that one, plus Keycloak's disabled `delete_account`). The six enabled, none of them a default action: `CONFIGURE_TOTP` (OTP setup for `bricx-mfa`), `UPDATE_PASSWORD` (password reset), `UPDATE_PROFILE`, `VERIFY_EMAIL`, `VERIFY_PROFILE` (the declarative profile) and `webauthn-register-passwordless`. Left out, so not available: `webauthn-register` (WebAuthn as a second factor), `CONFIGURE_RECOVERY_AUTHN_CODES`, `delete_credential`, `idp_link`, `update_user_locale`, `TERMS_AND_CONDITIONS`, `UPDATE_EMAIL` (for architect review).
9. **Password reset** (architect review item 3): `resetPasswordAllowed` is on and the realm keeps Keycloak's built-in `reset credentials` flow (e-mail link, then a new password).
   - SMTP is deployment configuration, set per environment by P13-01. The file sets none, so reset e-mails are not sent in the dev stack until SMTP is pointed at Mailpit by hand (`docs/runbooks/keycloak.md`).
   - A reset never reaches `acr` `mfa`. The reset flow has no level-of-authentication step, so the session it creates is at `pwd`. `realm-login.int.test.ts` resets the password of a `bricx-mfa` user without OTP through a test SMTP sink: the token has `acr` `pwd`, still `pwd` after a refresh, and the user has no OTP credential afterwards. No flow change was needed. P5-07 refuses finance permissions at `pwd`, so a reset grants no finance access without OTP.
10. **Brute-force detection**: 5 failures, 60 s wait increments, 15 min maximum wait, no permanent lockout (for architect review).
11. **`org_id`** (D7, condition 3): the declarative user profile has an attribute `org_id` that only admins can view or edit. Its value must be a UUIDv7, and unmanaged attributes are off. Scope `bricx-org` maps it into the access token only.
   - It is the user's **default-organisation hint, not a constraint**. Until P5-05 the API uses it as the request's organisation, trusting the admin-set attribute, and grants nothing (no roles until P5-05).
   - After P5-05 the request's organisation is chosen from the user's memberships. The claim only preselects a default, and a request for an organisation the user has no membership in is refused whatever the claim says.
12. **Events**: `LOGIN_ERROR`, `CODE_TO_TOKEN_ERROR`, `REFRESH_TOKEN_ERROR` and `CLIENT_LOGIN_ERROR` are kept for 7 days. No other user events and no admin events are kept.

### How the file reaches Keycloak (condition 2)

`--import-realm` imports with the strategy `IGNORE_EXISTING`: a realm that already exists is never re-read. **The file is therefore the realm's initial state only.**
- **Dev:** a realm change reaches the stack with `pnpm dev:reset` (it deletes the `keycloak-data` volume) and then `pnpm dev:up`, which imports the file into the empty volume. See `docs/runbooks/keycloak.md`.
- **Shared environments (P13):** the file is never re-imported over a live realm, because that would lose users and sessions. A realm change is a reviewed change to the file, applied to each running realm by the P13-01 OpenTofu module (Keycloak provider) or an idempotent admin-API step in the deploy pipeline.
  - A drift check compares each live realm with the file, using the comparison `realm-import.int.test.ts` uses (every value the file sets is what Keycloak holds).
  - This is the P13-01 Also line.

### Per-organisation idle timeout (D6, condition 7)

Keycloak has no per-organisation idle timeout. The realm's 12 h is the upper bound for everyone. **A per-organisation value can only shorten it, never lengthen it.** It is enforced by the API's session check (P5-03), using the value from region configuration (P6-03 Also line).

### The optimized dev and test image (condition 1)

- `infrastructure/docker/keycloak/Dockerfile` runs `kc.sh build` on the digest-pinned `keycloak/keycloak:26.7.5` image, with build-time options health on and database `dev-file`. The second stage copies the result onto the same pinned image.
- compose.yml builds it and starts `start --optimized --import-realm --http-enabled=true --hostname-strict=false`.
- tooling/keycloak-realm's integration tests build the same file through Testcontainers. Each one takes the command, environment and realm bind mount from `docker compose config`, so there is no second copy.
- In this container the image built in about 30 s and became ready in about 20 s; the whole two-container import suite ran in about 35 s. The keycloak `start_period` floor stays 300 s (ADR 0042): a fast start still reports healthy as soon as it is.
- The image is for dev and test only (plain http on 127.0.0.1, file database). Production builds its own image at P13-01.

This amends ADR 0034's compose rules:
- A service may be built: `build:` is a block with exactly `context: ./<dir>` inside the compose directory and `dockerfile: Dockerfile`, no other option, and no `image:`.
- The Dockerfile is held to `dockerfileProblems()`. Every `FROM` is a pinned, listed image or an earlier stage, with no flags and no variable; `COPY --from` names an earlier stage; there is no `ADD`, `ARG`, `ONBUILD`, `RUN` flag or unlisted instruction.
- `../keycloak/realm-bricx.json` is the one bind mount allowed from outside the compose directory, read-only only (`sharedBindSources`). The realm file stays in `infrastructure/keycloak/` because it is the source for every environment, not only the dev stack.

### Phase decisions recorded here

- **D1, `/openapi.json` exposure per environment** (P5-01 Also line): a new config key `OPENAPI_EXPOSURE` = `public | authenticated | off`.
  - The default is `public` when NODE_ENV is development or test and `off` when it is production. `public` in production is refused at config load.
  - `authenticated` accepts any valid bearer token through the P5-02 guard.
  - P5-02 builds it. `pnpm gen:api` emits the document from a stub app and never calls the route, so `off` cannot break client generation.
- **D3, audit events with no organisation** (from `pending.md`, needed by P5-02): no `audit_events` row.
  - A failed token or sign-in with no known organisation writes one structured security log line through the redacting logger (P5-02): a reason code and the correlation id, never the token and no personal data.
  - Keycloak keeps its own login-failure events (setting 12).
  - P13-05 alerts on the line. Revisit at P14-05.
- **D4, the OpenTofu module**: moves to P13-01, where OpenTofu arrives. Until then the realm file is the single source.
- **D2, single-member SoD**, stays in `pending.md`: option (a) is recommended, and the owner confirms before P5-07.

### `nosemgrep` only in test code (P4 point 16)

`check:workspace` refuses a `nosemgrep` (or `nosem`) comment in any file except Markdown and files under a `test`, `tests`, `__tests__`, `fixtures`, `guard-fixtures` or `selftest` directory or named `*.test.*`.

The one suppression outside tests was in `scripts/pr-title-step.mjs`. It now writes the step to a file and runs `bash -e <file>`, as GitHub runs `bash -e {0}`, so the rule has nothing to flag. `scripts/semgrep.mjs`'s failure message now says suppressions are for test code only.

## Consequences

Positive:
- The realm is reviewable and reproducible: two fresh imports hold the identical realm, and every value the file sets is read back.
- Keycloak starts in seconds in dev and CI instead of minutes.
- Tokens carry no roles and no personal data, only `sub`, `aud`, `acr`, `org_id` and `auth_time`.
- MFA is decided by BRICX (the `bricx-mfa` flag), and `acr` tells the API whether it happened.

Negative:
- `IGNORE_EXISTING` means a realm change needs `pnpm dev:reset` locally, which deletes every local Keycloak user, and a separate apply step in shared environments (P13-01).
- The comparison is a subset check plus import-to-import equality, not a full export diff. A default that Keycloak changes in a new version is not caught unless the file sets that field. (for architect review)
- One more locally built image: the first `pnpm dev:up` after this change builds it (about 30 s here).
- Until P5-05 the request's organisation comes from an admin-set attribute.
- A user with `bricx-mfa` but no OTP configured is forced to set it up at their next login. P5-05's grant flow must say so.
- Passkeys can be registered but not used to sign in until P7-05 adds the sign-in step.
- The worker's service account holds `manage-users`, which is wider than ending sessions (section 3b): a leaked `KEYCLOAK_WORKER_CLIENT_SECRET` is an account-takeover risk until P13-01 narrows it.
- A password reset signs the user in at `pwd`. A `bricx-mfa` user then has no finance access until they sign in with OTP.
- The six required actions are fixed by the file. Enabling another one (for example recovery codes) is a reviewed change to the file.

## Alternatives rejected

- **A full realm export as the file**: thousands of generated lines no one can review.
- **`start-dev` with longer timeouts** (the architect's fallback): about 5 minutes per cold start, every time.
- **The OpenTofu module now**: a new tool pin and provider ADR two phases early, with nothing yet to apply it to.
- **TOTP for every user**: field workers on shared devices pay for a control only finance roles need.
- **Step-up by `acr_values` only, with no role**: the app would have to know which actions need MFA before calling the API. With the role, users with finance roles always authenticate at `mfa`.
- **`bricx-api` as a confidential client with every flow off**: also refuses every grant, but each flag is a separate switch to get wrong. Bearer-only refuses every grant at once, even with the secret Keycloak generates for the client (the live test uses it).
- **Moving the realm file into `infrastructure/docker/keycloak/`**: avoids the shared bind mount, but makes a dev-stack folder the source for production.
