# 0048. `@bricx/permissions`: one catalogue generating CASL, RLS fragments, sync-stream parameters and SoD

- Status: Accepted; amended by [0054](0054-rls-policy-framework.md) (`rls.sql` uses `app.current_user_id()` instead of `current_setting('app.user_id', true)::uuid`; the expressions are also exported as data by `rlsPolicies()`); amended by [0063](0063-devices-sessions.md) (P5-03 adds the resource `org.session` with actions `read` and `revoke` at org scope, held by owner and, read only, auditor: 28 resources, 83 permissions, 192 entries); amended by [0066](0066-grants-roles-project-overrides.md) (P5-05 adds the resources `org.role` (`read`, `manage`, org scope) and `org.member` (`read`, `invite`, `update`, `remove`, org scope) and `project.member` (`read`, `assign`, org or project scope); `effectiveKeys()`, `validateOverrides()` and `requiresMfa()` in `overrides.ts` and `mfa.ts`; role display names stay i18n keys); amended by [0067](0067-temporary-elevated-access.md) (P5-06 adds the resource `org.access_grant` with actions `read`, `grant` and `revoke` at org scope, held by owner and, read only, auditor: 29 resources, 86 permissions, 195 entries)
- Date: 2026-10-14
- Deciders: Mohamed Abass Jalloh
- Source: P3-05 (plan approved 2026-10-14 18:08Z with architect rulings 1–9; D1–D5, D10 and D11 accepted as written); the P3 standing rules (2026-10-13); CLAUDE.md rules 3, 4, 9, 10 and 11; ADR 0023 (dependency policy); ADR 0041 (ids), ADR 0046 (i18n).

## Context

ROADMAP P3-05 asks for a permission catalogue as data (`resource.action.scope`, scope ∈ `own | site | project | org`), twelve default role bundles, `buildAbility(grants, context)` returning a CASL ability usable on API and client, a segregation-of-duties (SoD) matrix, and generators for RLS and PowerSync fragments, done when the catalogue has a snapshot test and every default role is tested against 10 sample actions. The owner added: one source for every authorization layer (CLAUDE.md rule 11), nothing hand-copied; deny by default with no `manage all`; closed lists; SoD as a server-side pure function with an exhaustive table test; generated SQL as output only (no migration); a drift test per generated layer; no domain, db or Node imports; bounds before parsing; code-only errors; i18n keys for denial messages.

Evidence (Node 24.22.0; npm registry, 2026-10-14; raw output in the PR):

- `@casl/ability` 7.0.1: published 2026-07-06T19:55:28.244Z, MIT, `sha512-krOW1zQGEie5lH6fpryrcsPvc5r2pe5Vn5xbthuzc5X9gwzHIyZgGGgw9dMoSLHXdjB4BIVxGG/HBkG+1NuyZQ==`, no install scripts. One dependency, `@ucast/mongo2js` 2.0.0 (2026-04-24T14:10:00.569Z), which pins `@ucast/core` 2.0.0 (2026-04-24T12:23:47.510Z), `@ucast/js` 4.0.1 (2026-04-24T14:09:19.595Z) and `@ucast/mongo` 3.0.0 (2026-04-24T12:24:06.566Z), all Apache-2.0 with no install scripts. The ESM builds total 25,283 B minified (about 9.9 KB gzipped), with no `node:*` import and no clock or random call. The alternative, 6.8.1 (2026-04-20T04:58:55.172Z), is the previous major.
- CASL treats the action `manage` and the subject `all` as wildcards by default (`anyAction`, `anySubjectType`). The catalogue has a literal `org.role.manage`, so both are set to an unreachable sentinel (`"\u0000none"`).
- CASL's `ability.can(action, subjectType)` on a bare type string answers "is there any rule", ignoring conditions. A type-only check would let a project-scoped grant pass for every project.

## Decision

### Catalogue (D2, D4)

