# 0059. The module template and `pnpm new-module`; the migrator's catalog guard and the publication pairing rules

- Status: Accepted; amended by [0062](0062-token-validation-users.md) (the template's tests get their identity from real tokens through `apps/api/test/support/auth.ts`; the copied test identity guard is gone)
- Date: 2026-10-17
- Deciders: Mohamed Abass Jalloh
- Source: P4-09. The task plan was approved on 2026-10-17 at 21:29Z with decisions 1–7 and owner conditions 1–6. On the decision card at 21:36Z the owner chose "Refuse, test in db" for append-only subjects. Other sources: the P4-02 review (the publication `SET` rules); ADR 0035 (publication pairing, `powersync_repl`); ADR 0048 (permissions); ADR 0054 (RLS, the migrator's guard); ADR 0055 (audit); ADR 0056 (outbox); ADR 0057 (error model, idempotency); ADR 0058 (DTOs, OpenAPI).

## Context

ROADMAP P4-09 asks for two things. The first is a reference module, `modules/_template`, with its controller, service, repository, schema, policies, events, `public-api.ts` and tests. The second is a `/new-module` command that copies it. The "Also" lines from P4-07, P4-08, P4-02 and P2-02 add requirements:

- the template shows `@Idempotent()`, `@ZodResponse` and `ApiError`;
- it catches SQLSTATE 23505 and raises an `ApiError`;
- the migration guard rejects `ALTER PUBLICATION … SET TABLE` and `SET (publish …)`;
- publishing a table is paired with `GRANT SELECT … TO powersync_repl`;
- ledger and audit tables revoke UPDATE and DELETE.

The owner added three more:

- an Also line on P5-01 (whether `/openapi.json` is exposed, per environment);
- an RLS-isolation test for the template's table;
- a test proving that a copied module passes `pnpm verify` and `pnpm gen:api` with no manual edits.

## Decision

### The template is reference code, never registered (decision 1)

`apps/api/src/modules/_template/` holds TemplateItems (`/v1/template-items`, table `bricx.template_items`).

- It is not imported by `AppModule` and ships no migration. `apps/api/tsconfig.build.json` excludes it from the build. Typecheck, lint and the unit tests still cover it.
- Its table schema, `template-items.schema.ts`, lives inside the module folder. drizzle-kit never reads it, because it is not exported from `tables.ts`.
- Its integration test makes the table with the same generator a copy's migration comes from. That is drizzle-kit `generate` over the schema file, then `enableTenantRls()` appended. The real migrator applies the result after the production journal.
- Its outbox topic `template_items.created` is registered in `@bricx/db/outbox` and is never written. It has no consumer, which amends ADR 0056's "a topic is added with its consumer" for template-made topics (for architect review).

### Stand-in subject `project.milestone` (decision 2)

`can()` is typed to catalogue subjects and `enableTenantRls()` reads `DEFAULT_MODEL`, so the template needs a real subject. It uses `project.milestone`: project-level, rows carry `created_by`, synced, with create and read actions.

### `pnpm new-module <module> <Entity> <subject>` (decision 3, owner condition 3)

`scripts/new-module.mjs` is deterministic and never prompts. Example: `pnpm new-module milestones Milestone project.milestone`. `.claude/commands/new-module.md` calls it.

**Before writing anything, it refuses:**

- a dirty working tree;
- a module name outside `^[a-z][a-z0-9-]*$`, which is one path segment (so `../x`, `a/b` and `.` all fail);
- a module name that ends in a hyphen or repeats one;
- a reserved module name (`template`, `common`, `modules`, `auth`, …) or one containing `template`;
- a module name already in use: the module folder, the test folder, the schema file or the table;
- an Entity that is not PascalCase (`^[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)*$`, at most 60 characters), contains `Template`, or equals the module's PascalCase name;
- a subject that is not in the catalogue;
- a subject that is not project-level, has no `created_by`, or lacks a create or read action;
- a subject that no default role bundle grants at `<subject>.create.project`, because the copied tests act as that role;
- a derived Postgres name over 63 bytes. It checks `<t>`, `_pkey`, `_select`, `_insert`, `_update`, `_name`, `_project`, `_name_length`, `_version` and the topic `<t>.created`.

`scripts/guard-fixtures/new-module/` proves each rule, with 30 cases run by `check:workspace`.

**Append-only subjects are refused** (owner decision card, 2026-10-17). The template is project-level with `created_by`. The only append-only subjects, `org.audit` and `finance.ledger`, are org-level without `created_by`, so no copy can be append-only today. The REVOKE guard is proven on the exact SQL a copy would get (below).

**The copy:**

- copies the source and test folders;
- drops `// new-module:template-only:start` … `end` blocks;
- enables `// new-module:copy-only: …` lines;
- renames `TemplateItems`, `templateItems`, `template_items`, `template-items`, `TEMPLATE_ITEMS`, `TemplateItem`, `templateItem`, `modules/_template` and the subject;
- refuses if any `template` survives;
- moves the schema file to `packages/db/src/schema/<module>.ts`.

**Registration at marker comments.** It inserts one line before each marker. A marker is a whole line, must appear exactly once, and the line must not already be present. Insertion is never a regex over code. The markers are:

- `tables.ts`: `export *`;
- `TENANT_TABLES` and its test;
- `OUTBOX_TOPICS` and its test;
- `AppModule`'s import and its module list.

These marker-insertion rules have 5 fixtures in `scripts/guard-fixtures/new-module-markers/`.

**Migration and client.** It runs `pnpm --filter @bricx/db generate --name <t>`, requires exactly one new migration, and appends `pnpm db:rls`'s SQL to it. It runs Prettier on what it wrote, then `pnpm gen:api`.

**What it prints.** It prints `review the generated migration (rule 12): <file>`. It never says the migration is reviewed.

**Failure and repeat runs.** A failure after writing restores the tree, which was clean at the start. A second run with the same name refuses and changes nothing.

### The selftest and the CI job (decision 4, owner condition 6)

`node scripts/new-module.mjs --selftest` runs in a temporary `git worktree` of HEAD:

1. `pnpm install --offline --frozen-lockfile`.
2. Three refused inputs, after which the tree is unchanged.
3. `pnpm new-module milestones Milestone project.milestone`, which must print the rule 12 line and must not claim a review. The copy is committed in the worktree.
4. A second run, which must be refused with nothing changed.
5. A run on a dirty tree, which must be refused.
6. `pnpm verify`.
7. `pnpm gen:api`, after which the tree must be unchanged.
8. The `@bricx/db` and `@bricx/api` integration suites (beyond the owner's ask).

CI job `new-module` runs it with no `if:` (ADR 0031). The shared setup step restores the pnpm store and installs, so the store is warm. The selftest's own install is offline, with no online fallback.

### Routes and layers (decisions 5 and 6, owner conditions 4 and 5)

**Routes:**

- `POST /` is `@Idempotent()` with `@ZodResponse({ status: 201, type: TemplateItem })`. The body is `{ id, projectId, name }`. The id is UUIDv7, made on the device (rule 6), and the name is 1–200 characters.
- `GET /:id` answers 404 `not_found` when RLS hides the row or the caller may not read it.
- `GET /?projectId&cursor&limit` is cursor-paged with `@bricx/validation`'s `CursorSchema`, `PageLimitSchema` and `pageOf`. The cursor is the last id in base64url; a cursor the module did not write is 422 `invalid_cursor`.

**Layers:**

- **DTOs** use `createZodDto`. Their messages are issue codes.
- **Policies** use `can()` and `accessibleQuery()` from `@bricx/permissions`. A refused create is `ApiError("forbidden")`, checked before any database work.
- **`abilityFor(identity)`** lives in one file, `apps/api/src/common/auth/ability.ts`. Its comment says P5 replaces it (for architect review). It applies the identity's known role names, exact case, through `grantsForRole()` over its project ids. An unknown or empty role grants nothing, as does a bundle whose targets the identity cannot carry (site roles). Non-UUIDv7 org or user ids are 403. Before P5 nothing sets an identity, so every request is 401 `session_expired`.
- **Repository:** every statement uses the `TxRunner` transaction. 23505 is caught only in `insert()` and becomes `ApiError("request.conflict")` (409) at once. No further statement runs in that transaction, so it rolls back with the idempotency claim. On a 409 there is no row, audit event, outbox row or idempotency key, and a retry with the same key and body runs again and is 409 again (tested).
- **Service:** the row, then `OutboxService.enqueue(tx, "<t>.created", { id, projectId })` (ids only), then `AuditService.record()` as the last statement (ADR 0055). The audit action is `<subject>.create` and the entity type is the subject.
- **Schema:** `id`, `org_id`, `project_id`, `name`, `created_by`, `created_at`, `updated_at`, `version`, a UNIQUE (org, project, name) index, a list index and CHECKs.
- **`@bricx/permissions`** becomes an `apps/api` workspace dependency.

### The migrator's catalog guard (owner conditions 1 and 2; amends ADR 0054)

`guardProblem()` runs inside each migration's transaction. It now also refuses two things.

**`append_only_writable`.** Every table on `APPEND_ONLY_TABLES` that exists must give `bricx_app` no UPDATE on any column (`has_any_column_privilege`), and no DELETE or TRUNCATE.

- `APPEND_ONLY_TABLES` lives in `rls-guard.ts`, which imports nothing, so the migrate entry point never loads `@bricx/permissions`. Today it holds `bricx.audit_events`.
- A unit test keeps it equal to the `TENANT_TABLES` and `SYSTEM_TENANT_TABLES` entries whose resource is append-only. The system resources are not catalogue subjects.
- The integration test runs `enableTenantRls()` for `finance.ledger`, the SQL a copy would get. It passes with its REVOKE and is refused without it.

**`publication_without_grant`.** Every row of `pg_publication_tables` for `powersync` must be readable by `powersync_repl`. The catalog is the authority: a later REVOKE is refused too.

### Publication text rules (P4-02 review, ADR 0035)

`migrationSqlProblems()` fails earlier, in `check:workspace`, with 14 new fixtures. It refuses these statements:

- `ALTER PUBLICATION … SET TABLE`;
- `ALTER PUBLICATION … SET (…)`;
- `ADD`/`SET`/`DROP TABLES IN SCHEMA`;
- `ALTER DEFAULT PRIVILEGES … powersync_repl`.

It also refuses these pairing gaps within one migration:

- an `ADD TABLE` without `GRANT SELECT ON <t> TO powersync_repl`;
- a `DROP TABLE` without the `REVOKE`.

Names are normalised (quotes, case, `ONLY`, column lists, `WHERE`). The existing `add-table-variants.json` fixture gained its GRANTs; its expectation stays empty.

### Sync (decision 7)

A copy never touches the publication. The P8-02 "Also" line covers sync wiring for template-made modules.

## Consequences

- A new module is one command plus a migration review.
- The copy is exactly what the template's tests proved, and CI proves a copy again on every PR.
- Registries that tests compare exactly now carry marker lines, so a copy adds its entry to both the registry and its test: `TENANT_TABLES`, `OUTBOX_TOPICS`.
- Changing the template means keeping its markers and template-only blocks intact. The selftest fails otherwise.
- Pre-P5 the copied routes answer 401. P5 replaces `abilityFor()` and the test identity guard.
- Append-only modules need a template of their own when the first one is needed.
