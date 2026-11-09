# 0081. Keycloak realm hardening

- Status: Accepted
- Date: 2026-11-09
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP P6-05e (ADR 0079, finding S2); P6-05e task plan approved 2026-11-09 14:59Z with rulings Q1–Q5 and owner conditions C1–C8; ADR 0060 (realm as code, the `bricx-mfa` role and `acr`), 0066 (`app.mfa_state()` and the worker mapping), 0067 (v2, elevations), 0068 (the 401 step-up), 0056 (outbox), 0076 (seed)

## Context

ADR 0079 finding S2: the realm had no `passwordPolicy`, `adminEventsEnabled` was false, and MFA was required only of users with finance permissions. Organisation owners already got `bricx-mfa` (`app.mfa_state()` counts the owner role), but two gaps remained:

1. A custom role holding administration keys and no finance key (an "administrator") never got `bricx-mfa`.
2. The API asked for `acr` `mfa` only on `finance.*` keys. So an owner at `acr` `pwd` could change members, roles, other users' sessions and the organisation. That happens before the worker maps the role, or after a password reset (ADR 0060 §8).

The realm is imported with `IGNORE_EXISTING`, so a change to the file never reaches a running realm by itself.

## Decision

### Password policy

`length(12) and maxLength(128) and notUsername(undefined) and notEmail(undefined) and passwordHistory(5) and passwordBlacklist(bricx-common-passwords.txt)`

- **Length 12** (Q3). Most users sign in with a password alone (`acr` `pwd`).
  - **Gap, recorded:** NIST SP 800-63B-4 asks for 15 characters when a password is the only factor and 8 with MFA. 12 is the field-worker compromise for typing on phones. P14-01 revisits it (Also line).
- **maxLength 128** bounds the hashing work per request (Keycloak 26 hashes with Argon2), and passphrases still fit.
- **notUsername and notEmail:** a password equal to either is refused.
- **History 5:** the password must differ from the last five (live: the 6th back is allowed again).
- No composition rules and no expiry. NIST 800-63B advises against both, because they push users towards predictable patterns.
- **The admin path is held to the policy (C7).** Live on Keycloak 26.7.5, a password set through the admin API is refused for every rule, on user creation and on `reset-password`. The user's own update-password form refuses the same passwords. This is a check that passed, not a finding, so no extra control was needed.

### The denylist (Q5)

The first choice was the NCSC "100k most used passwords" list (from Have I Been Pwned). Its redistribution in a public repository is not clearly permitted:
- the NCSC page that published it has been removed;
- NCSC's Open Government Licence excludes third-party material;
- the HIBP Terms of Use (clause 2.1.4(d)(iii)) restrict distributing HIBP data.

As ruled, the realm uses the **SecLists `10k-most-common.txt` list (MIT)** instead.
- It is lowercased, LF-only, sorted and unique: 10,001 lines.
- It is committed as `infrastructure/docker/keycloak/password-blacklists/bricx-common-passwords.txt`.
- The `NOTICE` beside it gives the source URL, the upstream sha256, the transform and the licence text.
- Nothing is downloaded at runtime.

**Gap, recorded:** only 10 of the 10,001 entries are 12 characters or longer, so with `length(12)` the list adds little beyond the length rule. P14-01 revisits the list together with the length (a larger list with a clear licence).

Keycloak checks the list through a Bloom filter, with a false-positive probability of 1e-4 (its log line). About one strong password in 10,000 is therefore refused; the user simply chooses another one.

**Delivery.** Keycloak reads lists from `data/password-blacklists/` by default, but that folder is inside the `keycloak-data` volume. That volume has the P5-02b nested-mount defect, and an existing volume never receives new files from the image. So:
- the Dockerfile copies the file to `/opt/keycloak/conf/password-blacklists/`;
- the Dockerfile sets `KC_SPI_PASSWORD_POLICY__PASSWORD_BLACKLIST__BLACKLISTS_PATH` to that folder;
- both stages stay `FROM` the same digest-pinned `keycloak/keycloak:26.7.5` image.