`src/catalogue.ts` holds 27 resources (`module.resource`), 81 permissions (`module.resource.action`, 20 distinct actions) and 190 catalogue entries (`module.resource.action.scope`, e.g. `finance.payment.approve.project`). Each resource declares its level (the isolation columns its rows carry: org, project or site), whether rows carry `created_by`, whether it is synced, whether it is append-only, and each action's allowed scopes. `site` scope needs site rows, `project` scope needs project or site rows, `own` needs `created_by`, approve is never `own`, and every action allows `org`. `validateModel` checks these rules, and a test makes it fail for each one. CASL sees subject `finance.payment` and action `approve`. Closed lists: an unknown subject, action, scope or permission is a type error at compile time and `unknown_permission` / `scope_not_allowed` at run time.

### Grants, context and the fail-closed check (D3, ruling 1)

A grant is `{ permission, scope: "org" | "own" }`, `{ permission, scope: "project", projectIds }` or `{ permission, scope: "site", siteIds }`, so one user can hold different roles on different projects. The context is `{ orgId: OrgId, userId: UserId }` from `@bricx/ids`. Scope conditions (CASL Mongo, closed field set): org → `{ orgId }`; project → `{ orgId, projectId: { $in } }`; site → `{ orgId, siteId: { $in } }`; own → `{ orgId, createdBy: userId }`. Every rule carries `orgId`.

`buildAbility` returns an opaque frozen handle; the CASL engine sits in a module-private `WeakMap`, so the raw `ability.can` is never exported. The only check is `can(ability, action, subjectType, record)`. It requires a record and validates the fields the resource's level needs (`orgId` always; `projectId` for project rows; `projectId` and `siteId` for site rows; `createdBy` where rows carry it) as UUIDv7 strings, then builds a fresh subject from those fields only. A missing or non-string field throws `invalid_record`; a foreign handle throws `invalid_ability`. `accessibleQuery(ability, action, subjectType)` is the list-query helper: `{ kind: "none" }` or `{ kind: "any_of", filters }`, one filter per grant; a rule without `orgId` throws. Tests, written first: a type-only check is denied, a record without `projectId` is denied for a project grant, a record of another org is denied; a sabotage mutant that calls the raw type-only check is caught.

### Default roles (ruling 4)

`src/roles.ts` lists every role's catalogue entries explicitly, with no shorthand: owner 81, project_owner 63, project_manager 52, quantity_surveyor 25, site_engineer 27, foreman 19, storekeeper 14, accountant 16, client 7, consultant 13, subcontractor 17, auditor 29. `grantsForRole(role, { projectIds, siteIds })` expands a bundle into grants. The generated `role-matrix.md` shows every role against every permission and is pasted into the PR. Rulings applied: client has no `finance.payment.read` and no `report.dashboard.read` and keeps milestone verify and change order sign-off; consultant has no `report.dashboard.read`; `document.file.share` is held only by owner, project_owner and project_manager; auditor holds only reads plus `org.audit.export` and `finance.ledger.export`; `project.project.create` is org scope only (owner); foreman, storekeeper, subcontractor, site_engineer, client and consultant hold none of `finance.ledger.*`, `finance.fx_rate.*`, `finance.budget.*`, `org.audit.*` and `org.role.*` (one negative test each, a hand-written oracle). The Done-when test checks every role against 10 sample actions, each against a record in scope, in another project and in another org, against a hand-written table.

### RLS fragments (D6 as amended by ruling 2)

