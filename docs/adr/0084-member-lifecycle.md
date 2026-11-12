# 0084. Member lifecycle: suspension, temporary and external memberships, activity history

- Status: Accepted
- Date: 2026-11-12
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP P6-06b (owner's scope 2026-11-11; split into P6-06b, P6-06c and P6-06d by answer Q1); task plan part 1 answered 2026-11-11 12:12Z (Q1–Q8, owner conditions C1–C9), part 2 approved 2026-11-11 12:24Z with additions A1–A6; amends ADR 0066 (memberships), 0067 (SoD), 0075 (projects and sites, `sites_assigned_select`) and 0077 (invitations); ADR 0055 (audit), 0056 (outbox), 0068 (grants source), 0081 (`app.mfa_state()`)

## Context

Until now a membership was either open (`removed_at IS NULL`) or removed. The owner's scope for P6-06b asks for suspension and reactivation, temporary memberships (expiry, a notice before it, renewal), an external flag, and a member's activity history. Ownership transfer and bulk invitation are P6-06c (ADR 0085, reserved); DNS TXT domain verification is P6-06d (ADR 0086, reserved).

Audit (owner condition C1), every reader of "an open membership" in application code before this change:

| Reader | Before | After |
|---|---|---|
| `grants-source.ts` `accessRowsFor` (org row, project rows) | open | **active**, at the request's Clock. It feeds every request, the SoD approver search (ADR 0067) and the invitation inviter check (ADR 0077) |
| `sod.service.ts` approver candidates | open | **active** (through `accessRowsFor`) |
| RLS policy `sites_assigned_select` (0011) | the user's site assignments only | **replaced**: also an active org membership and an active project membership. Finding: the old policy did not look at the project membership at all, so RLS alone would still have shown assigned sites after a project-level suspension (the API layer blocked it) |
| Access-grant creation (`assertMember`) | open | **active**; an external member gets no org-scope elevation |
| Last-owner rule | open owners | **active** owners (`countActiveOwners`) |
| Member lists, find-for-update, `GET /v1/me/memberships`, the role-in-use count, the unique indexes `memberships_open` / `project_memberships_open` | open | **open, by design**: a suspended or expired member is listed with a `status` and can be reactivated or renewed; the row still blocks a duplicate |
| `app.mfa_state()`, `app.mfa_finance_held()`, `app.mfa_admin_held()` (0012) | open | **unchanged, by design** (see D9) |

`apps/api/test/membership-readers.test.ts` holds this list as a registry (file, active count, open count, why) and fails when a reader is added or changes class.

## Decision

### D1. One definition of "active"

A membership (org or project) is **active** when `removed_at IS NULL AND suspended_at IS NULL AND (expires_at IS NULL OR at < expires_at)`. In the API, `at` is the request's injected Clock (bound, never `now()`); in SQL views and policies it is the database clock. A project membership counts only while the org membership is active. The end is exact: one millisecond before `expires_at` the keys count, at `expires_at` they are gone, whatever the worker has done.

### D2. Suspension (items 1, Q5, C2)

- `POST /v1/members/:id/suspend {reason}` and `/reactivate`, key `org.member.update` (no new key). `POST /v1/projects/:projectId/members/:id/suspend` and `/reactivate`, key `project.member.assign` on that project.
- Never oneself (403 plus one deduplicated `org.invitation.denied` event, reason `self_suspend`; `self_renew` for renewal); only by someone holding every key of the target (`holdsAll`, 403); never the last **active** owner (409); an already suspended row 409; an unknown, removed or other-org id 404. The org lock (`lockOrg`) is taken on every suspend, reactivate and renew, so a suspension and a reactivation racing on one row serialise: every answer is 200 or 409 and the audit trail agrees with the row.
- An **org** suspension, in the same transaction: the member's sessions in the org close (`revokeOfUserInTx`, cause admin, as removal does), their open access grants end, the invitations they sent are revoked with `inviter_suspended`, `users.mfa_check` is enqueued, and `org.member.suspend` is audited with the reason. The membership row and its project rows stay. The next request is 403 `membership_missing`.
- A **project** suspension mirrors a project removal (owner answer Q5, C2): that project's keys and id go on the next request, the other projects, the org membership and the sessions stay, and the access grants on that project end.
- Reactivation restores the role and the project rows from the next request; **no session comes back** (the member signs in again). The sessions table's `forbid_unrevoke` trigger (0005) makes that a database rule too: an attempt to clear `revoked_at` fails (sabotage S4).
- The reason is 1 to 200 characters (C8), stored in `suspend_reason`, audited, returned only to holders of `org.member.read` (A3: a project manager's member list carries `suspendReason: null`), never in `GET /v1/me/memberships`, never in a log line (sentinel scans in the suites).

### D3. SoD (amends ADR 0067)

A suspended or expired member is not an approver: the approver search reads active rows only. If the only possible approver is suspended, the action stays pending with `sod_no_approver` (the D2 rule of ADR 0067) until a second active approver exists or the member is reactivated (`p5-07-done-when.int.test.ts` DW7, org and project level).

### D4. Temporary memberships (items 4, Q3, Q4, C8)

- `expires_at` on both tables. Set by a project assignment (`expiresAt`), by an invitation's `membershipExpiresAt` at accept, or by renewal. The end is 1 hour to 366 days after the Clock (422 at the field otherwise).
- The API decides access at the Clock (D1). The worker records the end: the transaction that sets `expires_at` writes a `memberships.expire` outbox row with `not_before = expires_at` when the end is within BullMQ's longest delay (`MAX_DELAY_MS`, 2,147,483,647 ms, about 24.8 days); the worker's 5-minute sweep (`app.memberships_due()`, at most 100 rows of each kind per run) records every other one. Recording sets `expired_at` and audits `org.member.expire` / `project.member.expire` as actor `system`, correlation = the outbox id or `sweep.<id>`, in one transaction; replayed, a no-op. An early job is refused and retried (`MembershipNotDueError`), never completed as a no-op. A renewed membership's old job completes as `renewed` and records nothing.
- The worker's transaction runs as `bricx_app` with the membership's org and user and `allProjects`, so a project row is written under the project policies. An archived organisation or project still gets its expiry recorded.
- Sessions are kept at expiry (Q4): access is already gone on the next request.
- Renewal: `POST /v1/members/:id/renew {expiresAt, reason}` (`org.member.update`) and the project route (`project.member.assign`): a reason (1 to 500 characters, audited, not stored on the row), never oneself, `holdsAll`, a temporary row only (a permanent one is 409), also on an already expired row (clears `expired_at`). An archived project's membership is 409.
- The notice `memberships.expiring` (ids only) is written once per end: at once when a membership is created or renewed with under 7 days left (C8), otherwise by the sweep 7 days before (`app.memberships_expiring()`); `expiry_notified_at` marks the row. Delivery to a person is P12.
- `GET /v1/members?expiringWithinDays=N` (1..90, `org.member.read`) lists the temporary members ending within N days, soonest first.
- The owner role is never temporary (A2): the `memberships_guard` trigger refuses it on INSERT and on any UPDATE (including of `role_id`), for every role; the API answers 409 first.

### D5. External members (items 4, C3)

- `memberships.is_external`, set only when a NEW org membership is created by an external invitation (`external: true`, which needs a project, 422 otherwise, and never with the owner role, 409). An existing internal member who accepts an external invitation joins the project and stays internal. The flag never changes on a row (trigger P606B); it is shown in the API and in audit events.
- What an external member keeps (`buildAccess`): of the org role's bundle, the org-scope keys in `EXTERNAL_ORG_KEYS` only (today `org.region_config.read`, for architect review) and no own-scope key; no org-scope elevation (409 at creation, dropped in the grants source); never all projects. Their project keys come from their project memberships as for anyone.
- Every catalogue resource with an org-scope key is either in `EXTERNAL_ORG_KEYS` or in `EXTERNAL_ORG_DENIED` with a reason (completeness test). Proofs: for every system role, the external grants are a subset of the internal grants with the same rows; no `finance.*` key at org scope by role or elevation (`packages/permissions/test/external.test.ts`, `apps/api/test/grants-source.test.ts`, `external.int.test.ts`).
- An external project membership never holds the owner role (`project_memberships_guard`).

### D6. Invitations (amends ADR 0077, A1)

`external` and `membershipExpiresAt` on `POST /v1/invitations`. `membershipExpiresAt` is an **absolute instant**, 1 hour to 366 days after the invitation's creation; both are immutable (`invitations_guard` v2, P6006). Accept refuses with the uniform 404 (`invitation.unavailable`) once `membershipExpiresAt` has passed, and writes nothing. The memberships accept creates carry the end, with the expire job and the notice in the same transaction. A suspended user can accept an invitation to another organisation; an invitation to a project of the organisation where they are suspended adds the project row but does not lift the suspension.

### D7. Activity history (item 5, Q7, A4)

`GET /v1/members/:id/activity?limit&cursor` (`org.audit.read`), paginated by `seq` (default 50, at most 100). Matching (A4): inside `org_id = <the request's org>` (also enforced by RLS), the events whose `actor_id` is the member's user id, plus the events on the member's org membership ids (`entity_type = org.member`) and project membership ids (`project.member`); each event once, newest first; `byMember` tells the two apart. A user who is a member of two organisations never crosses: every branch carries the org filter. A fixed projection: `seq`, `occurredAt`, `action`, `entityType`, `entityId`, `actorType`, `byMember`, `correlationId`; never `before`/`after`, the reason, an address, the actor id, a device or a location (Q7). A removed membership's history is still read; the member reading their own history needs the key like anyone else.

### D8. Stream sources (C1, rule 3)

No sync stream exists before P8-02 (`sync-streams.yaml` holds placeholders). Migration 0014 creates the sources the placeholders name, as `security_invoker` views on the active definition: `app.user_project_access` (org, user, project) and `app.user_grants_source` (org, user, permission, scope, target; the system owner role is one `'*'` row at org scope; an external member's rows follow D5). A database leak test (`apps/api/test/stream-sources.int.test.ts`) proves that a removed, suspended or expired member, a project-suspended member and an external member's other projects are absent from both, in two organisations, and that the views agree with the request path. The PowerSync leak test for suspended and expired members is a P8-02 Done-when (Also line).

### D9. MFA state unchanged

`app.mfa_state()` keeps counting open (not removed) memberships: a suspended or expired member holding a finance or admin key keeps "MFA required". That is the stricter side and needs no remap at reactivation or renewal (`migration-0014.int.test.ts`). Suspend, reactivate and renew still enqueue `users.mfa_check`.

### D10. Audit indexes (C7)

Two indexes for the activity read: `audit_events_by_actor (org_id, actor_id, seq DESC)` and `audit_events_by_entity (org_id, entity_type, entity_id, seq DESC)`. Estimate: about 56 and 80 bytes per event, about 14 GB together per 100 million events in a cell; two more index writes on every audited transaction. They are built by a plain `CREATE INDEX` in the migration transaction, which blocks audit inserts (every write) for the build; acceptable only because the table is near empty before launch. Rule: any later index on `audit_events` is built `CONCURRENTLY` outside a transaction, which needs a migrator change (P13-01 Also line). Both lead with `org_id` and end with `seq`, so they become local indexes unchanged if the table is range-partitioned (the ADR 0078 follow-up decides that). `org.audit.read` is not admin-class (`isAdminClass` is false for reads), so the MFA admin key set is unchanged.

### D11. Migration 0014 (forward-only, expand only)

Columns `suspended_at`, `suspended_by`, `suspend_reason`, `expires_at`, `expired_at`, `expiry_notified_at` on both tables and `is_external` on `memberships` (NULL or default for every existing row); CHECKs (suspension columns together, reason 1..200, `expires_at > created_at`, `expired_at >= expires_at`); `bricx_app` column grants for the mutable columns only (no `user_id`, `is_external`, `created_at`); triggers `memberships_guard` and `project_memberships_guard` (P606B, every role); `invitations.is_external`, `membership_expires_at`, CHECKs, `revoke_reason` widened with `inviter_suspended`, guard v2; `sites_assigned_select` replaced; partial indexes `memberships_due`, `project_memberships_due`, `memberships_suspended_open`, `project_memberships_user_open`; views `app.active_memberships`, `app.active_project_memberships`, `app.user_project_access`, `app.user_grants_source`, function `app.external_org_keys()`; `app.memberships_due(limit)` and `app.memberships_expiring(days, limit)` (SECURITY DEFINER, EXECUTE for `bricx_relay` only); the two audit indexes. Seeds are unchanged; `pnpm db:seed` twice stays idempotent.

### D12. Routes and events

| Route | Key | Audit |
|---|---|---|
| `POST /v1/members/:id/suspend`, `/reactivate`, `/renew` | `org.member.update` | `org.member.suspend`, `org.member.reactivate`, `org.member.renew` |
| `POST /v1/projects/:projectId/members/:id/suspend`, `/reactivate`, `/renew` | `project.member.assign` | `project.member.suspend`, `…reactivate`, `…renew` |
| `GET /v1/members?expiringWithinDays=N` | `org.member.read` | none |
| `GET /v1/members/:id/activity` | `org.audit.read` | none |
| worker | (system) | `org.member.expire`, `project.member.expire` |

Outbox topics `memberships.expire` and `memberships.expiring` on queue `memberships` (ids and an instant only).

## Done-when and their red-first tests

| # | Item | Test |
|---|---|---|
| 1 | Org suspend: next request 403, sessions closed in the same transaction, reason ≤ 200, never logged | `apps/api/test/modules/members-lifecycle.int.test.ts` |
| 2 | Reactivate restores the role, not the sessions | same |
| 3 | Suspend revokes sent invitations and ends held grants | same |
| 4 | Only approver suspended or expired: `sod_no_approver` | `apps/api/test/p5-07-done-when.int.test.ts` (DW7) |
| 5 | Last active owner 409; self 403 with one denial event; from below 403 | `members-lifecycle.int.test.ts` |
| 6 | Project suspend; raw RLS `sites_assigned_select` | same; `packages/db/test/migration-0014.int.test.ts` |
| 7 | Readers registry | `apps/api/test/membership-readers.test.ts` |
| 8 | Stream sources | `apps/api/test/stream-sources.int.test.ts`; `packages/permissions/test/generate.test.ts` |
| 9 | Lazy expiry at the Clock, both boundaries | `members-lifecycle.int.test.ts` (org and project) |
| 10 | Expiry job, sweep, audit as system, replay once | `apps/worker/test/memberships.test.ts`, `memberships.int.test.ts` |
| 11 | Renewal | `members-lifecycle.int.test.ts`; `apps/api/test/modules/memberships.test.ts` |
| 12 | Notice at 7 days or at once; expiring list | API and worker suites |
| 13–15 | External subset, no org finance key, allowlist completeness | `packages/permissions/test/external.test.ts`; `apps/api/test/grants-source.test.ts` |
| 16 | External reach, flag in API and audit | `apps/api/test/modules/external.int.test.ts` |
| 17 | Activity | `apps/api/test/modules/member-activity.int.test.ts`, `member-activity.test.ts` |
| 18 | Migration 0014 | `migration-0014.int.test.ts`, `rls.int.test.ts`, `grants.int.test.ts` |
| 19 | i18n and seed | `pnpm i18n:check` (no new user-facing string); seed tests |

Sabotages S1–S27 (plan F and A5) are each caught by a named test; the PR lists the runs.

## Threats

| Threat | Control |
|---|---|
| A suspended or expired member keeps access through a forgotten reader | One active definition; the readers registry; RLS policy and stream-source views on the same predicate; leak tests |
| A suspended member keeps a live session | Sessions closed in the suspending transaction; revocation keys (ADR 0065); no session restored |
| Self-reactivation, self-renewal, suspension from below | Self guard with a denial event; `holdsAll`; last active owner rule |
| A temporary or external owner | Guard triggers for every role, on INSERT and UPDATE of `role_id` |
| External member reaching other projects or finance | `EXTERNAL_ORG_KEYS` allowlist with completeness test; no org-scope elevation; never all projects |
| Personal data in the activity view or logs | Fixed projection; reason never logged (sentinel scans) |
| Cross-tenant activity | Org filter in every branch and RLS |
| Expiry never recorded | Delayed job plus a 5-minute sweep; access ends at the Clock regardless |

## Residuals (accepted)

- No PowerSync leak test until P8-02 (Also line there).
- Sessions are not ended at expiry (Q4); access is recomputed per request.
- The expiry notice is not delivered to a person until P12.
- The worker writes as `bricx_app` (ADR 0067 residual) until P13-01.
- The audit indexes were built without `CONCURRENTLY` (empty table); later ones need the migrator change.

## Consequences

- `@bricx/db`: migration 0014, `@bricx/db/memberships` (expire, notice claim, due reads), the active predicate in `rls.ts`, outbox topics.
- `@bricx/permissions`: `@bricx/permissions/external` (`EXTERNAL_ORG_KEYS`, `EXTERNAL_ORG_DENIED`, `externalKeepsOrgKey`, `externalAllowsElevation`); the generator names the two views as the only stream sources.
- `apps/api`: grants source (active rows, external narrowing), memberships routes and service, invitations (`external`, `membershipExpiresAt`), access grants (active member, no org-scope elevation for externals), the audit module's activity reader, denial reasons `self_suspend` and `self_renew`; OpenAPI and `@bricx/api-client` regenerated.
- `apps/worker`: queue `memberships` (expire, notice, sweep scheduler).
- Semgrep rule `bricx-relay-tx-outside-relay` allows the worker's due reader.

## Alternatives considered

- **A status enum column** instead of lifecycle columns: rejected; suspension and expiry are independent and each needs its own instant and actor.
- **Ending sessions at expiry** (Q4): rejected; access already ends at the Clock and the worker would need the session store.
- **Relying on the worker to end access**: rejected; a late or failed job would extend access.
- **Filtering `app.mfa_state()` on active rows**: rejected (D9); MFA would drop and need a remap at reactivation.
- **A new `org.member.suspend` key**: rejected; `org.member.update` and `project.member.assign` cover it and the MFA admin set stays as it is.
- **`before`/`after` in the activity view** (Q7): deferred; it would expose personal data and reasons.