Every place that runs Keycloak gets the list from this one Dockerfile:
- compose builds it, and `pnpm dev:up` now runs `up --build`, so a changed Dockerfile reaches the dev stack;
- the Testcontainers suites build the same file;
- P13-01's production image copies the same file and sets the same option (Also line).

**Fail closed (C7).** If the file is missing, Keycloak exits 1 at the import, with "Password denylist bricx-common-passwords.txt not found". If the folder is missing, it exits 1 with "Password denylists location does not exist". It never starts without the list. The live test proves the first case, and sabotage S5 proves the second.

### Admin events

- `adminEventsEnabled` is true and `adminEventsDetailsEnabled` is false, so no representation is stored.
- Live, creating a user with a password, resetting it and regenerating a client secret each produce an admin event (`CREATE`/`ACTION` with the resource path). None of the three secret values appears anywhere in the events, and no event carries a representation.
- **Retention is 365 days,** through the realm attribute `adminEventsExpiration` (31,536,000 s).
- **Today** the events live in each cell's Keycloak database (dev-file locally, where `pnpm dev:reset` erases them).
- **From P13-05** (Also line) the `jboss-logging` listener sends them to CloudWatch with the same retention, plus an alarm on admin actions by an unexpected client.
- Login events stay as they are (Q4).

### MFA for owners and administrators: the per-key flag, pulled forward from P13-01

`@bricx/permissions/mfa` gains `MFA_ADMIN_PERMISSIONS`, the admin permissions below, and `MFA_ADMIN_KEYS`, their catalogue keys at every scope. `requiresMfa()` is true for a `finance.*` key or one of these. Every caller already goes through `requiresMfa()`, so nothing else changes:
- the authorization guard asks for `acr` `mfa` (`can.guard.ts`, unchanged);
- the membership response computes `mfaRequired`;
- a role edit fans out `users.mfa_check` (`roles.service.ts`, now `mfaKeysChanged`).

**Who is an owner or administrator.**
- Owner: an open membership whose role has `system_key` `owner`, as before.
- Administrator: any user whose effective keys hold an admin key, whether from a role bundle, a project override or an access grant. The rule is key-based because the eleven non-owner system roles are editable copies and a custom role can be renamed.

**Completeness (C2).** `isAdminClass(permission)` is the pattern:
- any action but `read` on an `org.*` resource, `project.member` or `project.role`;
- every `export`, `manage`, `grant`, `invite`, `assign`, `revoke`, `remove` or `share` action anywhere.

A catalogue permission that matches the pattern must be `finance.*`, be in `MFA_ADMIN_PERMISSIONS`, or be in `ADMIN_CLASS_EXEMPT` with a reason. Otherwise the permissions test fails, so a key P6-06 adds cannot slip through. Today's catalogue:

| Permission | Scopes | MFA | Reason |
|---|---|---|---|
| `org.organization.update`, `org.organization.archive` | org | yes | organisation settings |
| `org.member.invite`, `org.member.update`, `org.member.remove` | org | yes | members |
| `org.role.manage` | org | yes | roles |
| `org.session.revoke` | org | yes | other users' sessions |
| `org.access_grant.grant`, `org.access_grant.revoke` | org | yes | elevations |
| `org.region_config.update` | org | yes | region configuration |
| `org.audit.export` | org | yes | export |
| `project.member.assign` | org, project | yes | project member management (project_owner and project_manager already need MFA through finance keys) |
| `report.dashboard.export` | org, project | yes | export |
| `finance.ledger.export` | org | yes | `finance.*` (always) |
| `document.file.share` | org, project, site | no (exempt) | shares a file with people who can already reach its project or site; no route uses it before P8-06, which decides external sharing and its MFA rule (P8-06 Also line) |
| `org.organization.read`, `org.member.read`, `org.role.read`, `org.audit.read`, `org.session.read`, `org.access_grant.read`, `org.region_config.read`, `project.member.read` | as listed | no | reads change nothing |

