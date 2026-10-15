# 0054. RLS policy framework: `app.*` functions, `enableTenantRls()`, and a deny-by-default migrator guard

- Status: Accepted
- Date: 2026-10-15
- Deciders: Mohamed Abass Jalloh
- Source: P4-04 (task plan approved 2026-10-15 21:19Z: decisions 1–7 as ★, conditions 1–5 and two added sabotages); CLAUDE.md rules 2, 3, 4, 11 and 12; ADR 0003 (RLS context), ADR 0035 (database roles), ADR 0048 (RLS fragments from `@bricx/permissions`), ADR 0052 (the migrator), ADR 0053 (`withTx()` and its settings).

## Context

ROADMAP P4-04 asks for `app.current_org()` and `app.has_project(uuid)`, a migration helper `enableTenantRls()` that emits `ENABLE`/`FORCE ROW LEVEL SECURITY` and the policies, and a check that fails when a table with `org_id` lacks FORCE RLS. Done when cross-tenant reads and writes fail for every table, in a parametrised test that iterates `information_schema`. The ROADMAP's "Also" line (from P2-02) adds: functions `bricx_owner` creates have EXECUTE revoked from PUBLIC by default, and every SECURITY DEFINER function sets its own `search_path`.

Constraints already decided:
- The RLS expressions come from `@bricx/permissions` (`rls.sql`, ADR 0048): tenant and project isolation only, never hand-copied (rule 11).
- `withTx()` sets `app.org_id`, `app.user_id` and `app.project_ids` (an array literal) with `set_config(…, true)`. After COMMIT a setting reads `''`, not NULL, in that session (ADR 0053).
- `bricx_owner` may not `CREATE SCHEMA` (ADR 0035, ADR 0052).

No tenant table exists yet; P4-05 adds `audit_events`, the first.

## Decision

**Schema `app` (bootstrap, decision 1).** `01-bootstrap.sh` creates schema `app` owned by `bricx_owner`, revokes everything from PUBLIC, and grants USAGE to `bricx_app` and `bricx_readonly` (not `powersync_repl`: it has BYPASSRLS). It also runs `ALTER DEFAULT PRIVILEGES FOR ROLE bricx_owner REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC`, for every schema. `dev:up` lists `app` among the bootstrap objects, so an older volume stops with the `pnpm dev:reset` instruction. Amends ADR 0035.

**Functions (migration `0000_rls_functions`, decisions 3 and 6).** `app.current_org()`, `app.current_user_id()` and `app.has_project(uuid)`:
- `LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER`, SQL-standard `BEGIN ATOMIC` bodies, no `SET` clause.
- The `BEGIN ATOMIC` bodies are parsed and their names resolved when the function is created, not at each call, so the unqualified `current_setting` is bound to `pg_catalog` then and a caller's `search_path` cannot redirect it.
- `NULLIF(current_setting(…, true), '')` on every setting, so unset or `''` means NULL and `has_project()` is false. No `''::uuid` cast can fail with 22P02.
- EXECUTE granted to `bricx_app` and `bricx_readonly` only.

`rls.sql` now uses `created_by = app.current_user_id()` instead of a raw `current_setting('app.user_id', true)::uuid` cast (amends ADR 0048).

**Expressions as data (decision 2).** `@bricx/permissions/generate` exports `rlsPolicies(model)`: one frozen entry per resource with its level, isolation columns, `createdBy`, `appendOnly`, and the SELECT, INSERT and UPDATE expressions. `generateRls()` renders `rls.sql` from it, and a test proves each entry equals its `rls.sql` section. `@bricx/db` gains a workspace dependency on `@bricx/permissions`; permissions never imports db (tested).

**`enableTenantRls(table, resource)` (`@bricx/db/rls`).** It returns drizzle-kit migration statements for `bricx.<name>`:
- `ENABLE` and `FORCE ROW LEVEL SECURITY`.
- One permissive policy per command, each with an explicit TO clause (condition 4; `POLICY_ROLES`):

  | Policy | Roles | Clause |
  |---|---|---|
  | `<name>_select` | `bricx_owner, bricx_app, bricx_readonly` | `USING` select |
  | `<name>_insert` | `bricx_owner, bricx_app` | `WITH CHECK` insert |
  | `<name>_update` | `bricx_owner, bricx_app` | `USING` and `WITH CHECK` update |

- No DELETE policy, so a DELETE matches no row under FORCE.
- An append-only resource gets no UPDATE policy, and `REVOKE UPDATE, DELETE … FROM bricx_app` (rule 2, condition 1), so both fail with 42501.
- The table name must match `^bricx\.[a-z][a-z0-9_]{0,55}$`, so the policy names fit in 63 bytes. Errors never echo the input.
- `TENANT_TABLES` maps each tenant table to its resource. It ships empty; P4-05 adds `audit_events`.

**`pnpm db:rls <bricx.table> <resource>` (decision 5).** It prints that SQL. It goes into the migration that creates the table, in the same transaction, and is hand-reviewed (rule 12).

