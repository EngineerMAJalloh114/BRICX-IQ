# @bricx/ids

UUIDv7 ids (RFC 9562) with no dependency, and branded id types (P3-01, ADR 0041). Runs on the API, the worker and devices: the source imports nothing outside its own files.

```ts
import { createUuidV7Generator, parseUuidV7 } from "@bricx/ids/uuid-v7";
import { parseProjectId, toOrgId, type OrgId } from "@bricx/ids/branded";

// One generator per app instance. Time comes in as a parameter.
const ids = createUuidV7Generator({ clock }); // clock: { now(): number }, e.g. the domain Clock
const orgId: OrgId = toOrgId(ids.next());

// At an API boundary: lowercase untrusted input first, then parse.
const projectId = parseProjectId(String(body.projectId).toLowerCase());
```

- **Strictly increasing** per generator: within one millisecond (42-bit counter) and when the clock goes backwards (the last millisecond is kept). String order equals generation order.
- **Clock:** `now()` must return whole milliseconds from 0 to 2^48 − 1, else `IdError` `invalid_clock`. The 48-bit timestamp field is that value, bit for bit.
- **Randomness:** `globalThis.crypto.getRandomValues`, read when an id is made. Pass `fillRandom` to replace it (seeded tests and seeds). On React Native, provide `crypto.getRandomValues` first (P7-01), or `next()` throws `no_crypto`.
- **Parsing is strict:** lowercase canonical form, version 7, variant 10. Codes: `not_a_string`, `bad_format`, `uppercase`, `not_v7`, `bad_variant`. Errors never contain the input.
- **Brands:** `OrgId`, `UserId`, `ProjectId`, `SiteId`, each with `parseX`, `safeParseX`, `isX` and `toX`. No brand is assignable to another.

## Tests

```bash
pnpm --filter @bricx/ids test                                                  # 95% line coverage required
pnpm --filter @bricx/ids exec vitest run test/million.test.ts --reporter=verbose   # 1M ids, elapsed time
pnpm --filter @bricx/ids exec vitest run test/sabotage.test.ts --reporter=verbose  # broken variants must fail
```