The catalogue has no project-scope role-management key today. A future `project.role.*` key is admin-class by the pattern.

**Self-service (C1).** A user's own sessions and devices have no catalogue key:
- `DELETE /v1/sessions/:id` and `DELETE /v1/devices/:id` are `@NoPermission` routes;
- a user who lost a device revokes it at `acr` `pwd` (live: 204);
- revoking another user's sessions (`POST /v1/users/:userId/sessions/revoke`, `org.session.revoke`) is the 401 step-up.

**The SQL rule (migration `0012_mfa_admin_keys`, hand-written, forward-only).**
- `app.mfa_admin_keys()` is the SQL copy of `MFA_ADMIN_KEYS`; the live test compares them.
- `app.mfa_finance_held(uuid)` is 0007's v2 rule, unchanged.
- `app.mfa_admin_held(uuid)` checks the same three places (org memberships, project memberships after overrides, open elevations) for an admin key.
- `app.mfa_state()` v3 is the v2 rule or the admin rule. It keeps its signature, owner, definer, `search_path` and its EXECUTE grant (`bricx_relay` only); this amends ADR 0066 and 0067.
- The three helpers are plain SQL, owned by `bricx_owner`, with a pinned `search_path` and EXECUTE revoked from PUBLIC.

**Backfill (C3).** 0012 writes one `users.mfa_check` outbox row per user whose v3 answer is true and v2 answer was false (`mfa_admin_held AND NOT mfa_finance_held`).
- **Under FORCE RLS.** The migrator runs as `bricx_owner`, which has no INSERT policy on `bricx.outbox`. The migration's own transaction:
  1. creates two narrow owner policies, both limited to `topic = 'users.mfa_check'`: INSERT, and SELECT (PostgreSQL 18 checks SELECT policies for the `ON CONFLICT DO NOTHING` arbiter; found live, the first draft without it failed with 42501);
  2. inserts the rows;
  3. drops both policies before COMMIT.

  No other session sees the policies: CREATE POLICY holds the table lock until COMMIT, so outbox writers wait for the migration's few statements. FORCE stays on and no BYPASSRLS role is used. The test asserts that the outbox's policies and FORCE are unchanged afterwards, and that `bricx_owner` still cannot insert.
- **Bounded and idempotent.**
  - The selection reads only the two helpers, so a rerun selects the same users.
  - Each id is a UUIDv7 derived from the user id (fixed time prefix 2026-11-09, md5 bits). It is also the relay's BullMQ job id.
  - `ON CONFLICT (id) DO NOTHING` keeps a rerun from adding rows (live: the block run twice).

**Deploy order and the window (C3).**
1. `pnpm db:migrate` (0012) with the new API.
2. The worker drains the backfill rows and maps `bricx-mfa`.
3. `pnpm keycloak:reconcile` for the realm settings (independent of 1 and 2).

Between 1 and 2, a newly covered administrator who signs in gets `acr` `pwd` and the 401 step-up on admin actions. They are offered OTP setup only at their next login after the mapping lands. The window is the relay's poll plus one Keycloak call (231 ms measured in ADR 0066), or longer if the worker is down. In that case it fails closed: admin actions are refused, never allowed without MFA.

### How a running realm receives the change (C5)

`pnpm keycloak:reconcile [--check] [--allow-remote]` (`tooling/keycloak-realm/src/reconcile.ts`, plain fetch, no dependency) manages exactly `passwordPolicy`, `adminEventsEnabled`, `adminEventsDetailsEnabled` and the attribute `adminEventsExpiration`.

