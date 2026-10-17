# 0058. OpenAPI document and the generated client: nestjs-zod DTOs, `/openapi.json`, `pnpm gen:api`

- Status: Accepted
- Date: 2026-10-17
- Deciders: Mohamed Abass Jalloh
- Source: P4-08 (task plan approved 2026-10-17 16:38Z: decisions 1–9 with conditions 1–4; the owner's decision card answers "keep `@nestjs/swagger`" (16:45Z) and "scoped override" for `js-yaml` (17:39Z)); the P4 phase plan (D9: TanStack Query hooks move to P7-01); ADR 0016 (nestjs-zod → OpenAPI → orval), ADR 0023 (dependency policy), ADR 0045 (`@bricx/money`), ADR 0047 (`@bricx/validation`, the error envelope), ADR 0051 (`apps/api`), ADR 0057 (error model and idempotency).

## Context

ROADMAP P4-08 asks for nestjs-zod DTOs, `/openapi.json`, `pnpm gen:api` running orval into `packages/api-client` (fetch client, bigint amounts as strings) and a CI check that fails when the generated client is stale. ADR 0016 chose the tools; P4-07 (ADR 0057) left a `BoundaryPipe(schema)` per parameter, no document, and an idempotency store that keeps `JSON.stringify(result)` of a handler's return value, which throws on a `bigint` (a `Money`) and would otherwise replay a different text than the serializer sent.

## Decision

### Packages (decision 1)

`apps/api`: `@nestjs/swagger` 11.4.7 (published 2026-08-17, MIT, sha512-QyDYnmfP4IRucgmtQxMqzgRBdWtjFoDp8eFvvgf92+3wdLCL+Q0xOFO1948j/ntW/Wi7qT2dyck6ka8ADzPWQQ==; 12.x peers Nest 12) and `nestjs-zod` 5.5.0 (published 2026-07-25, MIT, sha512-V0WMtmICygYE2RoMKk8ExEeoetkC7PoUmUlZNP4JNk1YgrnUnG1vgkRn2DBNqsDi+Obv3c9AOssmXe/k/AvBOg==; peers Nest ^10 || ^11, `@nestjs/swagger` ^11, zod ^4). `packages/api-client` (dev): `orval` 8.41.0 (published 2026-10-08, MIT, sha512-loWTsG9ISipOWoD7aztv9Xar420e6ykuv/5//zKm42230Mm+MIt+4qSjyByiaCGNu8J9aHFDpiNQx1hDa/2cpw==; 8.42 and 8.43 were under the 7-day rule at install). `@bricx/money` becomes an `apps/api` dependency (the Money DTO). `@tanstack/react-query` is not installed: the hooks are a second orval output at P7-01 (phase plan D9).

`@nestjs/swagger` pulls `swagger-ui-dist` 5.32.13 and `lodash`, both unused (no UI is served), and `swagger-ui-dist` depends on `@scarf/scarf` 1.4.0, whose `postinstall` reports installs to scarf.sh. pnpm 10 runs no dependency build script here (none is allow-listed in `onlyBuiltDependencies`, which this task does not add; the install log says `Ignored build scripts: @scarf/scarf@1.4.0`), and CI sets `SCARF_ANALYTICS=false` as well. The four packages with lifecycle scripts the install added (`@nestjs/mapped-types` and `@nestjs/swagger` `prepare`, `undici` `prepare` through orval, `@scarf/scarf` `postinstall`) never run under pnpm; `esbuild`'s entries in the lockfile are unchanged (owner condition 4). The owner chose to keep `@nestjs/swagger` over a hand-written document builder.

### Override: `js-yaml` 5.4.3 for `@nestjs/swagger` only (amends ADR 0038)

- Override: `@nestjs/swagger>js-yaml` 5.4.3
- Remove when: an `@nestjs/swagger` release the api can use (11.x for Nest 11, or 12.x once the api moves to Nest 12) depends on `js-yaml` 5.4.1 or later; drop this line, the `pnpm-workspace.yaml` key and the DEPENDENCIES.md row in that PR, and the audit proves no vulnerable copy is left.

`@nestjs/swagger` 11.4.7, the last 11.x release (12.x peers Nest 12), pins `js-yaml` **5.3.0** exactly. GHSA-r3ph-w7gj-g6xm (moderate: `maxTotalMergeKeys` does not limit CPU use for empty merge sources; vulnerable `>=5.0.0 <=5.4.0`, patched in 5.4.1) covers it, so `pnpm audit --prod` failed. The api never parses YAML (the library only calls `jsyaml.dump` in `SwaggerModule.setup()`, which the api does not call), but the package sits in the api's production closure, where ADR 0037 allows no ignore.

A global `js-yaml: 5.4.3` override (ADR 0038's only form) was tried and reverted: it also moved `orval`'s and `cosmiconfig`'s `js-yaml` ^4 to 5, and `js-yaml` 5 has no ESM default export, so `orval` crashed. The owner chose a scoped override (decision card, 2026-10-17 17:39Z):

- `pnpm-workspace.yaml` holds `"@nestjs/swagger>js-yaml": 5.4.3`. pnpm 10.34.6 applies it to `@nestjs/swagger`'s dependency only; the lockfile change is `js-yaml` 5.3.0 → 5.4.3 under `@nestjs/swagger` (orval and cosmiconfig keep 4.3.2).
- **ADR 0038 is amended:** an override key may be a plain package name or one `parent>name` selector of two plain names (no ranges, no deeper chains). A scoped override needs the same Accepted ADR `- Override:` and `- Remove when:` lines and a DEPENDENCIES.md row naming `name`; in `pnpm-lock.yaml` every snapshot of `parent` must depend on `name` at the pinned version (other copies of `name` may differ); it is stale when `parent` is gone or no longer depends on `name`; and `name` must not also have a global override. `check:workspace` enforces this with 9 new fixtures in `scripts/guard-fixtures/overrides/scoped-*.json`; `pnpm audit:prod` prints `OVERRIDE @nestjs/swagger>js-yaml 5.4.3 per docs/adr/0058-openapi-document-generated-client.md`.
- The existing `selector.json` fixture (`eslint-plugin-boundaries>handlebars`) still fails, now because no ADR records that key, instead of "only plain package names"; `scoped-deep-selector.json` and `scoped-range-parent.json` keep the "not allowed" message covered.
- 7-day rule: 5.4.3 was published 2026-10-05T22:13:55.389Z (12 days before install, 2026-10-17). Integrity `sha512-yzzNtgczwgoVHNigCyKTXcQJU4Y8t/ikU4UxXW0BvrLfHTGWZhsNcOT2s/a7vn81/4KqVnNmHjaUEPlvWnNwVw==` (registry `dist.integrity`, equal to the lockfile). Its only dependency is `argparse` ^2.0.1 (unchanged) and it has no install scripts (`prepack`/`postpublish` only).
- We run `js-yaml` 5.4.3 under a package that declares 5.3.0 exactly. The api does not call the one function that uses it. (for architect review)

### The document is built once, post-processed, and served at `GET /openapi.json` (decisions 2a and 3a)

`buildOpenApiDocument(app)` (`apps/api/src/openapi/document.ts`) = `SwaggerModule.createDocument` (OpenAPI 3.1.0, `extraModels: [Money, HealthReport]`, operation ids `<Controller>_<method>`) → `cleanupOpenApiDoc` (nestjs-zod) → this repository's post-processing:

- a `default` response, `application/problem+json` with `$ref` `ErrorEnvelope`, on every operation (ADR 0057), except operations marked `x-bricx-plain-errors` (`@PlainErrors()` on `HealthController`: terminus's body stays, ADR 0057), which get a plain `503` with the `HealthReport` instead;
- on operations marked `x-bricx-idempotent` (`@Idempotent()` now applies `ApiExtension` too), the required `Idempotency-Key` header parameter (`^[A-Za-z0-9._~-]{1,255}$`, ADR 0057) and the `Idempotent-Replayed` header (`"true"`) on every 2xx response;
- `components.schemas.ErrorEnvelope` from `z.toJSONSchema(ErrorEnvelopeSchema, { io: "output" })`: the schema's input side is `boundedObject`'s `z.unknown().pipe(...)`, which has no JSON schema, while its output side is the strict object with every error code enumerated;
- `Money.amount` gets `pattern: "^-?\d+$"` (owner condition 2): `MoneySchema`'s `AmountString` is a `z.string().check(...)`, which emits no pattern, and the codec's output side (`z.custom<Money>()`) is unrepresentable, so the component is the codec's input side (the wire form) with the pattern added. The pattern is a superset of `@bricx/money`'s parser (no leading zeros, no `-0`, signed 64-bit range), which every boundary still applies; it tells a client the field is never a JSON number. The request body and the response of a route typed with the DTO both `$ref` this one component (test `openapi.test.ts`);
- no `servers` (the client sets its base URL), no `$schema` keys, path and schema names sorted; everything else keeps declaration order, so two builds are byte-equal.

The vendor extensions stay in the published document. `createApp()` builds the document after `enableVersioning` and before `init`, and stores its text and a SHA-256 ETag in `OpenApiDocumentHolder`; `OpenApiController` (`@Controller({ path: "openapi.json", version: VERSION_NEUTRAL })`, excluded from the document) sends that text as `application/json` with `ETag` and `Cache-Control: public, max-age=300`. No Swagger UI. The route is unauthenticated: the document holds no secret and is committed to the public repository (for architect review at P5).

### DTOs, the validation pipe and the response serializer (decision 5a)

- `apps/api/src/common/dto/money.dto.ts`: `class Money extends createZodDto(MoneySchema, { codec: true })`. As a `@Body()` type it decodes the wire form to a `Money` (bigint minor units); as a `@ZodResponse()` type it encodes a `Money` back. The class is named `Money` so the component is `Money`.
- `apps/api/src/common/dto/health.dto.ts`: `HealthReport`, terminus's `HealthCheckResult` shape, used with `@ApiOkResponse({ type: HealthReport })` and `@HealthCheck({ swaggerDocumentation: false })` (terminus's own swagger decorators would document a different shape). The health body is terminus's, so the serializer is not applied there; `ZodResponse()` also types the handler's return and terminus's `HealthCheckResult` does not satisfy the DTO's input type under `exactOptionalPropertyTypes`.
- `ZodValidationPipe` (global `APP_PIPE`, `apps/api/src/common/errors/zod.pipe.ts`) parses a parameter whose metatype is a nestjs-zod DTO with `@bricx/validation`'s `parseAtBoundary()` and throws `ValidationError(envelope)` (422, ADR 0047 issue codes: `required`, `unknown_field` with an empty path, never a client value); a parameter without a DTO passes through. nestjs-zod's `createZodValidationPipe()` is not used: it calls `schema.parse()` with zod's default messages, which the envelope cannot map to issue codes. `BoundaryPipe` is deleted; its tests moved to a DTO route with the same assertions (owner condition 3).
- `ZodSerializerInterceptor` (nestjs-zod) is global, registered in `DatabaseModule` after `RequestContextInterceptor` and `IdempotencyInterceptor` so it is innermost. `@ZodResponse({ status, type })` on a route encodes a codec DTO (a `Money` to `{ amount, currency }`) or parses a plain one; a result the DTO rejects is `ZodSerializationException` → `ProblemFilter` answers 500 `generic` and logs the issue paths and codes (`serialization.issues`) or the thrown error's name, never the value. `ZodResponse()` also types the handler's return, so a wrong return type fails `tsc`.

### Idempotent routes store the wire form (owner condition 1)

`IdempotencyState.form = wireFormOf(handler)` (`apps/api/src/common/idempotency/wire.ts`) reads the handler's `ZOD_SERIALIZER_DTO_OPTIONS` metadata (the key nestjs-zod's serializer reads; pinned by `test/wire.test.ts`): a codec DTO gives `wire = z.encode`, `unwire = z.decode`; a plain DTO or schema `wire = parse`, `unwire = identity`; an array DTO applies to each element; no DTO is the identity. `TxRunner.run()` stores `JSON.stringify(state.form.wire(result))` and returns `result`; the serializer, innermost, encodes `result` to the same text, which the idempotency map replaces with the stored text; a replay returns `state.form.unwire(JSON.parse(stored))` to the handler's caller and the serializer encodes it again to the identical bytes. A handler without a DTO that returns a `bigint` throws at `JSON.stringify`: 500 `generic`, nothing stored, no key (tested). Interceptor order: `RequestContextInterceptor` → `IdempotencyInterceptor` → `ZodSerializerInterceptor` (amends ADR 0057).

### `openapi:emit`, `pnpm gen:api`, and the CI drift check (decisions 4 and 8)

`pnpm --filter @bricx/api openapi:emit` (`tsc -p tsconfig.build.json && node --import ./dist/register.js dist/openapi-emit.js`) creates the app with stub probes, a database that is never opened, a silent log stream and a fixed in-code environment (`EMIT_ENV`, every value a placeholder: `openapi-emit.invalid` hosts, `xx-openapi-emit-1` region), and writes `serializeOpenApiDocument(...)` (`JSON.stringify(doc, null, 2)` + newline) to `packages/api-client/openapi.json`. Tests: two emissions are byte-equal, no `EMIT_ENV` or `.env.example` value of 8+ characters is in the text, and the committed file equals the built document. Root `pnpm gen:api` = `openapi:emit` then `pnpm --filter @bricx/api-client gen` (orval). CI's `verify` job runs `pnpm gen:api && git diff --exit-code -- packages/api-client` after `pnpm verify` (no `if:`, ADR 0031). `openapi.json` and `src/generated/` are Prettier- and ESLint-ignored (the generators own their layout).

### `packages/api-client` (decision 7)

`orval.config.ts`: input `./openapi.json`, output `./src/generated/client.ts` (`client: "fetch"`, `mode: "single"`, `clean: true`), every operation through the mutator `customFetch` of `src/fetcher.ts`. The fetcher is client-safe (no Node API, no clock, no randomness; proved by `test/client-safe.test.ts` over `src/**`, generated code included): `configureApiClient({ baseUrl, fetch?, headers? })` once (the fetch implementation is injected: Expo, web and tests bring their own; the headers provider runs per request, under the call's own headers), `customFetch(url, init)` joins the base URL and the path, sends `accept: application/json` and `content-type: application/json` with a body, forwards an `Idempotency-Key`, and resolves orval's `{ data, status, headers }` with the parsed JSON as `data` (`undefined` for 204 or an empty body). A non-2xx answer throws `ApiProblem(status, envelope)`, the envelope re-parsed with `ErrorEnvelopeSchema` (ADR 0047) or `undefined` when the body is not a valid envelope (a proxy's page, a wrong key); the message is `api problem: <status> [<code>]`, nothing of the body. The error variants of a generated response type are therefore never resolved. Exports: `./fetcher` and `./generated/*`; dependencies `@bricx/validation` and `zod` only; the generated `Money.amount` is `string` (type test), `ErrorEnvelope.code` the registry union.

### `@bricx/money` and `decimal.js` under Node resolution (for architect review)

`apps/api` type-checks `@bricx/money`'s sources through the workspace link (`moduleResolution: nodenext`). `decimal.js` 10.6.0 ships one CommonJS-typed `decimal.d.ts` for its ESM and CJS builds, so `import Decimal from "decimal.js"` type-checks under `bundler` resolution (the package's own program) but not under `nodenext`, where the default import is typed as the whole module. `packages/money/src/decimal.ts` now imports the namespace and narrows `decimalModule.default` with `decimalConstructor()` (a type predicate: a function with `clone` and `isDecimal`; a `TypeError` otherwise), which is the constructor in every loader (`decimal.mjs` exports it as default; the UMD build sets `Decimal.default = Decimal` on itself, Metro's case: must confirm at P7). `fx.ts` and `allocate.ts` use the `D` instance type instead of a `Decimal` import. No behaviour changes (money's 271 tests, 100 % lines).

## Consequences

Positive:
- One document from the running metadata; `Money` is a string amount on the wire in the document, the client's types and the serializer alike; an idempotent replay is byte-equal by construction, bigint or not.
- The client cannot drift: a stale `packages/api-client` fails CI and an api unit test.
- `ZodResponse()` makes a wrong return type a compile error.

Negative / accepted:
- `swagger-ui-dist`, `lodash` and `@scarf/scarf` are in the closure unused (scripts never run; `SCARF_ANALYTICS=false` in CI).
- The document is rebuilt per process at boot (a few milliseconds) rather than read from the committed file, so a running API and its document cannot disagree.
- `ErrorEnvelope` and `Money` are built by hand in post-processing where zod's JSON schema cannot express them; a change to either schema must keep the document tests green.
- `/openapi.json` is public (architect review at P5).
- A scoped override must be kept in step with `@nestjs/swagger`'s dependency list; the guard fails when it goes stale.

## Alternatives rejected

- A hand-written document builder over `z.toJSONSchema` (no `@nestjs/swagger`): the owner chose the library (decision card, 2026-10-17 16:45Z).
- nestjs-zod's `createZodValidationPipe()`: zod's default issue messages cannot map to ADR 0047 codes; `parseAtBoundary()` already does.
- Requiring wire-shaped returns on `@Idempotent()` routes (owner condition 1, option b): the DTO already names the encoding, so the store reads it; a handler keeps returning domain values.
- Storing the handler's result and encoding on replay: the stored text is what the client received; encoding again could differ after a schema change.
- A `servers` entry in the document: the base URL is a deployment fact, configured in the client.
- `@tanstack/react-query` now: no consumer before P7-01 (phase plan D9).
- For `js-yaml`: a global override (breaks `orval`), a dated audit ignore amending ADR 0037, and dropping `@nestjs/swagger` (owner's card, 17:39Z).
