# 0077. Secure invitations

- Status: Accepted
- Date: 2026-11-10
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP P6-06 (scope split by the owner 2026-11-10: member lifecycle is P6-06b); P6-06 task plan approved 2026-11-10 10:28Z with rulings G1–G10 and owner conditions C1–C10; supersedes phase ruling R7 (2026-11-06, "no invitation token"); ADR 0055 (audit), 0056 (outbox), 0060 and 0081 (realm), 0064 (admin client), 0066 (memberships, `app.mfa_state()`), 0067 (SoD, D2 second approver), 0071 (directory), 0073 (region config), 0074 (adapter registry), 0080 (rate limiting)

## Context

Before P6-06 a member was added with `POST /v1/members {userId, roleId}`: an administrator put an existing cell user into the organisation without that person's consent, and there was no way to reach someone who had no account yet. The owner's scope update (2026-11-10) asks for invitations by e-mail with a single-use token, and moves the member lifecycle (suspend, bulk invite, ownership transfer, activity history, external and temporary memberships, DNS TXT domain verification) to P6-06b.

Audit findings (plan §A), recorded here as the task's first Done-when:

1. Memberships (ADR 0066) refused escalation (`refuse()`/`holdsAll`) but **`update()` had no self check**: a member holding `org.member.update` could change their own role.
2. The cell `users` table stores no e-mail; access tokens carry no `email` or `email_verified` (the profile mappers set `access.token.claim` false); the realm has `registrationAllowed: false`.
3. There was no e-mail adapter kind (SES is P12; Mailpit runs in the dev stack).
4. Organisations have only `archived_at`: "suspended" means archived until P6-06b.
5. Failed authorisations were warn lines only, never audited.
6. The `invitation` rate-limit class (ADR 0080) already existed and fails closed.

No second membership or permission system is added: an accepted invitation inserts into `memberships` / `project_memberships` through the memberships module's public API.

## Decision

### Roles (C1)

Product names map to existing system roles: Engineer = `site_engineer`, Contractor = `subcontractor`, Supervisor = `foreman`, Architect = `consultant`. Worker is not a login role (P10-04). UI labels come with P7.

A new system role **`viewer`** (13 system roles). Its bundle is an explicit allowlist, `VIEWER_KEYS` in `@bricx/permissions/roles`:

| Key | Scope |
|---|---|
| `org.region_config.read` | org |
| `project.project.read`, `project.site.read`, `project.task.read`, `project.milestone.read` | project |
| `field.dailylog.read`, `field.photo.read`, `field.drawing.read` | project |
| `supply.material.read` | org |
| `supply.material_request.read`, `supply.goods_receipt.read`, `supply.inventory.read` | project |
| `document.file.read` | project |

Every other catalogue resource with a read action is in `VIEWER_DENIED` with its reason: organisation settings, members, roles, audit, sessions and elevations (administrators' views), project members, attendance (workers' personal data), purchase orders (commercial terms), every `finance.*` resource and dashboards (they aggregate finance figures). A completeness test fails when a new read resource is in neither list, and a rule test fails if a finance or member key enters the bundle. Migration 0013 widens the `roles_system_key` CHECK (NOT VALID, VALIDATE, drop the old one) and backfills one `viewer` role with exactly these keys into every organisation that has system roles (G1); where a custom role already holds the key `viewer`, the system one is keyed `system_viewer`. `app.viewer_keys()` is the SQL copy of `VIEWER_KEYS`, compared by `migration-0013.int.test.ts`.

### D1. The token

`<cellId>.<secret>`: the secret is 32 bytes from the CSPRNG as 43 base64url characters; the cell id is public already (directory answers). The database stores only `token_hash = SHA-256(secret bytes)` (bytea, unique). The API finds the row through `app.invitation_by_token_hash(hash)`: SECURITY DEFINER as `bricx_owner` through the owner read policy, EXECUTE for `bricx_app` only, returning id, organisation and inviter only (the inviter is the `withTx()` user of the work that follows). The API then compares the stored hash in constant time inside that organisation's `withTx()`. A malformed token (length bounded first) is refused before any SQL.

### D2. Where the token travels

The link is `<INVITE_LINK_BASE>/invite#<token>`: the token is in the URL fragment, which browsers never send to a server, a proxy or a Referer. The client (P7) removes it with `history.replaceState` and serves the page with `Referrer-Policy: no-referrer`. The API takes the token only in a POST body. The e-mail names no organisation or project: the link and the expiry time only.

