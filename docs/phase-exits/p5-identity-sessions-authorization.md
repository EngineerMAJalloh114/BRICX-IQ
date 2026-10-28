# P5 Identity, sessions, authorization: phase exit evidence report

Main at **ecd8589** (P5-07 squash, PR #73, merged 2026-10-27 08:21Z). Node v24.22.0, pnpm 10.34.6, Docker 29.8.2. The report's own logs are in `/mnt/project-files/p5/exit/logs/` (every log carries `# run at`, `# HEAD` and a printed `exit=`), made by `/mnt/project-files/p5/exit/scripts/battery.sh` (sha256 in `battery.sh.sha256`, written before the run). Each task's proofs are under `/mnt/project-files/p5/<task>/proofs.md`.

The P5 exit is **not ticked** in ROADMAP.md: the owner approves it ("Exit criteria P5: security test suite (authn, revocation, RLS, SoD) green; 🔒 review by owner", ROADMAP.md:439).

## 0. Blocker found while making this report: `pnpm audit:prod` is red on main

`pnpm audit:prod` on main ecd8589 exits 1 (`logs/audit-prod.log`): **GHSA-gcqx-w48m-w2h4** (CVE-2026-93753), `deepmerge` `>=4.2.0 <=4.3.1`, "mergeObject() allows prototype poisoning of returned objects", pnpm severity low. Facts (`logs/deepmerge/`):

- Path: `apps/api > nestjs-zod@5.5.0 > deepmerge@4.3.1` (`reach.log`, `pnpm why -r deepmerge`: one version). nestjs-zod 5.5.0 is its latest release (2026-07-25) and declares `deepmerge ^4.3.1`; deepmerge 4.3.1 is deepmerge's latest release (2023-03-16). The advisory's patched range is `<0.0.0`: **no fixed version exists**, so neither a lockfile move nor an override (ADR 0038) can clear it.
- The advisory was created 2026-09-18 and updated 2026-10-27 21:34Z (`registry.log`). It was not reported on 2026-10-27 around 08:00Z: the battery at 2bb8ed3 (PR #73's last head) and CI run 40472974077 on main ecd8589 both had `audit:prod` green with only the braces ignore. The next CI run on any branch, this report's PR included, will fail the `security` check on it.
- Reachability (`callsites.log`): nestjs-zod calls `deepmerge` only while building the OpenAPI document and its schemas (`cleanupOpenApiDoc`, `createZodDto` schema merging, parameter fixing, intersection merging), with objects the API's own code and Zod produce; no request body or user-controlled JSON reaches it. Inferred, not proven by a test.
- Nothing was changed: CLAUDE.md and ADR 0023 forbid an audit ignore without the owner's ruling. Options for the owner (★ = recommended): (a) ★ a dated ignore under the ADR 0037 pattern (`scripts/audit-ignores.mjs`, revisit date, loud on every run) recorded in its own ADR, as a separate chore PR, with the reachability argument above; (b) replace `deepmerge` under nestjs-zod with a patched fork or a `pnpm patch` (new dependency surface, needs an ADR); (c) accept a red `security` check until nestjs-zod moves. Whichever is chosen, it is a chore PR, not part of this report.

## Tasks

| Task | PR (squash on main) | Final head | CI on the final head | Sabotages (all caught) | ADR | Proofs |
|---|---|---|---|---|---|---|
| P5-01 Keycloak realm as code 🔒 | #58 → 16000a5 (2026-10-18) | 8ea21a8, then 99ee690 after the architect review | run 39140173852, 6/6 green | 15 (+2 after the review) | 0060 | `p5-01/proofs.md`, `logs/final/`, `logs/sabotage/` |
| P5-02 API token validation | #59 → 121d60c (2026-10-21) | 9025626 | run 252 (39546352900), 6/6 green | 14 | 0061, 0062 | `p5-02/proofs.md`, `final/`, `final/sabotage/` |
| P5-03 Devices & sessions | #60 → 3030775 (2026-10-21) | 200ff14 (review commit 8) | run 256 (39625270517), 6/6 green | 22 (16 + s17–s22 after the review) | 0063 | `p5-03/proofs.md`, `review1/final/sabotage/` |
| P5-04 Immediate revocation 🔒 | #61 → 45afee7 (2026-10-21) | 7c50298 | run 258 (39647746118), 6/6 green | 17/17 | 0064, 0065 | `p5-04/proofs.md`, `final/sabotage/summary.md` |
| P5-05 Grants, roles, project overrides 🔒 | #62 → e7a8ac9 (2026-10-22) | 0d16679 | run 261 (39721365482), 6/6 green | 21/21 | 0066 | `p5-05/proofs.md`, `final/sabotage/acceptance.md` |
| P5-06 Temporary elevated access 🔒 | #71 → 45ac7dc (2026-10-23) | 8c1df64 → da12f70 (review 1) → e120938 (main merged) → b588946 (docs) | run 39958270919 on b588946, 6/6 green (run 39864279891 on da12f70 was red only on the fastify advisory, cleared by chore #72) | 23 (+7 after the review) | 0067 | `p5-06/proofs.md`, `sabotage/`, `review1/` |
| P5-07 Authorization guard & SoD 🔒 ⛔ | #73 → ecd8589 (2026-10-27) | 121c312 → 3ebc80f (CI fix) → cce9263 (review 1) → 2bb8ed3 (main merged) | run 40471190327 on 2bb8ed3, 6/6 green (run 39991283232 on 3ebc80f green) | 15 (+4 review, +2 merge check) | 0068 | `p5-07/proofs.md`, `sabotage/`, `review1/`, `merge-main-2/` |

Chores merged inside the phase: #72 fastify override 5.12.5 → 5.12.6 (main 82ab4ee, GHSA-389g-gv7q-r4x8), #74 zod 4.6.5 → 4.6.6 and fast-uri 3.1.8 → 3.1.9 / 4.2.1 → 4.2.3 (main 03bb623, CI run 40469550746 green; four fast-uri advisories cleared without an ignore). P5-02b (Keycloak import volume defect) is filed and unticked, see §7.

Every task plan was approved by the owner before code was written (plan and approval files beside each `proofs.md`); P5-01, P5-03, P5-06 and P5-07 also carried one owner review round each, answered by a commit on the PR branch. Every Done-when suite was run red before its implementation commit (the `red` logs under each task's `c<N>/` folders; from P5-06 on, every suite). PR #62 (P5-05) was merged with no architect review posted in the thread; its "for architect review" items are listed in `p5-05/proofs.md` §13.

## 1. Exit criterion: the security test suite is green on main

The battery ran on a clean checkout of main ecd8589 (`git status --short: 0 entries` in every header), the five integration suites one at a time, `pnpm verify --force` (no turbo cache). `logs/summary.txt` holds every item's exit code.

| Check | Log | Result |
|---|---|---|
| `node -v`, `pnpm -v`, `docker --version` | `env.log` | v24.22.0, 10.34.6, 29.8.2 |
| `pnpm install --frozen-lockfile --offline` | `install-frozen.log` | exit=0 |
| `pnpm audit:prod` | `audit-prod.log` | **exit=1**, GHSA-gcqx-w48m-w2h4 only (§0); braces ignored under ADR 0037 |
| `pnpm verify --force` | `verify-force.log` | 59/59 tasks, exit=0 (api unit 581, domain 373, …) |
| `@bricx/db` integration | `int-db-verbose.log` | 12 files, 389 passed, exit=0 |
| `@bricx/api` integration | `int-api-verbose.log` | 23 files, 283 passed, exit=0 (408 s) |
| `@bricx/worker` integration | `int-worker-verbose.log` | 5 files, 38 passed, exit=0 |
| `@bricx/db-bootstrap` integration | `int-db-bootstrap.log` | 3 files, 23 passed, exit=0 |
| `@bricx/keycloak-realm` integration | `int-keycloak-realm-verbose.log` | 2 files, 21 passed, exit=0 |
| `pnpm gen:api && git diff --exit-code -- packages/api-client` | `gen-api.log` | no diff, exit=0 |
| `pnpm i18n:check` | `i18n-check.log` | exit=0 |
| `pnpm semgrep` | `semgrep.log` | 17 rules on 669 files, 0 findings, exit=0 |
| `node scripts/gitleaks-staged.mjs --history` | `gitleaks-history.log` | no leaks found, exit=0 |
| `ls packages/db/migrations` | `migrations.log` | 0000–0008 (0004 users, 0005 devices_sessions, 0006 grants_roles, 0007 access_grants, 0008 sod_actions), exit=0 |
| `git status --short` after everything | `git-status.log` | **exit=1**: the one entry is `?? docs/phase-exits/`, this report's own draft, written while the suites ran; every suite's header shows `0 entries` |

CI on main ecd8589: run 370 (40472974077, push, 2026-10-27 08:21Z) **success**, all six jobs (install, pr-title, security, verify, integration, new-module); raw data in `logs/ci-main-ecd8589.json` with `head_sha`. The earlier main heads 03bb623 (run 40470891485) and 45ac7dc (run 39960459832) were green too.

Which suites carry each part of the criterion:

| Criterion | Suites on main ecd8589 |
|---|---|
| authn | api `auth.test.ts` (JWKS, audience, issuer, algorithms, tolerance), `auth.int.test.ts`, `auth-keycloak.int.test.ts` (live realm: expired, wrong audience, wrong issuer → 401; rotation), `sessions-guard.int.test.ts` (idle, revoked, device binding), `database-errors.int.test.ts` (sentinel never logged); keycloak-realm `realm-import.int.test.ts` and `realm-policy.test.ts` |
| revocation | api `revocation.int.test.ts` (built worker, 1 s budget), `devices-sessions.int.test.ts`; worker `revocation.int.test.ts`; db `devices-sessions.int.test.ts` (un-revoke refused) |
| RLS | db `rls.int.test.ts` (every tenant and user table, FORCE RLS, FK seeding order), `users.int.test.ts`, `devices-sessions.int.test.ts`, `access-grants.int.test.ts`, `sod.int.test.ts`; api `context.int.test.ts`; sync leak tests (`users`, `access_grants`, `sod_actions` not published) |
| SoD | permissions `sod.test.ts` (pairs, elevation never changes the actor); api `p5-07-done-when.int.test.ts` (every `SOD_RULES` pair both directions, same chain refused, other chain allowed, transaction atomicity, one success under a race, trigger backstop, single-member org D2 = (a)); db `sod.int.test.ts` (the table and its grants, the `sod_conflict()` backstop generated from `SOD_RULES`, drift test) |

## 2. Live checks

All three ran live inside the battery (Testcontainers Keycloak built from `infrastructure/docker/keycloak/Dockerfile`, Postgres, Valkey, the built worker) and are committed tests, not hand runs.

**Keycloak login with OTP and `acr` `mfa`.** `tooling/keycloak-realm/test/realm-import.int.test.ts` proves the imported realm equals the file (:89, :93, :100, :113) and the conditional OTP subflow and `acr` mapper (:135, :148, :174). `apps/api/test/p5-07-keycloak-step-up.int.test.ts:214`: a `bricx-mfa` user is made to set up OTP at login (`otpConfigured: true`), the token carries `acr` `mfa`, and the finance approve route returns 200. `:231`: a password-only user with the same grant gets `acr` `pwd`. `tooling/keycloak-realm/test/realm-login.int.test.ts:210` (P5-01 review): a `bricx-mfa` user passes OTP at login, gets `acr` `mfa`, and a refresh keeps `acr`, `auth_time` and the session while rotating the refresh token; `:217` a password-only user stays `pwd`; `:226` a password reset login never yields `mfa`. `apps/api/test/auth-keycloak.int.test.ts:185/:199/:227`: an expired, wrong-audience and wrong-issuer token are each 401 against the real realm. Verbose re-run on main (`logs/live/keycloak-realm-live.log`, 21 passed; `logs/live/api-live.log`, 64 passed): `realm-import.int.test.ts` "every value the file sets is the value Keycloak holds" (:9 in the log), "a second fresh Keycloak imports the identical realm" (:11), "the OTP subflow is conditional, keyed on role bricx-mfa, at level mfa" (:14), "the acr mapper is in bricx-client's default scopes, mfa = level 2" (:15); `realm-login.int.test.ts` "bricx-mfa user: OTP at login, acr mfa, same auth_time and session after a refresh, refresh token rotated" (:25), "password-only user: acr pwd stays pwd after a refresh" (:26), "a reset-credentials login of a bricx-mfa user without OTP gets acr pwd, never mfa" (:27); `p5-07-keycloak-step-up.int.test.ts` "a bricx-mfa user: OTP at login, acr mfa, the finance route is allowed" (api-live.log:20); `auth-keycloak.int.test.ts` expired, wrong audience, wrong issuer each 401 (api-live.log:15–17).

**Revocation within 1 s.** `apps/api/test/revocation.int.test.ts` asserts `BUDGET_MS = 1_000` on the `revoked:sid` key and on a fresh login's refusal, with the production relay defaults (idle poll 250 ms). This run printed: 11 ms to the same token's 401 (DB row), 38 ms to the `revoked:sid` key, 221 ms to a fresh org-A login's 401 through `revoked:user` (`logs/live/api-live.log:8–12`, tests "(a)+(b)+(d)" and "(c)+(d)" passed; no Keycloak session id, token or worker secret in either process's output, :13). `sessions-guard.int.test.ts`: a revoked session is 401 `session_expired`, an idle one is closed, an org value only shortens 12 h (api-live.log:64–68), unknown, another user's and revoked devices are 401 and write no row (:70–72). (P5-04's PR run: 13 ms to the 401 on the same token, 201 ms to the key, 261 ms to a fresh login's 401.)

**Step-up 401.** `p5-07-keycloak-step-up.int.test.ts:231` and `p5-07-done-when.int.test.ts` (DW3): a finance key at `acr` `pwd` answers 401 `permission.step_up_required` with `WWW-Authenticate: Bearer error="insufficient_user_authentication", acr_values="mfa"` (RFC 9470), an elevated finance key included; never 403 for a missing `acr`. Verbose re-run: "a password-only user with the same finance grant: acr pwd, 401 step-up with the RFC 9470 challenge, never 403; a non-finance route is allowed" (`logs/live/api-live.log:21`); "an elevated finance key, through DbGrantsSource: active: 200 at mfa, 401 step-up at pwd; expired: 403 at any acr; never the granter's grants" (:22); SoD DW5 31 cases and DW7 single-member org pending `sod_no_approver`, the owner's approval refused now and 30 days later, flipping with a second approver joining and leaving (:56–57); db `sod.int.test.ts` 37 `sod_conflict()` and table cases in `logs/live/db-rls-sod.log` (232 passed over `rls`, `sod`, `devices-sessions`, `access-grants`). The first attempt of this re-run (`logs/live-attempt1-node22/`) failed at once on the container's default Node 22 (pnpm engine check) before any test ran; the script then sources the Node 24 environment, its checksum rewritten before the second run.

## 3. Done-when evidence per task

**P5-01** (Done when: realm import is reproducible from file). `realm-import.int.test.ts:89` every value the file sets is the value Keycloak holds (subset compare with placeholders resolved), `:93` the declarative user profile, `:100` a second fresh Keycloak imports the identical realm (normalised exports equal), `:113` no users and the placeholder realm is 404; 13 tests at the final head (`logs/final/integration.log:254`). Deviation disclosed in ADR 0060: subset plus import-to-import equality, not a full export diff. Live login evidence (dev-time) `logs/final/live-login.log`; the committed live test is P5-07's DW4. Sabotages: 15 at 8ea21a8 (token TTL, PKCE, wildcard redirect, direct grants, brute force, `org_id` editable, MFA role renamed, bearer-only, three import mutants, unpinned Dockerfile, build args, rw mount, nosemgrep), every log `exit=1` naming the test.

**P5-02** (Verify: expired, wrong-audience, wrong-issuer → 401). `auth-keycloak.int.test.ts:185/:199/:227` live, plus valid `:169`, no `org_id` 403 `:238`, JWKS rotation `:249`; `auth.int.test.ts:190` a failed token writes no `audit_events` row and one `auth.failed` line; sentinel redaction `database-errors.int.test.ts`; pool-client error test db `tx-errors.int.test.ts`; `git grep TestIdentityGuard` exits 1. 14 sabotages at 9025626 (`final/sabotage/`), each `exit=1` with the failing test named (audience, issuer, HS256, tolerance, JWKS cache, users grants, `search_path`, PUBLIC execute, production `public`, `@Public()` on a route, audit row on failure, provisioning before the org check).

**P5-03** (devices, sessions, list/revoke, admin revoke). `apps/api/test/devices-sessions.int.test.ts` (revoke closes every session, one audit event and one outbox row in the same transaction, admin revoke needs `org.session.revoke.org`, lists open only, newest first, cap 100, device cap 409), `sessions-guard.int.test.ts:346–505` (device binding 401 `device_unknown`, idle 401 `session_expired`, org value only shortens 12 h), db `devices-sessions.int.test.ts` (own-row devices, org-isolated sessions, un-revoke refused 42501), `rls.int.test.ts:694/:724` (FK parents seeded first, child-first refused: P4 point 13), `session-policy.test.ts`. 22 sabotages at 200ff14 (`review1/final/sabotage/summary.md`), every row with at least one non-zero exit naming the test.

**P5-04** (Done when: a revoked user's next API call is 401 within 1 s; the next sync token request fails). `revocation.int.test.ts` with the built worker: 13 ms (same token, DB row), 201 ms (`revoked:sid` key), 261 ms (fresh login refused through `revoked:user`), assertions `≤ BUDGET_MS 1000`; worker `revocation.int.test.ts` COMMIT → `revocation.applied` 81 ms, Keycloak session ended (204 then 404). The second half, "the next sync token request fails": the sync token endpoint does not exist before P8-02, so phase ruling D10 (ADR 0060) moved it to P8-01's Also line (:515) and P5-04 built `assertSessionActive()` for it; `revocation.int.test.ts:430` (e) proves a live session passes and a revoked one is refused by it. The HTTP half is owed by P8-01. 17/17 sabotages at 7c50298 (`final/sabotage/summary.md`).

**P5-05** (roles, role_permissions, memberships, project_memberships, API to edit bundles, every change audited, `bricx-mfa` mapping). `apps/api/test/roles*.int.test.ts`, `memberships*.int.test.ts`, `grants-source*.test.ts` (escalation refused via `holdsAll`, owner virtual 409, last owner 409, removal closes sessions in-tx → 403 `membership_missing`, `X-Org-Id` choice), worker `mfa.int.test.ts` (COMMIT → `mfa.applied` 513 ms in the full run), db `migrate.int.test.ts` (owner-policy guard, `app.mfa_state` EXECUTE for `bricx_relay` only). 21/21 sabotages at 0d16679 (`final/sabotage/acceptance.md`). Disclosed: the c7 suite was not red-first (before the P5-06 ruling), `proofs.md` §13.

**P5-06** (access_grants, ability includes only active grants, worker expires and audits). DW1–DW7 in `p5-06/proofs.md` §3: db `access-grants.int.test.ts` (RLS, own-row, immutability trigger, not published), api `grants-source.int.test.ts` boundary instants on a moved Clock (9 999 ms out, 10 000 in, 69 999 in, 70 000 out), `modules/access-grants.int.test.ts` (19 tests: grant, list, revoke, escalation, self-grant, scope, duration, caps, audit and outbox in one transaction), worker `access.int.test.ts` (expire exactly once, early job throws, sweep, `bricx-mfa` cleared after the last finance elevation), permissions `sod.test.ts:375` (an elevation does not change the actor). 23 sabotages at 8c1df64 plus r1–r7 after the review (`sabotage/summary-all.json`, `review1/sabotage/summary.md`), all `exit=1` with named tests.

**P5-07** (DW1–DW9, `p5-07/proofs.md` §DW1–§DW9). DW1 `endAccessGrantsOf()` in `@bricx/db/access-grants`; DW2 route coverage test fails closed on an unmarked route, unknown key fails at boot, `buildAbility` only in `ability.ts`; DW3 step-up cases; DW4 live (above); DW5 every `SOD_RULES` pair derived from the list, both directions, atomicity, race, trigger backstop; DW6 elevation and granter never the actor; DW7 single-member org pending `sod_no_approver`, owner's approval refused now and 30 days later, approvable once a second member joins, back to pending when they leave; DW8 four layers from `@bricx/permissions`, trigger SQL drift test, sync leak test, `bricx_app` cannot UPDATE/DELETE/TRUNCATE; DW9 `permission.step_up_required` and `permission.sod_violation` in the catalogue, en/fr/ar and the regenerated OpenAPI. 15 sabotages at 121c312 (`sabotage/`), 4 after the review at cce9263 (`review1/`), battery and CI green again at 2bb8ed3 after merging main.

## 4. ADRs written in P5

| ADR | Title | Task | Status notes |
|---|---|---|---|
| 0060 | The bricx Keycloak realm as code, the optimized dev image, and the P5 phase decisions (rulings D1–D10) | P5-01 | Accepted; amended by P5-04 (§3b `bricx-worker`) and 0066 |
| 0061 | `jose` 6.2.12 for bearer-token verification | P5-02 | Accepted |
| 0062 | Bearer-token validation, user provisioning and OpenAPI exposure | P5-02 | Accepted; amended by 0063 (`reasonFor()`, `subject_missing`) |
| 0063 | Devices and sessions | P5-03 | Accepted; amended after the PR #60 review (bounded lists, device cap, retention) and by P5-04 |
| 0064 | `@keycloak/keycloak-admin-client` 26.8.1 in the worker | P5-04 | Accepted |
| 0065 | Immediate revocation | P5-04 | Accepted; amended by 0066 (removal cause `admin`, 30 s admin timeout) |
| 0066 | Grants, roles and project overrides | P5-05 | Accepted; amended by 0067 (`app.mfa_state()` v2 counts finance elevations) |
| 0067 | Temporary elevated access (records D2 = (a)) | P5-06 | Accepted (the PR #71 review amendments were written into it before the merge) |
| 0068 | Authorization guard and SoD enforcement | P5-07 | Accepted (the PR #73 review consequence on own-scoped grants was written into it before the merge) |

`docs/adr/pending.md`: D2 (SoD in a one-member organisation) and "audit events with no organisation" are struck through as resolved (ADR 0067, ADR 0060 D3). Still pending from P5: nothing; the next pending rows are P6-01 launch regions and P7-02 design decisions.

## 5. Accepted risks and their closing tasks

| Risk | Where recorded | Closing task | Date or trigger |
|---|---|---|---|
| The `bricx-worker` service account holds `realm-management` `manage-users` (the least Keycloak accepts for ending a session); a leaked `KEYCLOAK_WORKER_CLIENT_SECRET` lets an attacker map that role to their own user and reset passwords, never reach `realm-admin` | ADR 0060 §3b and Consequences; ADR 0065 | P13-01 Also (ROADMAP.md:676): fine-grained admin permissions for a session-only scope or a separate client for P5-05's role changes, plus secret rotation | P13-01 |
| The worker connects as `bricx_app` (`DATABASE_URL`) for `access_grants.expire` | ADR 0067, PR #71 review | P13-01 Also (ROADMAP.md:677): a dedicated narrow worker database role | P13-01 |
| `pnpm audit:prod` ignores GHSA-vfj7-8cjw-p6xm (braces, high, tooling only) | ADR 0037 | The guard fails on the revisit date and warns for 30 days before | **Revisit by 2027-01-04** |
| `deepmerge` GHSA-gcqx-w48m-w2h4 under nestjs-zod, no fixed version | this report §0, `logs/deepmerge/` | **Owner ruling needed** (chore PR) | now: CI `security` red on every branch |
| Ending a Keycloak session is org-agnostic: a revoke in one organisation forces a re-login in every organisation | ADR 0065 | none (accepted by design) | — |
| `devices.trusted` is written by nobody; device binding is advisory | ADR 0063, ADR 0068 | P8-01 Also (ROADMAP.md:516) | P8-01 |
| Realm drift after import is not detected (`IGNORE_EXISTING`; the tests read a fresh import) | ADR 0060 Consequences | P13-01 Also (ROADMAP.md:675) | P13-01 |
| Keycloak dev-stack import volume stubs break `pnpm dev:up` after a reboot | ROADMAP P5-02b | P5-02b (unplanned, filed) | owner names it |

## 6. Open Also lines carried out of P5 (ROADMAP.md line numbers on main ecd8589)

**P6**
- :448 P6-02 (from P5-05, ADR 0066, condition 6): creating an organisation calls `bootstrapOrganization()`; invitations prompt for a second member.
- :451 P6-03 (ruling D6, P5-01 condition 7, ADR 0060): the org session idle timeout lives here and only shortens the realm's 12 h; the P5-03 session check enforces it.
- :456 P6-05 (from P5-05, D-D): `project_memberships.project_id` gains its FK to `projects`; site-scoped keys.
- :457 P6-05 (from P5-06, ADR 0067): `access_grants.scope_id` gains its FK; site-scoped elevations once sites exist.
- :481 P6-06 (D2 = (a), ADR 0067): onboarding prompts the owner to invite a second member before finance workflows.

**P7**
- :502 P7-05 (P5-01 architect review item 1, ADR 0060): passkey sign-in (P5-01 shipped registration only).
- :504 P7-06 (from P5-06, ADR 0067): the elevation countdown reads `GET /v1/me/access-grants` and refreshes the ability.
- Hermes checks still owed from P3/P4 (`Intl.Locale`/`PluralRules` polyfill, `crypto.getRandomValues`, `Headers.entries`) are listed in the P4 exit report §3 and unchanged.

**P8**
- :515 P8-01 (ruling D10, P5-04, ADR 0065): `GET /v1/sync/token` calls `assertSessionActive(sessionId)` and consumes `sync.revoke`.
- :516 P8-01 (from P5-03 and P5-07, condition 7, ADR 0068): decide who sets `devices.trusted` and whether device binding becomes a requirement.
- :521 P8-02 (from P5-06, ADR 0067): a device's grant set and stream scopes include active elevations exactly as `DbGrantsSource` merges them.

**P9**
- :575 P9-05 (from P5-07, condition 7, ADR 0068): whether an elevation of a `finance.*` key needs a second approver; `max_age` or a recent-MFA requirement (`auth_time`) for payment approval; approvals use `SodService` and `bricx.sod_actions`.
- :576 P9-05 (PR #73 review, ADR 0068): (a) every own-scoped service loads the real row and checks it; (b) replace the scan of at most 1,000 open members in `SodService.approvalState` with a query of the approve-key holders at the record's scope.

**P13**
- :675 P13-01 (from P5-01, D4 and condition 2, ADR 0060): the OpenTofu `keycloak` module creates each cell's realm from the file; drift check.
- :676 P13-01 (from P5-04, condition 2, ADR 0060 §3b, ADR 0065): narrow `manage-users` (accepted risk above).
- :677 P13-01 (from P5-06, PR #71 review, ADR 0067): a dedicated narrow worker database role (accepted risk above).
- :691 P13-05 (from P5-06): alert on `access.expire_failed` and `access.sweep_failed`; chart the `access` queue delay.
- :693 P13-05 (ruling D3, ADR 0060): alert on the security log line for failed tokens with no known organisation.
- :694 P13-05 (from P5-05): alert on `mfa.keycloak_failed` and `mfa.user_missing`.
- :695 P13-05 (from P5-04): alert on `revocation.keycloak_failed`.

**P14**
- :709 P14-06 (from P5-06): a reconcile check over `access_grants.expired_at` and the audit chain.
- :710 P14-06 (from P5-05): a `bricx-mfa` reconcile job and its runbook.

P5-01's own Also line about `/openapi.json` exposure was closed by P5-02 (`OPENAPI_EXPOSURE`, ADR 0062). P5-07's Also lines (live login test, `endAccessGrantsOf()` move, D2) were closed by P5-07 itself.

## 7. Chores queue (nothing started; none of these is P5 work)

**Dependabot pull requests, open on 2026-10-28** (nobody pushes to a Dependabot branch; `list_project_prs` does not show them):
- #75 npm minor-and-patch group, 21 updates (rebased on ecd8589).
- #70 `@nestjs/swagger` 11.4.7 → 12.0.2; #69 `@nestjs/common` 11.2.7 → 12.2.0; #68 `@nestjs/core` 11.2.7 → 12.2.0; #64 `@nestjs/platform-fastify` 11.2.7 → 12.2.0; #66 `@nestjs/terminus` 11.1.1 → 12.1.0: a NestJS major, one decision (ADR 0051 pins Nest 11; nestjs-zod 5.5.0 declares `@nestjs/common ^10 || ^11`, so Nest 12 is blocked until nestjs-zod supports it).
- #67 `@types/node` 24.19.0 → 25.9.9 (ADR 0024 pairs `@types/node` with the Node 24 engine; refuse or re-decide).
- #65 typescript 5.9.3 → 6.0.3 (ADR 0026 says stay on 5.9; refuse).
- #44 actions/setup-node 7.0.0 → 7.1.0 (base e7a8ac9; its title exceeded commitlint's 100 characters in the P4 report; re-check).
- All of these will show the `security` check red for the deepmerge advisory (§0) on their next CI run.

**Filed in ROADMAP, unplanned:**
- P5-02b Keycloak dev-stack import volume (ROADMAP.md:393–396): mount the named volume at the database path only, bind the realm file separately, compose guard test, amend ADR 0060; `pnpm dev:reset` completes `.env` before compose.
- The three chores filed with the P5-03 plan (ROADMAP.md:397): `bsync` runs `pnpm install --frozen-lockfile` when the lockfile changed; every PR's "Verify locally (owner)" lists the follow-up commands when `.env.example` or the lockfile changes; the runbook says `fuser -k 4000/tcp` for a leftover API.

**Dependency ruling needed:** the deepmerge advisory (§0).

**Owner items still open from earlier phases (no action by Claude):** delete branch `p1-06-throwaway-lint-red`; apply `docs/runbooks/github-settings.md`; spot-check the ADR 0031–0033 negatives.

**Known flake, unfixed:** `packages/db/test/database.int.test.ts` "ping succeeds as bricx_app" (one connection left after close), seen once in P4 and once inside a P5-05 sabotage run; and `@bricx/i18n test/limits.test.ts > prescanMessage > is linear` (a wall-clock test that fails under load, seen in a P5-03 sabotage run). Neither failed in this battery.

**P4 carry-forwards** (architect-review points never ruled, Hermes checks, P13 infrastructure lines) are unchanged from `/mnt/project-files/p4/exit/report.md` §3 and §5.1 and are not repeated here.

## 8. 🔒 review by the owner

What the owner has in hand for the review: the seven task PRs (#58, #59, #60, #61, #62, #71, #73) and their task plans, approvals and review rounds; this battery on main; CI run 40472974077. Items each task marked "for architect review" are listed in its `proofs.md` and PR body; P5-05 (PR #62) is the one task whose review round was never posted.

## Owner decision

_Left for the owner: P5 exit approved or not; the deepmerge ruling (§0); Dependabot decisions (§7)._
