# 0068. Authorization guard and SoD enforcement

- Status: Accepted
- Date: 2026-10-23
- Deciders: Mohamed Abass Jalloh
- Source: P5-07 (task plan approved 2026-10-23 at 14:45Z with decisions D-A, D-B, D-C, D-D, D-E, D-G, D-H and D-I as proposed, D-F changed to a 401 step-up per RFC 9470, and owner conditions 1–7); the owner's phase decision D2 = (a) of 2026-10-22 (ADR 0067); ADR 0048 (the catalogue, `SOD_RULES`, `checkSod`), ADR 0053 (`withTx()`), ADR 0054 (RLS), ADR 0060 (the realm, `acr`), ADR 0062 (the AuthGuard), ADR 0066 (`DbGrantsSource`, `requiresMfa`), ADR 0067 (elevations).

## Context

Until P5-07 every route checked its permission inside its service, nothing checked that a route was covered at all, a finance key worked at any authentication level, and `checkSod` existed with no history to read. CLAUDE.md rule 10 needs requester ≠ approver on the server, rule 11 needs the four authorization layers generated from `@bricx/permissions`, and D2 = (a) needs a second approver in every organisation, single-member ones included.

## Decision

### The guard (D-E, D-I; conditions 4 and 5)

- `Identity.acr` is `"mfa"` only when the verified token's `acr` claim is exactly `mfa`; a missing or any other value is `"pwd"`. The identity is sealed to those two values; no header is read for it.
- `@Can(permission, { projectParam, siteParam })` names a catalogue permission and the route parameters that hold its scope. The declaration is checked when the class is declared, so an unknown permission, or a parameter the resource's level cannot have, stops the app from loading.
- `@NoPermission(reason)` marks a self-service route (the caller's own rows), checked in its service. `@Public()` is unchanged.
- `createApp` refuses to start when any route, src or test-only, carries none of the three. The route list is pinned in `apps/api/test/can-guard.test.ts`.
- `CanGuard` runs after the AuthGuard. It seals the request context and builds the ability with `abilityFor`: the grants `DbGrantsSource` read, elevations included, memoised for the sealed identity. There is no second path to an elevated key, and `buildAbility` is called only in `ability.ts`.
- Scope: an org resource is checked at the org; a project (or site) resource whose rule names its parameters is checked at the project (and site) in the path. With no parameter declared, or a parameter that is not a UUIDv7, the guard asks whether the action is held anywhere in the org, and the service checks the record. A resource whose rows carry `created_by` is checked as a row the caller created. Both fallbacks are for architect review.
- A refusal is 403 `forbidden` with one `authz.denied` line naming the permission.
- Service-level checks (`assertCan`, `holdsAll`, target protection) are unchanged: controllers only gained decorator lines. The OpenAPI document is unchanged.

### The step-up (D-F as changed; conditions 1 and 3)

- A permission with `MFA_KEY_PREFIX` (`requiresMfa`, every `finance.*` key, reads included) at `acr` other than `mfa` is 401 `permission.step_up_required`.
- The response carries `WWW-Authenticate: Bearer error="insufficient_user_authentication", acr_values="mfa"`. It is never 403 and never `session_expired`. One `authz.step_up` line names the permission.
- A finance key the user does not hold is 403 at any `acr`, because stepping up would not help.
- `app.mfa_state()`'s `finance.%` patterns are checked against `MFA_KEY_PREFIX` on the live database (`packages/db/test/access-grants.int.test.ts`).

### The SoD history (D-A; condition 2)

`bricx.sod_actions` (migration `0008_sod_actions`) has these columns: `id` (UUIDv7), `org_id`, `chain_id`, `record_id`, `record_type` (a catalogue subject), `action`, `actor_id → users`, `project_id` (nullable), `created_at`.

- It is a system-tenant table (`SYSTEM_TENANT_TABLES`, `enableSodActionsRls()`) with FORCE RLS. `bricx_app` has SELECT and INSERT only; `bricx_readonly` has SELECT.
- It is append-only (`APPEND_ONLY_TABLES`, the `append_only` triggers), not a catalogue resource, and not published to PowerSync.
- The INSERT trigger `sod_actions_segregation` runs `bricx.sod_conflict()`, generated from `SOD_RULES` (`packages/permissions/generated/sod.sql`) and drift-tested against the live function. It takes the chain's advisory lock (`SOD_LOCK_NAMESPACE`, `hashtext(chain_id)`) and refuses a row whose actor already did a conflicting action on the chain, with 23514 and the constraint `sod_actions_segregation`. Superusers are refused too.

### SodService (D-B, D-C, D2 = (a))

`SodService` is a global module (`apps/api/src/modules/sod`), called inside the action's own transaction.

`perform(tx, action)` takes these steps:

1. Takes the chain's advisory lock.
2. Reads the history (`@bricx/db/sod`, bounded by `LIMITS.sodHistory`).
3. Runs `checkSod` with `identity.userId` as the actor. An elevation changes what a user may do, never who acted.
4. Writes the history row.

A conflict, or the trigger's refusal, is 403 `permission.sod_violation` with one `sod.violation` line naming the rule. There is no override, owners included, and no expiry. A chain over the history limit is 409 `request.conflict`.

`approvalState(tx, record)` is derived at read time:

- `approved` once the chain holds the record's `approve`.
- `awaiting_approval` when another open member of the org holds the approve permission at the record's scope. That member must not be an actor of a conflicting action on the chain. Memberships and active elevations both count, and MFA is not needed to count.
- `sod_no_approver` otherwise.

The candidates are read with the grants source's own SQL (`accessRowsFor`, now shared with `DbGrantsSource`), at most `MAX_APPROVER_CANDIDATES` (1 000) members in batches of 100. Past that limit the request waits (for architect review).

### Fixtures (D-D)

The finance and SoD routes used by the Done-when suites live in `apps/api/test/support` (`finance-fixture.ts`, `sod-fixture.ts`) and reach an app only through `createApp`'s `extraControllers`. `src` has no finance route before P9.

### Deferred (D-G, D-H; condition 7)

- P9-05 gets an Also line: a second approver for elevations of `finance.*` keys, and `max_age` or `auth_time` for payment approval.
- P8-01 gets an Also line: who sets `devices.trusted`, and whether device binding becomes a requirement for the sync token.

## Consequences

- A new route without a marker fails at boot, in tests and in production alike.
- A finance user signed in without OTP can read nothing in finance until they sign in again with OTP; the client must handle the 401 challenge (P7).
- P9's finance and supply modules call `SodService.perform` in their transactions and show `approvalState`. The database backstop holds even if a module forgets.
- Migration `0008` needs `pnpm db:migrate` (or `pnpm dev:reset`) after merge.

## Alternatives rejected

- A 403 for a missing `acr` (the plan's D-F): the owner chose RFC 9470's 401 challenge, so a client can tell "sign in again with OTP" from "not allowed".
- Guarding new routes only (D-E alternative): existing routes would stay outside the coverage test.
- A stored `sod_no_approver` flag kept current by a job (D-B alternative): derived at read time it cannot go stale when a member joins or leaves.
- Counting only `bricx-mfa` holders as approvers (D-C alternative): the approver's MFA is checked when they approve; requiring it to count would hide approvers who simply have not signed in yet.
- A real payments stub in `src` (D-D alternative): finance routes belong to P9.