`generated/rls.sql` holds, per resource, SQL boolean expressions for SELECT USING, INSERT WITH CHECK and (unless append-only) UPDATE USING/WITH CHECK, and never DELETE. They use only `app.current_org()`, `app.has_project(uuid)` and `current_setting('app.user_id', true)` (the last on `created_by` at insert). `project.project` is the one exception at INSERT (architect review of PR #39): a new project's own id is not yet one of the user's projects, so its INSERT WITH CHECK is `org_id = app.current_org() AND created_by = current_setting('app.user_id', true)::uuid`, with no `has_project(id)`; its SELECT and UPDATE keep `has_project(id)`, and every other resource's INSERT is unchanged (generator test). **RLS stays tenant plus project isolation; per-permission, site and own granularity is CASL plus SoD in the API.** The file header says so. There are no table names and no migration: P4-04 turns each expression into a policy on the table that stores the resource.

### Sync-stream parameters (D7 as amended by ruling 3)

`generated/sync-streams.yaml` has one stream per synced resource, with its resource, required read permission, allowed scopes, org and project filter columns and a query filtered by that permission at those scopes. View and table names are placeholders (`<<user_grants>>`, `<<user_project_access>>`, `<<table:…>>`); the view shape belongs to P8-02, which also checks the syntax against the pinned PowerSync image. A generator test proves every stream filters by its read permission (and a mutant without the filter is caught). Synced resources: project, site, task, milestone, daily log, photo, attendance, drawing, material, material request, goods receipt, inventory and file (13). **`finance.expenditure` is not synced** (ruling 3): no finance resource syncs until financial sync is decided at P8-02/P9 (CLAUDE.md rule 9); `validateModel` rejects a synced finance resource.

### Segregation of duties (D8 as amended by rulings 5 and 6)

`checkSod({ chainId, recordType, recordId, action, actorId, history })` is a pure server-side function. History entries carry `(chainId, recordType, recordId, action, actorId)`; `chainId` is the originating record, so pairs that cross record types (a purchase order and its goods receipt) are matched through the chain. It returns `{ ok: true }` or `{ ok: false, code: "sod_violation", rule, key: "errors:permission.sod_violation" }`, where `rule` is the pair id `first|second`. It applies to every actor, owner included; **there is no override**. Thirteen pairs, as data in `src/sod-rules.ts`:

- From the ROADMAP: payment request / payment approve; purchase order create / goods receipt create; payment record / reconciliation create.
- **For owner review** (added in the plan; ruling 5 accepted them for listing here): daily log create / approve; attendance create / approve; material request create / approve; purchase order create / approve; budget create / approve; expenditure create / approve; change order create / approve.
- **Authoring side** (architect review of PR #39, blocking 1: a pair covers every authoring action, not only create): daily log update / approve; material request update / approve; budget update / approve.

`validateModel` fails when a resource with `approve` has no pair, and (`authoring_action_not_paired`) when any of its `create` or `update` actions is not paired with that `approve`. The exhaustive table runs against a hand-written pair list, so a dropped pair fails both it and `validateModel` (a sabotage mutant drops budget update / approve). The exhaustive table test covers every pair × same or different actor × both orders × same or other chain, and every non-paired permission pair is allowed. The PR has an informational table of the default roles holding both sides of a pair (ruling 7). The one-member-organisation question is recorded in `pending.md` (ruling 6) and not implemented.

### Errors and i18n (D10, D11)

`PermissionError` carries a code (`invalid_grants`, `too_many_grants`, `too_many_targets`, `unknown_permission`, `scope_not_allowed`, `invalid_context`, `invalid_record`, `invalid_ability`, `invalid_sod_input`, `too_many_history`, `invalid_model`), a fixed lowercase message and an i18n key; never an input value or a `cause`. Every code maps to `errors:forbidden` (fail closed, no detail for the user), a plain denial uses `errors:forbidden`, and an SoD violation uses the new key `errors:permission.sod_violation`, added to en, fr and ar. **The fr and ar text is machine-drafted** and needs native review before production. Keys are checked at compile time (`satisfies Record<…, MessageKey>`; a compiler sabotage with a missing key is caught).

### Bounds (D11)

Checked before any element or field is read: 1,000 grants, 1,000 targets per grant, 10,000 targets in total, 1,000 SoD history entries, 64-character permission names, 8 own keys on a grant, context, record or history entry. Tests count element reads through a Proxy and assert work done, with no millisecond limits.

### Dependency edges (ruling 8)

- `@bricx/ids` (value import): `OrgId`, `UserId`, `ProjectId`, `SiteId` and `isUuidV7` for context and record validation.
- `@casl/ability` 7.0.1 (value import): the rule engine (`createMongoAbility`) behind `can` and `accessibleQuery`.
- `@bricx/i18n` (type-only import of `MessageKey`): denial keys checked against the catalogs at compile time. A value import is a lint error (boundaries `dependency: { kind: "value" }`) and a sabotage. It is a runtime `dependency` because the exported error types name `MessageKey`.
- **Not used:** `@bricx/validation` and `zod`. Nothing here parses a wire format; grants, context and records are checked by hand-written bounded guards. DEPENDENCIES.md marks zod as not used by this package.
- Nothing above it: no money, validation, domain, db, app or Node built-in. The boundaries element `permissions` (`packages/permissions/src/**`) enforces this, with smoke fixtures for each allowed and banned edge and a real-path probe; ids, money, i18n, validation and domain may not import permissions. The clock and `Math.random` bans cover `packages/permissions/src`.

### Generators and drift (D6, D7, constraint 5)

`src/generate.ts` holds pure generators over a `Model` (catalogue, roles, SoD). `scripts/gen.mjs` writes `generated/{catalogue.json, roles.json, sod.json, rls.sql, sync-streams.yaml, role-matrix.md}`; `--check` exits 1 on a missing or stale file. A vitest drift test regenerates every file in memory and compares it byte for byte with the committed file, so `pnpm verify` fails on a stale output. Mutation tests per layer: dropping `own` from `field.photo.read` changes CASL rules and the sync stream for `field.photo` only (RLS is unchanged by design, ruling 2); making `field.photo` append-only changes RLS only; removing `field.photo` changes all three. `catalogue.json` is the Done-when snapshot.

### Client safety

No `node:*` import in `src`, no global `crypto` use, no clock or random; a test scans the sources and loads every module with `process` and `crypto` removed. Hermes: must confirm at P7 (CASL has not been run on Hermes here).

## Deviations from the plan (for architect review)

1. The plan said 28 resources but listed 27; the catalogue has the 27 listed.
2. Generators live in `src/generate.ts` and `src/model.ts`, not `src/generate/*.ts`; `SOD_RULES` moved to `src/sod-rules.ts` so the generator chain runs under plain Node (`@bricx/ids` uses `.js` specifiers that Node's type stripping cannot resolve).
3. Bounds: permission names are capped at 64 characters, not "strings ≤ 128"; an 8-key cap on objects was added. Error codes differ from the plan's list: `invalid_grants` (plural), plus `invalid_record`, `invalid_ability`, `invalid_sod_input`, `too_many_history` and `invalid_model`; an SoD violation is a result, not an error code.
4. `@bricx/validation` and `zod` are not used (ruling 8 allowed them only if reused).
5. Three `nosemgrep: bricx-clock-in-money-permissions` comments on the eslint-smoke clock fixtures for permissions (the Semgrep include pattern is unanchored, as in ADR 0045).

## Consequences

- Positive: one source for CASL, RLS, sync and SoD, with drift caught by `pnpm verify`; a check that cannot be called without a record; deny by default with literal `manage`; SoD across record types through the chain.
- Negative (for architect review): RLS does not enforce per-permission or own-row rules, so the API is the only enforcement of those for server writes; the sync and RLS fragments are unproven against a real PowerSync image and real tables until P8-02 and P4-04; the owner_review SoD pairs block a single site engineer from approving their own daily log, which small sites may feel; Project Owner and Project Manager hold both sides of material request update / approve, and Project Owner of budget update / approve, so on one chain each needs a second person; one machine-drafted fr and ar string awaits native review.

## Follow-ups

- **P4-04:** turn the RLS expressions into policies per table; implement `app.current_org()` and `app.has_project(uuid)`.
- **P5-05 / P5-07:** role display names (i18n), grant storage, `@Can` guards using `can` and `accessibleQuery`; the one-member-organisation SoD decision (pending.md) before P5-07.
- **P8-02:** the `<<user_grants>>` and `<<user_project_access>>` views, table names, and the stream syntax against the pinned PowerSync image; a leak test per stream. SELECT * in `sync-streams.yaml` is a placeholder: P8-02 must use explicit column allow-lists per stream, because cost and rate columns must not reach devices of roles without finance read, and the leak test must cover columns as well as rows (also in the generated file header).
- **Document phase:** the subcontractor reads files at scope `own` only (architect review of PR #39); sharing files with subcontractors goes through explicit share grants.
- **Tasks phase:** subcontractor `project.task.update` and `project.task.complete` at scope `own` mean `created_by`. Assignee-based conditions need a task assignee field; decide at the tasks phase.
- **Finance phase (P9):** a client-safe payment subject and a client-safe dashboard subject (the client and consultant have neither today); financial sync.
- **P7:** Hermes: must confirm at P7.
- **Before production:** native review of the fr and ar `errors:permission.sod_violation` text.