### D3. Finding the cell

`GET /v1/directory/resolve?cell=<cellId>` answers the cell's `apiBaseUrl` and `keycloakUrl` and nothing about any organisation; an unknown cell is the same 404 as before.

### D4. The worker mints the token

The outbox payload of `invitations.send` is `{invitationId, sendSeq, invitedBy}`: no token or address in the outbox, its logs or the API process. The worker mints with a conditional `UPDATE … SET token_hash WHERE status = 'pending' AND send_seq = $seq AND expires_at > now RETURNING` and only then sends. A stale send (its `send_seq` behind the row's) mints nothing (C7, S20). A retry mints again: the earlier token of the same send dies, which is safe because the e-mail carries the token of its own attempt.

### D5. E-mail

A new `email` adapter kind in the P6-04 registry, with no new package: `null` (tests; records a keyed hash of the recipient, never the address or text) and `mailpit` (dev; Mailpit's HTTP send API through `fetch`, a `nullAdapter`, so the registry refuses it in production, and the worker config refuses `MAILPIT_URL` in production too). The message is in the organisation's default language and time zone (`@bricx/i18n`; a zone the runtime lacks falls back to UTC, named in the format).

**Launch blocker (G3):** production has no e-mail adapter until P12 adds SES (P12 Also line). Until then an invitation send fails and is retried with the outbox backoff, never dropped. Keycloak's own SMTP (needed for the activation e-mail, D6) is deployment config (P13-01) and is unset in the realm file. Invitations are therefore **not production-ready** until both exist.

### D6. Accounts: activate and accept (G4, C2, C3)

- `POST /v1/invitations/activate {token}`: `@Public`, rate-limit class `invitation` (ip limit; fails closed with 503 when Valkey is unavailable). It always answers the same 202. A live token is counted, at most **3** activations per invitation (C7, S19), and writes one `invitations.activate` outbox row (ids only). The worker reads the pending address and, in the organisation's cell Keycloak: no account with that exact e-mail → create one, unverified, with required actions `VERIFY_EMAIL` and `UPDATE_PASSWORD`, and send Keycloak's execute-actions e-mail; an unverified account → send its pending actions again (`VERIFY_EMAIL` first); a verified or disabled account → nothing (a verified user signs in). Two accounts with that exact e-mail is an error, never a guess. No account exists for anyone who never clicks the link.
- **The worker's service account (C2):** `bricx-worker`, one per cell, holds the realm-management client roles `manage-users` and `view-users` only (Keycloak expands `view-users` into its composites `query-users` and `query-groups` in the token). They are declared in `realm-bricx.json` (the service-account user's client roles and the client's scope mappings); `realm:reconcile` applies them to a running realm and reports `serviceAccount.bricx-worker` / `scopeMappings.bricx-worker` drift, and fails with `still_drifting` if anything remains. The client secret is configuration only (`KEYCLOAK_WORKER_CLIENT_SECRET`), never in the realm file.
- `POST /v1/invitations/accept {token}`: `@SignedIn` (no org membership needed), rate-limit class `invitation`. The caller's verified e-mail is read from the cell Keycloak's **userinfo** endpoint with the caller's own bearer token (C3): the URL comes from the cell config only (`auth.userinfoUrl`, derived from `KEYCLOAK_ISSUER`), never from a token or the request; `userinfo.sub` must equal the token's `sub` (S18); `email_verified` must be exactly the boolean `true`; the address goes through the same normaliser as the invitation (trim, NFKC, lower case, ≤ 254); nothing is cached (each accept asks again: proven live by flipping `emailVerified` under one access token). 2 s timeout; a 401/403 from userinfo is 401 for the caller, anything else 503. This keeps e-mail out of every access token (the rejected alternative).
- Limitation: Keycloak is per cell, so a person invited into a second cell gets a second account there.

### D7. Single use and concurrency

One transaction in the invitation's organisation: the row is read `FOR UPDATE` with its hash compared; the conditional `UPDATE … SET status = 'accepted', accepted_by, accepted_at, email_normalised = NULL, token_hash = NULL WHERE status = 'pending' AND expires_at > $now` (the injected Clock) settles it; the membership is inserted against `memberships_open` / `project_memberships_open` (an existing member is outcome `already_member`, their role untouched; a missing project row is added); one `users.mfa_check` row and one `org.invitation.accept` event. 20 concurrent accepts give exactly one membership and no 5xx (S11).

### D8. The uniform failure

Unknown, malformed, expired, revoked or accepted token, another cell, an address mismatch, an unverified address, another `sub`, a self-invite, an inviter who lost the rights, an archived project or organisation: accept answers the same 404 `invitation.unavailable` body (only the trace id differs) and activate the same 202. The reason goes to a structured log line with the invitation id only.

### D9. The table (migration 0013)

`bricx.invitations`: `id` (UUIDv7), `org_id`, `project_id`, `email_normalised`, `role_id`, `project_role_id`, `token_hash`, `send_seq`, `resend_count`, `activation_count`, `last_sent_at`, `expires_at`, `status` (`pending`/`accepted`/`expired`/`revoked`), `invited_by`, `accepted_by`/`accepted_at`, `revoked_by`/`revoked_at`, `revoke_reason` (`manual`, `inviter_removed`, `inviter_lacks_rights`, `project_archived`, `org_archived`), `created_at`, `updated_at`; CHECKs tie each status to its columns. Foreign keys carry `org_id` (roles and projects by `(org_id, id)`).

- FORCE RLS, resource `org.member`. `bricx_app` may INSERT and SELECT, and UPDATE only the mutable columns (column grants). It keeps the default DELETE grant, but there is no DELETE policy, so a DELETE matches no row (the `rls.ts` convention for tenant tables; proven in `migration-0013.int.test.ts`).
- **The guard trigger (C6), SQLSTATE P6006, for every role:** id, organisation, project, roles, inviter and `created_at` never change; a settled row never changes again; `email_normalised` changes only to NULL and only together with `status = 'accepted'`.
- One pending invitation per (org, project, address): a partial unique index; a concurrent duplicate is 23505 on the index, so the API answers 409, never 500.
- The address is set to NULL on accept (`accepted_by` names the person) and kept on expired and revoked rows so an administrator can invite again; a retention purge is a P13 Also line.
- Not synced: `org.member` has no sync stream, and no stream names an invitation (a test in `@bricx/permissions`).

### D10. Expiry

Default 72 hours; a new org-only region-config field `invitationTtlHours` (column `invitation_ttl_hours`, NULL on every row unless the org row sets 1..168; the CHECK is `IS NULL OR (BETWEEN 1 AND 168 AND project_id IS NULL)`). Expiry is lazy: a pending row past `expires_at` is refused at accept and shown as expired. The worker's sweep runs every 60 s (one BullMQ job scheduler): `app.invitations_due(limit)` (SECURITY DEFINER, EXECUTE for `bricx_relay` only; `now()` of the database; at most 1000, the sweep asks for 100), then each row is expired as `bricx_app` in its organisation with one `org.invitation.expire` event, actor `system`. The plan named `app.invitations_due(now, limit)`: the database clock was kept, because the relay's read and the expiring `UPDATE` must agree on "due".

### D11. Resend

`POST /v1/invitations/:id/resend` (`@Idempotent`): `send_seq + 1`, `resend_count + 1`, a fresh expiry, at most `INVITATION_MAX_RESENDS` (default 5, at most 20) resends, then 409 `invitation.resend_limit`. **The old token dies at the resend itself** (`token_hash` set to NULL in the same `UPDATE`); the worker mints the next one for the new send. The plan said the old token dies at the next mint; the integration suite showed that leaves it usable until the worker runs, so the resend now kills it (S8).

### D12. Duplicates

A second pending invitation for the same (org, project, address) is 409 `invitation.pending_exists` with the existing invitation in the `Location` header (administrator-facing; the index is the backstop). An existing member cannot be recognised at invite time (the cell stores no addresses): at accept they get `already_member`.

### D13. Escalation, finance and the self-change guard (C5, C8)

- Create needs `org.member.invite` at org scope and every key of the role (`holdsAll`); a project invitation also needs `project.member.assign` at that project and every key of the project role. So finance keys are granted only by an inviter who holds them, and these routes need the MFA step-up (ADR 0081). `role_id` is required: there is no default role. SoD still applies at action time (ADR 0067).
- At accept the inviter is checked again (still an open member holding the invite key and every key granted). If not, the invitation is revoked as `inviter_lacks_rights`, with its audit events, and the caller gets the uniform 404. An inviter accepting their own invitation is refused (`self_invite`).
- **Self-change guard (C5):** no member changes or assigns their own role: `PATCH /v1/members/:id`, and `POST`/`PATCH` of project members, where the target is the caller, are 403. Owners included: an owner steps down only by another owner's change, so the sole owner's self-demotion is now 403 (it was 409 under the last-owner rule, which stays behind the guard). **Leaving** (`DELETE` of one's own membership) is not a role change and stays allowed, under the last-owner rule (409).
- **`org.invitation.denied` (C8):** a refused escalation, self role change, inviter-lacks-rights or self-invite writes one event, in a transaction of its own, for the first refusal per (org, actor, reason) in each 15-minute bucket: a Valkey key `bricx:denied:<org>:<actor>:<reason>` set with `SET NX EX 900`. The reasons are a closed enum (`escalation`, `self_role_change`, `inviter_lacks_rights`, `self_invite`); anything else is a programming error. Later refusals in the bucket are debug lines; Valkey down means no event and one warn line, and the refusal stands. Public bad-token attempts are logs and the rate limit, never audit.

### D14. Cascades, in the same transaction

Removing a member revokes the pending invitations they sent (`inviter_removed`); archiving a project revokes its pending invitations (`project_archived`); archiving the organisation revokes all of them (`org_archived`). One `org.invitation.revoke` event per revoked row.

### D15. No new permission keys (G5)

`org.member.invite` covers create, resend and revoke; `org.member.read` covers the list; `project.member.assign` covers project invitations. `MFA_ADMIN_PERMISSIONS` and `app.mfa_admin_keys()` are unchanged.

### D16. Routes; `POST /v1/members` retired (G2, C9)

`POST /v1/invitations {email, roleId, projectId?, projectRoleId?}`, `GET /v1/invitations?status&projectId&cursor&limit≤100` (newest first), `GET /v1/invitations/:id`, `POST /v1/invitations/:id/resend`, `DELETE /v1/invitations/:id` (revoke; idempotent), plus activate and accept; all in rate-limit class `invitation`. `POST /v1/members` is retired (404): it added a user without consent. The bootstrap CLI and the seed keep their database path. Test suites that used the route for setup now use a shared `addMember()` helper (`apps/api/test/support/members.ts`) that inserts exactly the row an accepted invitation leaves; the route's escalation assertions moved to the invitation suite (the PR maps each old assertion to its new test).

### D17. Audit

`org.invitation.create`, `.resend`, `.revoke`, `.accept`, `.expire` and `.denied`: actor, subject the invitation (or the membership, for a self change), organisation, correlation id; before/after hold status, roles, project, expiry, counts and outcome. **Never** the address, the token or its hash.

### D18. i18n

`errors`: `invitation.unavailable`, `invitation.pending_exists`, `invitation.resend_limit`; `common`: `invitation.email.subject`, `.body`, `.expires`; en, fr and ar (fr and ar machine-drafted, native review before production). `packages/i18n/src/catalog.ts` imports its JSON with `with { type: "json" }` so the worker can load it under Node's ESM loader (for architect review; Metro and Hermes are checked at P7).

### Notifications (C4)

Notices of accept, expiry and revoke to the inviter, and the member-joined notice, are **deferred to P12** (P12-01 builds them): the cell stores no e-mail for existing users and there is no in-app channel yet.

## Done-when: the 15 items and their red-first tests

| # | Item | Test |
|---|---|---|
| 1 | Audit findings recorded | this ADR, Context |
| 2 | 32-byte CSPRNG token, hash only, constant-time compare, single use, Clock expiry, TTL 72 h (org 1..168) | `packages/db/test/invitations.test.ts`; `apps/api/test/modules/invitations.int.test.ts` (accept, reuse, expiry); `packages/db/test/migration-0013.int.test.ts` (TTL CHECK) |
| 3 | Statuses, lazy expiry, the sweep with audit | `apps/api/test/modules/invitations.int.test.ts`; `apps/worker/test/invitations.int.test.ts` (sweep) |
| 4 | Resend rotates (old token dead at once), bounded, idempotent | `apps/api/test/modules/invitations.int.test.ts` (resend) |
| 5 | One pending per (org, project, address), index-backed; existing member | `migration-0013.int.test.ts` (concurrent insert); `invitations.int.test.ts` (409 with Location, `already_member`) |
| 6 | Verified address equal to the invited one; uniform error; 20 concurrent accepts give one membership | `apps/api/test/invitations-accept.int.test.ts` (live userinfo); `invitations.int.test.ts` (uniform 404, concurrency) |
| 7 | No token or org detail in link, subject, logs, outbox, errors | `invitations.int.test.ts` (leak scan); `apps/worker/test/invitations.int.test.ts` (log scan); `apps/worker/test/invitations.test.ts` (message) |
| 8 | Cell hint; activate `@Public`, ip-limited, fails closed | `apps/api/test/modules/directory*.test.ts` (`?cell=`); `apps/api/test/rate-limit.int.test.ts` (Valkey paused: 503); `apps/worker/test/invitations.int.test.ts` (account and e-mail through Keycloak) |
| 9 | Edge cases: expiry, revoke, resend ×6, existing account, existing member, another account, inviter removed or demoted, project or org archived, reuse | `invitations.int.test.ts`, one test each |
| 10 | No escalation; no self role change; a change applies on the next request | `invitations.int.test.ts`; `apps/api/test/modules/memberships.int.test.ts` (C5) |
| 11 | Finance keys only from an inviter who holds them; step-up | `invitations.int.test.ts` (escalation, acr `pwd`) |
| 12 | Migration 0013: FORCE RLS, `org_id`, indexes, viewer CHECK and backfill, definer grants | `migration-0013.int.test.ts`; `packages/db/test/rls.int.test.ts`, `grants.int.test.ts`; `packages/permissions/test/roles.test.ts` (C1) |
| 13 | Audit fields with no token; denied events deduplicated | `invitations.int.test.ts`; `apps/api/test/modules/invitations.test.ts` (recorder) |
| 14 | Outbox in the same transaction, retry with backoff, no token in the payload | `apps/worker/test/invitations.int.test.ts` (a failing adapter retries, then sends) |
| 15 | i18n keys; seed counts (13 roles) | `pnpm i18n:check`; `packages/db/test/seed*.test.ts` |

## Threats

| Threat | Control |
|---|---|
| A forwarded or leaked link | Only an account whose verified mailbox is the invited address can accept; activate only mails the real address (at most 3 times) |
| Mailbox takeover | Out of scope here (the mailbox is the identity); MFA step-up for administrators |
| Enumeration | Uniform 404/202 bodies; activate rate-limited per ip; tokens 256-bit |
| E-mail bombing | Resend cap, activation cap, rate-limit class `invitation` |
| Escalation through an invitation | `holdsAll` at create, inviter re-check at accept, self-change guard, denied events |
| Token theft at rest or in transit | Only the hash is stored; the token is in the URL fragment and a POST body, never logs, outbox or audit (scanned in the suites) |
| Cross-tenant use | FORCE RLS; the lookup returns the org and all work runs in that org's `withTx()` |
| Cross-cell | The token names its cell; another cell's API refuses it uniformly |

## Residuals (accepted)

- New personal data: invitee addresses in the cell until accept (then NULL), kept on expired and revoked rows until the P13 retention purge.
- A person invited into two cells has two Keycloak accounts.
- Until SES (P12) and Keycloak SMTP (P13-01), production sends nothing (launch blocker).

## Consequences

- `@bricx/permissions`: `viewer`, `VIEWER_KEYS`, `VIEWER_DENIED`; generated outputs regenerated.
- `@bricx/db`: migration 0013, `@bricx/db/invitations` (token helpers, definer calls, mint, expire, revoke cascades).
- `@bricx/adapters`: the `email` kind (`null`, `mailpit`).
- `apps/api`: the invitations module, the memberships self-change guard and removal cascade, project and organisation archive cascades, `?cell=` on directory resolve, `DenialRecorder`; OpenAPI and `@bricx/api-client` regenerated.
- `apps/worker`: queue `invitations` (send, activate, sweep), `@bricx/i18n` as a workspace dependency.
- `realm-bricx.json` and `realm:reconcile`: the service account's roles and drift check.
- P6-06b holds the member lifecycle and DNS TXT domain verification (G6); the D2 onboarding prompt moved to P7 (G6).

## Alternatives considered

- **E-mail claims in the access token** instead of userinfo (G4): rejected; every token would carry an address.
- **The API mints the token** (D4): rejected; the token would pass through the API process and the outbox.
- **New `org.invitation.*` keys** (G5): rejected; no new capability, and the MFA admin key set stays as it is.
- **Keep `POST /v1/members` until P6-06b** (G2): rejected; it adds users without consent.
- **No viewer backfill** (G1): rejected; every existing organisation would lack the role until a reset.
- **A public accept** (G10): rejected; accept needs a signed-in, verified identity, and the public route only mails the invited address.
