# 0069. Production audit ignores GHSA-gcqx-w48m-w2h4 (deepmerge), reached at runtime only through OpenAPI document building

- Status: Accepted
- Date: 2026-11-04
- Deciders: Mohamed Abass Jalloh
- Source: maintenance chore, no ROADMAP id (owner's request and plan approval with conditions C1–C3, 2026-11-04: decisions D1(a) and D2); ADR 0023 (dependency policy), ADR 0031 (CI `security` job), ADR 0037 (audit ignores), ADR 0058 (OpenAPI document, `nestjs-zod`)

## Ignored advisory

- Advisory: GHSA-gcqx-w48m-w2h4
- Package: `deepmerge`
- Revisit by: 2027-02-02

## Context

Since the advisory update of 2026-10-27, `pnpm audit:prod` has been red on `main` and on every PR. Verified on 2026-11-04 with `pnpm audit --prod --json` and the registry:

- **Advisory:** [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), "deepmerge mergeObject() allows prototype poisoning of returned objects". A source object passed to a merge can put attacker-chosen properties on the prototype of the returned object.
- **Severity:** low (CVSS 3.1 5.3, `AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:N`).
- **Weakness:** CWE-1321 (prototype pollution).
- **Vulnerable versions:** `>=4.2.0 <=4.3.1`.
- **No patched release exists:** the advisory lists "Patched versions: <0.0.0". We have 4.3.1, the latest release, and it is the only copy in the lockfile.
- **How we reach it:** one path, `apps__api > nestjs-zod > deepmerge`. `nestjs-zod` 5.5.0 is the latest release (ADR 0058). So `deepmerge` is in the production closure of `apps/api`, and ADR 0037's reachability rule rejects a plain ignore. This ADR adds the one exception that rule allows.

## Reachability

This section lists the facts the exception rests on, and the one runtime path it accepts. The guard accepts only the chains listed here, exactly as written. If a new chain appears, or a listed one disappears, `check:workspace` and `pnpm audit:prod` fail.

- Runtime path: `apps/api > nestjs-zod > deepmerge`

Checked against `nestjs-zod` 5.5.0 as installed. `apps/api` is `"type": "module"`, and `import.meta.resolve("nestjs-zod")` from `apps/api` resolves to `dist/index.mjs`, so the ESM build is the one that loads. The CommonJS line numbers are in brackets.

| # | Call site | Function | What it merges |
|---|---|---|---|
| 1 | `dist/index.mjs:255` [`index.cjs:253`] | `cleanupOpenApiDoc` | `deepmerge(doc.paths, {})`: the paths of the document that `SwaggerModule.createDocument` scanned |
| 2 | `dist/index.mjs:359` [`index.cjs:357`] | `cleanupSchema`, called only by `cleanupOpenApiDoc` | `deepmerge({}, schema)` for each `components.schemas` entry of that document |
| 3 | `dist/index.mjs:439` [`index.cjs:437`] | `fixParameter`, called only by `cleanupOpenApiDoc` | `deepmerge({}, parameter)` for each operation parameter of that document |
| 4 | `dist/dto-CHeB-l1i.mjs:95` [`dto-sWxCeI9D.cjs:118`] | `walkJsonSchema(…, { clone: true })` | a JSON Schema. Two functions call it. `cleanupRefs` runs from a DTO's static `_OPENAPI_METADATA_FACTORY()`, which `@nestjs/swagger` calls during `createDocument`. `convertToOpenApi3Point0` runs only for OpenAPI 3.0, and we pass `version: "3.1"`. |
| 5 | `dist/dto-CHeB-l1i.mjs:236` [`dto-sWxCeI9D.cjs:259`] | `zodV3ToOpenAPI`, ZodIntersection branch | two JSON Schemas built from a zod v3 schema. This runs only for a schema without `_zod` (zod v3), or when `zodV3ToOpenAPI` is called directly. The repository has no zod v3 import and no `zodV3ToOpenAPI` call. |

All five sites are reached only while the OpenAPI document is being built:

- `buildOpenApiDocument` (`apps/api/src/openapi/document.ts`) is the only caller of `SwaggerModule.createDocument` and `cleanupOpenApiDoc` (with `version: "3.1"`).
- It runs once at boot, before `app.init()` (`apps/api/src/app.ts`, where the result is stored in `OpenApiDocumentHolder`), and in `pnpm openapi:emit` at build time (`apps/api/src/openapi/emit.ts`). `GET /openapi.json` serves the stored text and builds nothing.
- Every merge input comes from our source code: controllers, route decorators and zod schemas. Request bodies, headers, query strings, database rows and environment values never reach it.

The parts of `nestjs-zod` that run per request call no `deepmerge`:

- `ZodSerializerInterceptor` (registered in `apps/api/src/common/db/database.module.ts`) calls only `schema.parse` or `schema.encode` (`dist/index.mjs`, `createZodSerializerInterceptor`).
- `createZodDto`'s `create()` calls `schema.parse`. `ZodResponse` applies decorators when a class is defined.
- `isZodDto` (`nestjs-zod/dto`, used by our pipe and `common/idempotency/wire.ts`) only checks a property.
- The global validation pipe is ours (`common/errors/zod.pipe.ts`, `parseAtBoundary`), not `nestjs-zod`'s.

**This exception ends** if any change makes the document be built per request or from runtime data, lets a zod v3 schema reach a DTO, or adds another runtime path to `deepmerge`. In that case the ignore must be replaced by a fix. A new path makes the guard fail, so it cannot slip in unnoticed.

## Decision

- **Ignore exactly this advisory by id.** `pnpm-workspace.yaml` `auditConfig.ignoreGhsas` gets `GHSA-gcqx-w48m-w2h4` and nothing else. ADR 0037's rules apply unchanged: a well-formed id, an Accepted ADR with `- Advisory:`, `- Package:` and `- Revisit by:` lines, failure after the date with a warning in the last 30 days, no audit level, and ignores in one place only.
- **ADR 0037's reachability rule gains one exception.** The guard (`scripts/guards.mjs`, `auditIgnoreProblems`) accepts a chain from an `apps/` or `packages/` importer only when the Accepted ADR that records the ignore lists that exact chain as ``- Runtime path: `a > b > pkg` `` under a `## Reachability` heading. Everything else fails:
  - a chain the section does not list;
  - a section with no path line;
  - a listed chain that no longer exists (stale);
  - a chain `pnpm ls` printed as `deduped` and expanded nowhere.

  An ADR without the section keeps ADR 0037's rule exactly. Seven fixtures in `scripts/guard-fixtures/audit-ignores/` (`runtime-*.json`, `tooling-with-section.json`) prove this on every run, alongside the 24 existing ones, whose expectations are unchanged.
- **Loud on every audit run.** `pnpm audit:prod` prints ADR 0037's `IGNORING GHSA-gcqx-w48m-w2h4 (deepmerge) per docs/adr/0069-audit-ignore-deepmerge-runtime.md, revisit by 2027-02-02` line. For each accepted runtime path it then prints `audit:prod: GHSA-gcqx-w48m-w2h4 runtime path accepted per … "## Reachability": apps/api > nestjs-zod > deepmerge`.
- **Revisit by 2027-02-02** (90 days). Extending the date needs an amendment or a new ADR, as in ADR 0037.
- **Remove the ignore** when a patched `deepmerge` ships, or when a `nestjs-zod` release drops it or depends on a fixed version (Dependabot proposes the bump, ADR 0033).

## Alternatives rejected

- **Replacing `nestjs-zod`:** it carries the DTOs, `ZodResponse`, the serializer interceptor and the OpenAPI clean-up (ADR 0058). Replacing it means rewriting every module's DTOs and the document pipeline to remove a low-severity issue that request data cannot reach.
- **Patching `deepmerge` (`pnpm patch`, a fork, or an override to another package):** no fixed release exists. A local patch or fork is an unreviewed package, which ADR 0023 forbids, and it would need its own maintenance.
- **Dropping `--prod`:** this widens the audit to every dev dependency and does not remove this advisory.
- **Lowering the audit level (`--audit-level moderate` or higher):** this hides every future low advisory in every package to silence one. One reviewed id with an expiry is narrower.
- **Waiting for a patch:** `main` and every PR stay red with no end date, so the `security` check stops meaning anything.
- **Allowing any runtime reach once an ADR has a reachability section (plan option D1(b)):** this is smaller, but the ADR would not bind the paths it was reviewed for. Listing exact paths makes a new path fail.

## Consequences

Positive:
- `security` no longer fails on this advisory, and still fails on every other advisory.
- A runtime ignore now needs a written reachability analysis and an exact list of accepted paths. Any drift makes the guard fail.

Negative:
- A known low-severity prototype-poisoning flaw stays in the API process until a fix ships. It is reachable only from code-defined input at boot or build time. (architect-reviewed 2026-11-05)
- The call-site table is true for `nestjs-zod` 5.5.0 only. A `nestjs-zod` bump must re-check it. The guard checks paths, not call sites. (architect-reviewed 2026-11-05)
- Someone must act before 2027-02-02, or `pnpm verify` and CI fail on that date. The 30-day warning is the reminder.
