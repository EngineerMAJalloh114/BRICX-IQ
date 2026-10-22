# @bricx/permissions

The single source of BRICX IQ authorization (P3-05, ADR 0048): the permission catalogue as data, the 12 default role bundles, CASL abilities behind a fail-closed check, the segregation-of-duties (SoD) rules, and generators for the RLS and PowerSync layers (CLAUDE.md rule 11). Runs on the API, the worker and devices: the source imports only its own files, `@bricx/ids`, `@casl/ability` 7.0.1 and, type-only, `@bricx/i18n`.

```ts
import { buildAbility, can, accessibleQuery } from "@bricx/permissions/ability";
import { grantsForRole } from "@bricx/permissions/roles";
import { checkSod } from "@bricx/permissions/sod";

const ability = buildAbility(
  grantsForRole("project_manager", { projectIds: [projectId] }),
  { orgId, userId },
);
can(ability, "approve", "finance.payment", { orgId, projectId, createdBy }); // false: not in the bundle
accessibleQuery(ability, "read", "field.photo"); // { kind: "any_of", filters: [{ orgId, projectIds: [projectId] }] }
checkSod({
  chainId,
  recordType: "finance.payment",
  recordId,
  action: "approve",
  actorId: userId,
  history,
});
```

## Rules

- **Deny by default, closed lists.** 28 resources, 83 permissions, 192 entries `module.resource.action.scope` (scope `own | site | project | org`). No wildcard: CASL's `manage`/`all` are disabled, so `org.role.manage` is a literal action.
- **Check records, never types.** The raw CASL ability is never exported. `can` needs a record with the fields its resource carries (`orgId`; `projectId` for project rows; `projectId` and `siteId` for site rows; `createdBy` where rows carry it), each a lowercase UUIDv7, or it throws `invalid_record`.
- **SoD is server-side, per record chain, with no override.** `checkSod` refuses an actor who took the other side of a pair on the same chain (`chainId` = the originating record).
- **Bounds before parsing; errors carry codes only.** Limits are in `./limits`. Every error code maps to `errors:forbidden`; an SoD violation to `errors:permission.sod_violation`.
- **Project overrides are set algebra (P5-05, ADR 0066).** A project membership grants `effectiveKeys(bundle, { add, remove })` = (bundle ∪ add) − remove; `validateOverrides` refuses an add outside project or own scope or already in the bundle, a remove outside the bundle, a key in both, more than 50 keys per list, and any override of the owner bundle. `requiresMfa(keys)` is true for any `finance.*` key.
- **Generated files are output only.** `generated/` holds `catalogue.json` (the snapshot), `roles.json`, `sod.json`, `rls.sql` (tenant + project isolation only, no table names), `sync-streams.yaml` (placeholders for P8-02, no finance resource) and `role-matrix.md`. Regenerate with `pnpm --filter @bricx/permissions gen`; `node scripts/gen.mjs --check` and the drift test fail on a stale file.

## Entry points

`./catalogue`, `./scopes`, `./roles`, `./ability` (P5-05 adds `canPermission`: `can` for a permission name read at run time, such as a role's stored key), `./sod`, `./errors`, `./limits`, `./generate`, `./overrides` (P5-05: `effectiveKeys`, `validateOverrides`, `knownKeys`), `./mfa` (P5-05: `requiresMfa`). No root barrel, no deep imports.

## Tests

`pnpm --filter @bricx/permissions test` runs the catalogue snapshot, every role × 10 sample actions against a hand-written table, the exhaustive SoD table, a property test of CASL against a hand-written grant evaluator, the drift and per-layer mutation tests, bounds and no-input-in-errors tests, a client-safe test (no `process`, no `crypto`), 16 behaviour mutants and 8 compiler sabotages.
