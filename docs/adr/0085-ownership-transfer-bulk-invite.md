# 0085. Ownership transfer and bulk invitations

- Status: Accepted
- Date: 2026-11-12
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP P6-06c (split from P6-06b by the owner's answer Q1, 2026-11-11); owner conditions C4 (ownership transfer) and C5 (bulk invitations); task plan parts 1 and 2 (v2) approved 2026-11-12 13:49Z with answers Q1–Q6 and conditions 1–5; the Q6 test list and Q7 approved 2026-11-12 14:30Z. Amends ADR 0066 (memberships), 0077 (invitations), 0081 (`app.mfa_state()`) and 0084 (member lifecycle); ADR 0055 (audit), 0056 (outbox), 0057 (errors and idempotency), 0068 (grants source)

## Context

An organisation has one or more owners: members whose org role is the system role with `system_key = 'owner'`. The owner's scope for P6-06c asks for a way to hand ownership to another member (C4) and to invite many people at once (C5). `docs/product/` has no requirement beyond "the owner retains ultimate control", "immediate access revocation" and a who/what/when/where audit, so the rules below come from the ROADMAP line, C4, C5 and the plan.

Finding (plan K2): before this change there was no owner-change rule at all. An owner could make any internal, permanent member an owner with `PATCH /v1/members/:id` (`holdsAll` passes for an owner), demote a co-owner the same way, and invite someone with the owner role. None of these paths needed fresh authentication, the recipient's consent or a typed confirmation, so a transfer flow alone would have been bypassable. Migration 0014's guard (P606B) only refused an owner who was temporary or external.

## Decision

### D1. Owner means `system_key = 'owner'`

Only a member whose active org membership has the system owner role may start a transfer. Holding every catalogue key is not enough: a custom role with every key gets 403 and one deduplicated `org.invitation.denied` event, reason `ownership_not_owner`. There is no permission key for a transfer, so no custom role can hold one, and `SOD_RULES` is unchanged (Q1).

### D2. Owner changes happen only through a transfer (Q6, Q7)

- **API.** `PATCH /v1/members/:id` to or from the owner role is 409 `ownership.transfer_required` with one `ownership_transfer_required` denial event, before the org lock, in both directions (Q6). An invitation, or a bulk row, naming the owner role (org or project) is refused (`owner_role`). A co-owner leaves by removal; removing, suspending or reactivating an owner does not change `role_id` and keeps the last-active-owner rule of ADR 0084.
- **Database.** `memberships_guard` v2 (0015) keeps every 0014 rule and adds, for every role, the superuser included, with no setting, flag or GUC that opens it:
  - (a) a change of `role_id` to or from the owner role passes only if this same transaction accepted a transfer of the org (`accepted_xact = pg_current_xact_id()`) and the change is exactly that transfer's: the recipient becomes owner, or the initiator gets `previous_owner_role_id`. A role the invoker cannot see counts as the owner role (fail-closed);
  - (b) `accepted_xact` has no column grant, and `ownership_transfers_guard` refuses any value but the one it writes;
  - (c) that guard writes it only on the move pending → accepted, by the recipient (`app.current_user_id()` and `settled_by`), before `expires_at` (transaction timestamp);
  - (d) a new open owner membership (INSERT, or reopening a removed row) while the org has another open owner is refused for every role except the superuser and `bricx_owner` (Q7, fail-closed). Organisation creation, the bootstrap CLI and the seed (which create the first owner of an empty org, or re-insert an existing row) still pass; the row itself is excluded so the seed's second run passes.
- The API checks first, so a request never meets the trigger; the trigger's SQLSTATE P606C maps to 409, never 500. The test for S26 removes the API pre-check and shows the answer is still 409 with no database error and one denial event (owner condition 1).

### D3. The transfer

- **Table `ownership_transfers`** (0015): `initiated_by`, `to_user_id`, `previous_owner_role_id` (FK `(org_id, id)` to roles), `status` (pending, accepted, declined, cancelled, expired), `expires_at` (24 h after the Clock at start), `settled_by`, `settled_at`, `cancel_reason` (manual, initiator_changed, recipient_changed, org_archived), `accepted_xact`. CHECKs: `to_user_id <> initiated_by`; accepted and declined imply `settled_by = to_user_id` (Q1: requester ≠ approver on the table itself); the settled columns go with the status; `accepted_xact` only when accepted. One pending transfer per org (unique partial index `ownership_transfers_pending`; 23505 → 409 `ownership.transfer_pending`, never 500). The guard (P606C) keeps the terms immutable and a settled row final. FORCE RLS; `bricx_app` has SELECT, INSERT and UPDATE of the settle columns only; no DELETE.
- **Start** `POST /v1/organizations/current/ownership-transfers {toUserId, previousOwnerRoleId, organisationName}`, under `lockOrg`: the caller is an active owner (D1); the typed name equals the org's legal name after NFKC and trim (422 `organisationName`); the recipient is not the caller (422), is a member (404) and is active, internal and permanent (409); the previous role exists (404) and is not the owner role (422); a due pending transfer is expired first (D5), any other pending one is 409. Then the row, `users.mfa_check` for the recipient, an `ownership.expire` outbox row with `not_before = expires_at`, and `org.ownership_transfer.start`.
- **Accept** `POST …/:id/accept {organisationName}`, the recipient only, one transaction under `lockOrg`, row `FOR UPDATE`: the initiator is 403 with one `ownership_self_accept` denial (the table CHECK and the guard refuse it too); anyone else 404; not pending or due 409; the name is checked; both parties are re-checked (initiator still an active owner, recipient still active, internal, permanent; else 409). The row settles accepted, then the repository's one dedicated method `transferOwnership` changes the recipient's role to owner and the initiator's to `previousOwnerRoleId` (each exactly one row), and the last-active-owner count is checked after both as a backstop. This is the one sanctioned exception to the self-change guard of ADR 0077 D13: the recipient's acceptance changes their own role. `users.mfa_check` goes out for both; audit `org.member.update` per party (with `transferId`) and `org.ownership_transfer.accept`.
- **Decline** `POST …/:id/decline` by the recipient only (else 404); not pending or due 409. **Cancel** `POST …/:id/cancel` by any active owner, initiator included, at `acr = mfa` (not fresh): pending and not due first (409), then the owner check (403), then `permission.step_up_required`. Each writes `users.mfa_check` and its audit event (`.decline`, `.cancel` with the cause).
- **Read** `GET …/pending`: the recipient or an active owner sees the pending transfer; anyone else, or a due transfer, 404.
- All transfer routes are rate-limit class `auth_adjacent`; the POST routes are `@Idempotent()`.

### D4. Fresh authentication (Q3, Q4)

- `@FreshAuth()` on start and accept: `acr = mfa` and `auth_time` at most `FRESH_AUTH_MAX_AGE_SECONDS` (300, a constant) old on the injected Clock, and not more than the verifier's 5 s skew in the future. `iat` is never used. Otherwise 401 `auth.reauth_required` with `WWW-Authenticate: Bearer error="insufficient_user_authentication", acr_values="mfa", max_age=300` (RFC 9470).
- Q3: a malformed `auth_time` (not a JSON integer, or negative) is refused by the token verifier on every route, 401 with reason `auth_time_invalid`; missing, stale or future beyond the skew is refused only on `@FreshAuth()` routes (WSL clock drift elsewhere).
- Q4: the client re-authenticates with `prompt=login&acr_values=mfa&max_age=300`. Proven live (`tooling/keycloak-realm/test/realm-login.int.test.ts`): that login advances `auth_time`, the OTP-only step-up in a live SSO session also advances it, and a refresh keeps it, so a refresh never makes a token fresh. No realm change.

### D5. Cascades and expiry

- **Cascades** (same transaction): removing, suspending or changing the role of either party cancels the pending transfer (`initiator_changed` / `recipient_changed`); archiving the org cancels it (`org_archived`, through the organisations module's `OWNERSHIP_CANCELLER`). Each records `.cancel` with its cause and enqueues `users.mfa_check`.
- **Expiry at the Clock.** A transfer is due when the Clock is at or after `expires_at`; one millisecond before, it can still be accepted. An accept, decline or cancel of a due transfer answers 409 and **writes nothing**: these routes are `@Idempotent`, and an idempotent run stores its answer only when the transaction commits, so a route cannot record the expiry and answer an error in one run. The expiry is recorded by, in order of time: the `ownership.expire` job (`not_before = expires_at`; refused and retried while early, `OwnershipNotDueError`), the worker's 5-minute sweep (`app.ownership_transfers_due(limit)`, at most 100, logged on its own `ownership.sweep` line), or the next start in that org (lazy). Each sets `expired`, audits `org.ownership_transfer.expire` as actor `system` and enqueues `users.mfa_check` for the recipient; replayed, a no-op.
- The worker's transaction runs as `bricx_app` with the org and the recipient's user id, which is why the `ownership.expire` payload carries `{transferId, toUserId, expiresAt}` (at most 192 bytes; ids and an instant only).

### D6. MFA state v4 (amends ADR 0081)

`app.mfa_state()` v4 is v3 or `app.mfa_transfer_pending(user)`: true while the user is the recipient of a pending, unexpired transfer (database clock), so the recipient can reach `acr = mfa` before accepting. The initiator is an owner and already requires MFA. Same signature, owner, volatility, `search_path` and grants (CREATE OR REPLACE).

### D7. Access at accept; sessions kept (Q2)

Access is rebuilt from the database on every request (ADR 0068); the token carries `acr` and `auth_time`, never roles. So the first request after the accept commits, on the same unexpired token, sees the new roles: the outgoing owner's next start is 403 `ownership_not_owner`. The outgoing owner's sessions are kept (Q2).

### D8. Bulk invitations (C5, Q5)

- `POST /v1/invitation-batches {rows}`: key `org.member.invite`, `@Idempotent` (key required), rate-limit class `invitation`, 1 to 200 rows (`MAX_BATCH_ROWS`), JSON only (CSV is a client concern). 202 `{batchId, accepted, failed}`.
- Under the org's batch lock (advisory, transaction-scoped): a stale open batch is purged (D9); one queued or running batch per org (409 `invitation.bulk_running`, backed by the unique partial index `invitation_batches_running`); at most `MAX_ROWS_PER_DAY` = 1,000 rows per org per 24 h of the Clock, the sum of every batch's `row_count`, refused rows included (429 `invitation.bulk_quota`).
- Each row is parsed with the single invite's schema (`validation_failed`), then a row naming the owner role is refused (`owner_role`), then the single invite's own checks run (`InvitationsService.checkRow`: the role, the project, `holdsAll`, the temporary-membership bounds). The bulk path checks `owner_role` first, so a forbidden owner row never reaches `holdsAll`; the single invite keeps its existing order (escalation before owner role). A refused row is stored `failed` with only its code: no address and no role (`role_id` is nullable, and the CHECK `invitation_batch_rows_role` requires it on pending rows). A row refused for escalation records one deduplicated escalation denial for the batch, after commit.
- Same transaction: the batch, its rows, one `invitations.bulk` outbox row `{batchId, createdBy}` (at most 128 bytes; the worker runs as `createdBy`) and one `org.invitation_batch.create` event with counts only.
- **The worker** (queue `invitations`): re-checks only that the org is not archived and the inviter is still an active member (else every pending row fails `org_archived` / `inviter_inactive`). Each pending row runs in a savepoint through `insertPendingInvitation` in `@bricx/db/invitations`, the single INSERT the single-invite route also calls, then the `invitations.send` outbox row and `org.invitation.create` as the inviter (with `batchId`); a pending invitation for the same address is `pending_exists`. The row settles `created` with `invitation_id`, or `failed` with its code, and its address is cleared in the same UPDATE; a retry skips settled rows. At the end the batch is `done`, audited `org.invitation_batch.complete` (counts) as `system`.
- **No second mint path.** The token is minted only by the existing send step (`mintInvitationToken`, called only from `apps/worker/src/invitations/send.ts`). A registry test (`apps/worker/test/invitation-mint-paths.test.ts`) lists the one statement that stores a token and the one INSERT into `bricx.invitations`.
- **Reads** `GET /v1/invitation-batches/:id` and `GET /:id/rows?cursor&limit≤100` (`org.member.read`): counts, status, and per row `rowNo`, status, code and `invitationId`; never an address or a token.

### D9. Addresses at rest and the purge (C4 wording)

A pending batch row holds the address until the worker turns it into an invitation, the same at-rest copy a single invite makes. A batch still queued or running one hour after creation (`BATCH_PURGE_AFTER_MS`) has every pending row failed `not_processed` with its address cleared, and is done, with one `.complete` event as `system`. Two paths do it: the worker's 5-minute sweep in every org (`app.invitation_batches_stale(limit)`), and lazily in the API on any batch read and any submit in that org. **An address survives the hour only if the worker is down AND no API call touches that org's batches.** The P13 retention purge remains.

### D10. What the invitee sees (plan K5)

If the inviter is demoted (still an active member, but no longer holding every key of the invited role) between the submit and the worker run, the invitation is created and the e-mail is sent; at accept, the existing ADR 0077 D13 check answers the uniform 404 and revokes the invitation `inviter_lacks_rights`. The invitee therefore can receive an invitation that cannot be accepted. A suspended or removed inviter fails the rows `inviter_inactive` before anything is sent.

### D11. Routes, codes and events

- Routes: `POST /v1/organizations/current/ownership-transfers`, `GET …/pending`, `POST …/:id/accept`, `/decline`, `/cancel`; `POST /v1/invitation-batches`, `GET /v1/invitation-batches/:id`, `GET /v1/invitation-batches/:id/rows`.
- Codes: `auth.reauth_required` 401, `ownership.transfer_pending` 409, `ownership.transfer_required` 409, `invitation.bulk_running` 409, `invitation.bulk_quota` 429. Denial reasons: `ownership_not_owner`, `ownership_self_accept`, `ownership_transfer_required`.
- Audit: `org.ownership_transfer.start`, `.accept`, `.decline`, `.cancel` (cause), `.expire` (system); `org.member.update` per party at accept; `org.invitation_batch.create`, `.complete`.
- Outbox: `ownership.expire` `{transferId, toUserId, expiresAt}` and `invitations.bulk` `{batchId, createdBy}`, both 40 attempts, back-off 1 s to 60 s. No address, name or token in any outbox row, audit event or log line (sentinel scans).

### D12. Migration 0015 (forward-only, expand only)

`ownership_transfers`, `invitation_batches`, `invitation_batch_rows` (FORCE RLS, `org_id`, column grants on the mutable columns only, guard triggers P606C / P606D, no DELETE); `memberships_guard` v2; `app.mfa_transfer_pending()`, `app.mfa_state()` v4; `app.ownership_transfers_due()` and `app.invitation_batches_stale()` (SECURITY DEFINER, EXECUTE for `bricx_relay` only, at most 100). Nothing is synced. The seeds still run twice idempotently.

## Disclosures for architect review (owner condition 7, 2026-11-13)

Each is a choice the plan did not spell out, or a departure from it, recorded here and in the PR:

1. **409 at expiry, and who records it.** At or after `expires_at` (the Clock), accept, decline and cancel answer 409 and write nothing, because an `@Idempotent` route stores its answer only when its transaction commits (D5). The expiry is recorded by the `ownership.expire` job at `not_before = expires_at`, else by the worker's 5-minute sweep, else lazily by the next start in that org. The plan said "lazy at the Clock" for every path; only the start path records it.
2. **Outbox payloads carry a user id**, because the worker's transaction runs as that user (RLS and `app.current_user_id()`): `ownership.expire` `{transferId, toUserId, expiresAt}` (192 bytes at most) and `invitations.bulk` `{batchId, createdBy}` (128 bytes at most). The plan said "ids only"; these are ids.
3. **`invitation_batch_rows.role_id` is nullable**, with the CHECK `invitation_batch_rows_role` (a pending row names its role), so a row refused at submit keeps no inputs at all, not only no address.
4. **The bulk row checks the owner role before the single invite's other checks**; the single invite keeps its existing order (escalation first). Both get the code from the one function `ownerRoleRefusal()` (owner condition 3; registry test `apps/api/test/owner-role-check.test.ts`). The single invite answers that code as 422 at `roleId`, a bulk row stores it as `owner_role`.
5. **The idempotency store of a bulk submit holds exactly `{batchId, accepted, failed}`** (owner condition 4; test in `apps/api/test/modules/invitation-batches.int.test.ts`). The first build returned a wider object from the transaction and the route failed with 500; the escalation flag now travels outside the stored answer.
6. **The sweep logs transfers on their own `ownership.sweep` line**, so the existing `membership.sweep` line (pinned by P6-06b's tests) is unchanged; a failed transfer still fails the sweep job.
7. **`memberships_guard` v2 is fail-closed**: a role the invoker cannot see counts as the owner role, in clause (a) and clause (d) (Q7).
8. **`OWNERSHIP_CANCELLER` is injected `@Optional()`** in the organisations module, so the archive path cancels a pending transfer without the organisations module importing the transfers module.
9. **Two OPEN membership readers** were added (`findOrgOfUser`, `transferOwnership`); each is justified in the readers registry with the test that proves the lifecycle is judged (owner condition 1).
10. **Existing test files changed**: exactly eight in the tests commit (registry appends in `rls.test.ts`, `outbox.test.ts`, `codes.test.ts`, `invitations.test.ts`; `membership-readers.test.ts`; the Q6 behaviour in `memberships.test.ts`, `memberships.int.test.ts`, `migration-0014.int.test.ts`), plus `tooling/keycloak-realm/test/realm-login.int.test.ts` from plan step F1, accepted by the owner (Avinz) on a decision card, 2026-11-13 15:03Z. The full integration run then needed `packages/db/test/rls.int.test.ts` and `grants.int.test.ts` (registry appends and fixture rows for the new tables; the read-only UPDATE probe by the org column; a cross-org membership INSERT by `bricx_app` is refused by the guard, P606C, before RLS's 42501) and one more test in `memberships.int.test.ts` (the Q6 denial in the leaving test), approved by the owner (Avinz) on a second decision card, 2026-11-13 15:31Z, and committed separately. `memberships.test.ts` was missing from the first Q6 list and was disclosed before the commit. The mint-path registry's regex was corrected before the commit (a backtracking `\s*` let `token_hash = NULL` count as a mint), which makes it stricter.
11. **A removal is never a 500 under clock skew (owner review of PR #95, item B).** CI on `a896d5d` answered 500 at the cascade test's "recipient removed" step. Root cause: SQLSTATE 23514, CHECK `memberships_removed` (`removed_at >= created_at`), in `MembershipsRepository.removeOrg` (P5-05): the suite's Clock was frozen at its start while the fixtures were written at the database clock (`now() - 1 minute`), so on a slow runner `removed_at` fell before `created_at`. Not the cascade and not a lock: the same CHECK fails for any removal whose row is newer than the remover's Clock. Fixed in this PR at the source: the five removal writes (org membership, project memberships, their sites) set `removed_at = GREATEST(created_at, now)`, with a test that removes a row newer than the Clock (red before the fix: 500). The suite's Clock also catches up with the wall clock per org. `removed_at` can therefore equal `created_at`, or be later than the request's Clock, when the clocks disagree.
12. **Unit suites for the two new services** (`apps/api/test/modules/ownership-transfers.test.ts`, `invitation-batches.test.ts`) were added after the implementation, because the `new-module` CI check measured apps/api unit lines at 69.74% (under 70%) once its scaffolded module was added. The integration suites remain the Done-when proofs.

## Done-when and their red-first tests

| # | Item | Test |
|---|---|---|
| 1 | `auth_time` advances on re-auth; a refresh keeps it | `tooling/keycloak-realm/test/realm-login.int.test.ts` |
| 2 | `auth_time` fails closed; 300 s passes, 301 s does not | `apps/api/test/fresh-auth.test.ts`, `ownership-transfers.int.test.ts` |
| 3 | Owner by `system_key` only | `apps/api/test/modules/ownership-transfers.int.test.ts` |
| 4–7 | Start rules, one pending transfer, accept under the lock, SoD | same; `packages/db/test/migration-0015.int.test.ts` |
| 8 | Expiry boundary; job and sweep record it once as `system` | same; `apps/worker/test/ownership.int.test.ts` |
| 9–11 | Cascades, MFA state v4, audit at every step | API and worker suites; `migration-0015.int.test.ts` |
| 12 | Access at accept on the same token | `ownership-transfers.int.test.ts` |
| 13 | Owner guard: every other path refused | `migration-0015.int.test.ts`, `memberships.int.test.ts`, `migration-0014.int.test.ts` |
| 14 | Bulk submit: checks, caps, quota, idempotency | `apps/api/test/modules/invitation-batches.int.test.ts` |
| 15 | Bulk worker: same insert, no second mint, per-row results, retry | `apps/worker/test/invitation-batches.int.test.ts`, `invitation-mint-paths.test.ts` |
| 16 | The purge, by the sweep and lazily in the API | both batch suites |
| 17 | Inviter changed before the worker runs | `apps/worker/test/invitation-batches.int.test.ts` |
| 18 | Migration 0015 | `migration-0015.int.test.ts`, `rls.test.ts`, `grants.int.test.ts` |
| 19 | i18n | `pnpm i18n:check` |

Sabotages S1–S30 (plan H) are each caught by a named test; the PR lists the runs and their controls.

## Threats

| Threat | Control |
|---|---|
| Ownership taken outside a transfer | API refusal (Q6) and `memberships_guard` v2 for every role; `accepted_xact` written only by the guard |
| A stolen or idle session hands ownership away | `@FreshAuth()` (acr mfa, `auth_time` ≤ 300 s) on start and accept; typed organisation name |
| The initiator accepts their own transfer | API 403, table CHECK and guard |
| Two transfers or racing accepts | Unique pending index; `lockOrg` then `FOR UPDATE`; last-active-owner backstop |
| A transfer outlives a party's change | Cascade cancels in the same transaction |
| A bulk invite as a second mint or escalation path | One INSERT, one mint (registry test); the single invite's checks per row; owner role refused |
| Bulk abuse | 200 rows per batch, 1,000 per org per day with refused rows counted, one running batch, rate-limit class `invitation` |
| Addresses kept at rest | Refused rows never store one; settled rows clear it; the 1 h purge in the sweep and the API |

## Residuals (accepted)

- **The single invite's idempotency store keeps the invitee's address for 24 h.** `POST /v1/invitations` is `@Idempotent`, and its stored response includes `email` in `idempotency_keys` for the key's 24 h. Not fixed here; reported as a separate chore (owner condition 3). The bulk answers carry no address.
- An address in a stuck batch survives the hour only if the worker is down and no API call touches that org's batches (D9); the P13 purge remains.
- A due transfer's expiry is not recorded by the request that finds it due (D5); the job, the sweep or the next start records it. Until then the row reads `pending` in the database, while every API path treats it as gone.
- The worker's insert does not first expire a stale pending invitation for the same address, so such a row reports `pending_exists` (for architect review).
- The demoted inviter's invitee receives an e-mail for an invitation that cannot be accepted (D10).
- The outgoing owner's sessions are kept (Q2).
- **SECURITY DEFINER functions owned by `bricx_owner` are outside clause (d).** The guard's second-owner rule exempts the superuser and `bricx_owner` (Q7: migrations, the bootstrap of an empty organisation, the seed), and a `SECURITY DEFINER` function owned by `bricx_owner` runs as `bricx_owner`, so it would pass clause (d). Clause (a) (owner role changes only in the accepting transaction) still binds it. As of migration 0015 no such function writes `bricx.memberships`: the definer functions are `app.provision_user` (writes `bricx.users` only), `app.mfa_state` (which reads `app.mfa_transfer_pending`, itself an invoker function), `app.access_grants_due`, `app.invitation_by_token_hash`, `app.invitations_due`, `app.memberships_due`, `app.memberships_expiring`, `app.ownership_transfers_due` and `app.invitation_batches_stale`, all reads. A test pins it (`packages/db/test/migration-0015.int.test.ts`, "no SECURITY DEFINER function writes bricx.memberships"); a later function that writes memberships must re-open this residual (owner review of PR #95, item 3a).
- **Which clock decides at the expiry boundary.** `expires_at` is written from the API's injected Clock at start (Clock + 24 h). At accept, decline and cancel the API checks first with the injected Clock (`expires_at <= Clock` is 409, nothing written; S14). The database then checks again with its own clock: `ownership_transfers_guard` refuses the pending -> accepted change when `expires_at <= transaction_timestamp()` (P606C, answered 409 `request.conflict`, the transaction rolled back). An accept therefore passes only when both clocks say the transfer is live; when they disagree, the earlier expiry wins. The relay's `app.ownership_transfers_due()` and `app.mfa_transfer_pending()` use the database clock (`now()`), so the job, the sweep and the MFA requirement follow the database clock (owner review of PR #95, item 3b).
- No delivery of the transfer to a person until P12.

## Consequences

- `@bricx/db`: migration 0015, `@bricx/db/ownership`, `@bricx/db/invitation-batches`, `insertPendingInvitation` in `@bricx/db/invitations`, the two outbox topics.
- `apps/api`: `@FreshAuth()` and `auth_time` in the token verifier; modules `ownership-transfers` and `invitation-batches`; memberships (Q6 refusal, cascades, `transferOwnership`, `findOrgOfUser`); invitations (`checkRow` extracted, owner role refused, the shared insert); organisations (archive cancels a transfer); OpenAPI and `@bricx/api-client` regenerated; i18n keys.
- `apps/worker`: `ownership.expire` and `invitations.bulk` consumers, both sweeps.
- The membership readers registry (ADR 0084) gains two OPEN readers.

## Alternatives considered

- **A permission key with a SoD pair for the transfer** (Q1): rejected; a custom all-keys role would hold it.
- **Ending the outgoing owner's sessions** (Q2): rejected; access already changes on the next request.
- **Locking promotion only** (Q6): rejected; an owner could still demote a co-owner without a transfer.
- **A session setting that opens the owner guard**: rejected; any route could set it. The transaction-id match cannot be forged.
- **Recording the expiry from the refusing request**: impossible on an idempotent single-run route without answering success; the job, sweep and lazy start cover it.
- **CSV upload on the server**: rejected; a parser dependency, and the client can convert.