- **Read-modify-write.** It GETs the whole realm representation and changes only those fields. The one attribute is set inside the existing attributes map; a partial map is never sent. It PUTs the whole object back, reads it again, and fails (`still_drifting`) unless the realm now matches.
- **Live proof:** on a realm imported from the old file, every unmanaged setting stays byte-identical, along with the clients, scopes, flows and roles. That covers brute-force detection, `sslRequired`, the OTP and WebAuthn policies and `acr.loa.map`.
- **Finding (Keycloak 26.7.5):** any whole-realm PUT, the admin console's Save included, also stores a few top-level settings as attributes with the same value (`clientOfflineSessionIdleTimeout`, `clientOfflineSessionMaxLifespan`, `scimApiEnabled`). No setting changes. The live test allows exactly that: every existing attribute keeps its value, and an added attribute must equal the top-level setting it mirrors.
- **`--check`** changes nothing and exits 1 on drift. This is the drift check.
- **Local only:** it refuses a non-local Keycloak unless `--allow-remote` is passed.
- **Output:** it prints field names only, never values.

Where it runs:
- **Dev:** `pnpm dev:up` runs it after the stack is healthy, signing in as the bootstrap admin from `.env`; the runbook also gives the manual command.
- **Cells (P13-01, Also line):** the deploy runs `--check`, then applies, with an admin client credential from the secret store, and never re-imports.

A file change outside the managed list still needs a fresh realm locally (`pnpm dev:reset`) or the P13-01 step.

### Existing users

- **Weak passwords:** a policy applies at a user's next password set or change. Nobody is force-reset, and no `UPDATE_PASSWORD` is added. A user with a weak password today keeps it until they change it (accepted residual).
- **Seeded users:** they have no Keycloak account (ADR 0076), so nothing changes. The `bricx-worker` service account has no password.
- **Newly covered administrators:** they set up OTP at their next sign-in after the mapping (ADR 0060 §6).

### Lost second factor (C4)

Removing or resetting a user's OTP needs Keycloak's realm `manage-users`. No organisation role holds it: owners and administrators administer BRICX, not Keycloak. So:
- nobody in an organisation can reset their own second factor or anyone else's;
- there is no self-approval and no owner override (ADR 0067);
- that includes a single-owner organisation.

The answer is a **platform operator procedure**:
1. An operator with realm `manage-users` in the cell verifies the person's identity out of band.
2. A second operator approves; the requester is never the approver.
3. The operator removes the OTP credential, so the user sets up a new one at the next sign-in.
4. The operator records the action, which is itself an admin event.

The runbook states it, and P14-06 (Also line) writes the full procedure.

## Residuals (accepted)

- The denylist is weak against 12+ character passwords (above); P14-01 revisits.
- Length 12 is below NIST's 15 for single-factor passwords; P14-01 revisits.
- Weak passwords set before the policy survive until the next change.
- Admin events stay in the cell's Keycloak database until P13-05 ships them.
- The migrate-to-mapping window fails closed (401 step-up) for newly covered administrators.
- With `passwordHistory(5)`, a password change also stores a `password-history` credential. It holds hashes only and is never a second factor.

## Consequences

- An owner or administrator needs `acr` `mfa` for every admin action, and the P7 client must handle the step-up on admin screens as it does on finance screens (P7-05 Also line).
- P6-06's new member and invitation keys must join `MFA_ADMIN_PERMISSIONS` or be exempted with a reason, or the permissions test fails (P6-06 Also line). Migration 0012 is taken, so P6-06 uses 0013.
- Test fixtures that sign in at `acr` `pwd` and call admin routes now sign in at `mfa`, the identity a real owner has. Each suite keeps or gains a pwd → 401 case (ruling Q1).

## Alternatives considered

- **A `passwordBlacklist` file in the data volume:** the volume is the P5-02b defect, and an existing volume never sees new image files.
- **Re-import with `OVERWRITE_EXISTING`:** it replaces the whole realm, users and sessions included, so it is never used on a live realm (ADR 0060).
- **A partial import:** `partialImport` carries users, clients, roles, groups and identity providers, but not realm settings.
- **MFA by role name (owner, "admin"):** custom roles can be renamed, and a key-based rule cannot be evaded that way.
- **Representation details on:** not needed; off by default means no credential can reach an event.
- **Lifting FORCE RLS on the outbox for the backfill (the 0011 precedent):** a narrow, topic-limited policy that lives only inside the transaction is the smaller change.