**The migrator's guard (decision 4, condition 2).** After each migration's statements, inside its transaction, `migrate()` runs `guardProblem()`. It is deny-by-default:
- Every table (`r` or `p`) in schemas `bricx` and `app` needs ENABLE and FORCE, with or without `org_id`, unless it is listed in `GLOBAL_TABLES`. That list ships empty, and each entry needs an ADR line. A miss is `tenant_rls_missing`.
- A materialized view (`m`) or foreign table (`f`) in those schemas cannot carry RLS, so it is refused the same way unless it is on `GLOBAL_TABLES` (owner review of PR #50). Plain views stay allowed: they store no rows, and the tables they read keep their FORCE policies.
- Every SECURITY DEFINER function `bricx_owner` owns needs a `search_path` in its `proconfig`. A miss is `definer_search_path`.
- Both errors name the tag and the relation from the catalog, and the migration rolls back.

The guard lives in `migrate.ts` because Semgrep's `bricx-db-query-outside-withtx` allows queries only there and in `database.ts`. `rls-guard.ts` holds only `GLOBAL_TABLES`, so the migrate entry point never loads `@bricx/permissions`. This replaces the ROADMAP's separate CI script: every migration is checked when it applies, locally, in CI's integration suites and at deploy.

**Fixtures (decision 7, condition 3).** `packages/db/test/fixtures/rls` holds two migrations, applied by the real migrator after the production journal. `9000_fx_rls_shapes` has one table per policy shape:

| Table | Shape |
|---|---|
| `fx_organization` | org, keyed by `id` |
| `fx_org_member` | org |
| `fx_org_audit` | append-only |
| `fx_project_member` | project |
| `fx_project_task` | site with `created_by` |
| `fx_project` | `project.project` |

`9001_fx_functions` holds a later function and a DEFINER function with a pinned `search_path`. The production journal holds none of them (unit test). The production run passes no folder (source test) and applies exactly the production journal, with no `fx_` object (integration test).

**Data migrations (condition 5).** FORCE binds `bricx_owner` too. A migration that reads or writes tenant rows sees none until it sets a context. The sanctioned pattern sets the context inside the migration, one org at a time, with transaction-local settings:

```sql
SELECT set_config('app.org_id', '<org uuid>', true);
--> statement-breakpoint
UPDATE bricx.<table> SET <column> = <value> WHERE <condition>;
```

A project- or site-scoped table also needs `app.project_ids`, or `app.has_project()` is false and the backfill touches nothing:

```sql
SELECT set_config('app.org_id', '<org uuid>', true);
--> statement-breakpoint
SELECT set_config('app.project_ids', '{<project uuid>,<project uuid>}', true);
--> statement-breakpoint
UPDATE bricx.<table> SET <column> = <value> WHERE <condition>;
```

The setting ends with the migration's transaction. A backfill across every org needs a list of org ids it can read: `org.organization` rows are themselves under RLS. Until a global table holds them, the migration names the orgs it touches. Tested: without a context the UPDATE touches nothing; with org A's context, only A's rows; on a project-scoped table, the org alone touches nothing and adding A's project touches only A's rows. No code is added for this. Briefly dropping FORCE inside one migration (`NO FORCE`, the backfill, `FORCE`) would pass the guard, which checks at the end of the transaction. It is not sanctioned. (for architect review)

## Alternatives rejected

- **SQL in each migration written by hand:** the expressions would be copied, against rule 11.
- **A separate CI script scanning the catalog:** it checks only what CI applies. The guard checks every migration where it runs and rolls it back.
- **A guard only for tables with `org_id`:** a global table must be a decision recorded in an ADR, not an omission (condition 2).
- **SECURITY DEFINER helper functions:** they would run as `bricx_owner` and need a pinned `search_path`. INVOKER needs neither, and reads the caller's settings.
- **`current_setting(…)::uuid` without NULLIF:** it fails with 22P02 on a pooled connection after the setting's transaction (ADR 0053, tested).
- **Policies without `bricx_owner`:** a data migration could never see or write tenant rows (condition 5).
- **Fixture migrations in the production journal:** they would reach every database (condition 3).

## Consequences

- Every tenant table's migration appends `pnpm db:rls` output and adds the table to `TENANT_TABLES`. The parametrised integration test then proves it (`rls.int.test.ts`):
  - no rows without a context;
  - each org sees only its own rows;
  - a cross-org INSERT is 42501, a cross-org UPDATE matches nothing, and moving a row to another org is 42501;
  - DELETE matches nothing (append-only: 42501);
  - a project or site row is invisible outside the context's projects;
  - a forged `created_by` is 42501;
  - the same for `bricx_readonly` (reads only) and `bricx_owner` (bound by FORCE).
- The test fails when schema `bricx` holds a table that is not registered. A new column type with no test value fails loudly, naming the table.
- The test seeds every registered table with independent rows. A table with a foreign key to another tenant table will need its parent seeded first (P4-05 onward). (for architect review)
- Existing local volumes need `pnpm dev:reset` (the bootstrap changed). P13-03 creates schema `app` and the default-privilege revoke in the RDS bootstrap ("Also" line).
- drizzle-kit writes no RLS, so its output alone is refused until the migration appends the helper's SQL (tested).
- RLS does not protect replication (rule 3): `powersync_repl` keeps BYPASSRLS, and P8-02's sync streams and leak tests scope it.
