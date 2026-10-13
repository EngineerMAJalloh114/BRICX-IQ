# 0041. `@bricx/ids`: UUIDv7 written in-house, injected clock, strict parsing

- Status: Accepted
- Date: 2026-10-13
- Deciders: Mohamed Abass Jalloh
- Source: P3-01 (plan approved 2026-10-13 02:42Z: D1 B and D2–D10, D12, D14 as recommended; D11 changed to 95% coverage; added the lexicographic-order and timestamp-bit tests, the lowercase-at-the-boundary rule and the clean-volume `dev:up` run); the P3-01 ruling and the P3 standing rules (2026-10-13 02:30Z); ADR 0015 (UUIDv7, PostgreSQL 18 `uuidv7()`); ADR 0023 (dependency policy); ADR 0040 (P6-05b uses `@bricx/ids`). Numbered 0041 because 0040 is the seed re-home.

## Context

STACK.md rule 5 and CLAUDE.md rule 6: ids are UUIDv7, and syncable ids are made on the device. The ROADMAP P3-01 step said "UUIDv7 generator (`uuid` v7) with monotonic ordering per process", and DEPENDENCIES.md listed `uuid` (v11+) for `packages/ids`. The P3-01 ruling asked for a decision between the `uuid` package and a direct RFC 9562 implementation, with evidence on weight, the 7-day rule and monotonicity, and set binding requirements: the clock is a parameter `{ now(): number }` with no import from `@bricx/domain`; ids are strictly increasing across same-millisecond calls and a clock that goes backwards; branded `OrgId`, `UserId`, `ProjectId`, `SiteId`; parse rejects non-v7, a wrong variant and uppercase; a 1M-id test reports elapsed time.

Evidence on `uuid` (npm registry, 2026-10-13T02:35Z):

- `latest` is 14.0.3, published 2026-10-10T00:30:19.423Z: 3 days old, so it fails the 7-day rule until 2026-10-17. The newest version old enough is 14.0.2, published 2026-08-18T18:21:56.060Z, integrity `sha512-xZe/16rV4aa+HGSOCiY2YeLT1OybRLrrkL/Rqaq7p7GMVXjFh+6wN4oMYgjFmnSnhY8t6Xpdl2l9qmnHYuMHwQ==`.
- Weight: 65,685 bytes unpacked in 70 files, no dependencies, no install script (`prepare` only, which does not run on a registry install).
- Monotonicity: `v7()` keeps its same-millisecond counter only when called with no options, and then reads `Date.now()` itself, which the ruling forbids. Passing our own time (`msecs`, `seq`) turns the counter off, and its state helper (`updateV7State`) is not exported. With an injected clock, the counter logic would be ours anyway, and `uuid` would only pack bytes.
- Client safety: the Node entry (`dist-node`) re-exports md5 and sha1, which import `node:crypto` when the module loads.
- Parsing: its validation regex is case-insensitive, so the strict lowercase parser would be ours too.

## Decision

### No dependency: RFC 9562 version 7 in `packages/ids` (D1 B)

- `packages/ids` has no runtime dependency. DEPENDENCIES.md no longer lists `uuid`; the ROADMAP P3-01 entry records the change.
- **Layout (RFC 9562 §5.7):** 48-bit `unix_ts_ms` equal to the injected clock bit for bit; version `0111`; 12-bit `rand_a` = counter bits 41..30; variant `10`; 62-bit `rand_b` = counter bits 29..0, then 32 fresh random bits.
- **Counter (D2; RFC 9562 §6.2 method 1, a fixed-length dedicated counter):** 42 bits. Each new millisecond seeds it with 41 random bits, top bit clear, which leaves at least 2^41 ids per millisecond before overflow. Within the same millisecond it increments. On overflow the timestamp moves forward 1 ms and the counter is reseeded, as §6.2 allows. Past the largest 48-bit timestamp the generator throws `timestamp_overflow`.
- **Clock (ruling, D3, D4):** `createUuidV7Generator({ clock, fillRandom? })`, where `clock` is `{ now(): number }` and ids imports nothing from `@bricx/domain`. A clock value equal to or earlier than the last one keeps the last millisecond and increments the counter, so ids stay strictly increasing and nothing throws; the timestamp catches up when the clock passes it. A clock value that is not an integer from 0 to 2^48 − 1 throws `invalid_clock`.
- **Randomness (D5):** `fillRandom(bytes)` fills 10 bytes per id. The default reads `globalThis.crypto.getRandomValues` when an id is made, never when the module loads; if it is missing, `next()` throws `no_crypto`. No `Math.random`.
- **Ordering:** a generator's ids are strictly increasing as bytes and as lowercase strings, so string order equals generation order, also across millisecond boundaries. Ordering is per generator; ids from two devices interleave by timestamp only.

### Parsing and branded types (D7)

- `parseUuidV7(input: unknown)` returns a `UuidV7` or throws `IdError`. Accepted: the canonical 8-4-4-4-12 form, lowercase hex, version `7`, variant `8`, `9`, `a` or `b`. Rejected, each with its own code: not a string (`not_a_string`), any other form (`bad_format`), uppercase hex (`uppercase`), any other version, nil and max included (`not_v7`), any other variant (`bad_variant`).
- **Parse is strict lowercase by design. API boundaries must lowercase untrusted input before calling parse** (for architect review). PostgreSQL's `uuid` text output is lowercase, so ids read back from the database parse unchanged.
- `safeParseUuidV7` returns `{ ok: true, value } | { ok: false, code }`, and `isUuidV7` is a type guard. The result type is local, because `@bricx/domain` depends on `@bricx/ids` and its `Result` (P3-06) cannot be imported here.
- `Brand<T, Name>` intersects, so each of `OrgId`, `UserId`, `ProjectId` and `SiteId` is a `UuidV7` and a `string`, but none is assignable to another, and neither a plain string nor a plain `UuidV7` is assignable to any of them (type tests). Each has `parseX`, `safeParseX`, `isX` and `toX(id: UuidV7)`. The ROADMAP names `ProjectId` only; the P3-01 ruling adds the other three.
- **Errors (P3 rule 9):** `IdError` holds `code` and a fixed message chosen by the code, and has no `cause`. Sentinel tests check that no input and no clock value appears in `message`, `stack`, `String()`, `JSON.stringify` (also with every own property name), `util.inspect` (default, `showHidden`, `customInspect: false`) or `%s %o %O %j`.

### Exports and placement (D6)

- Two subpaths, `@bricx/ids/uuid-v7` and `@bricx/ids/branded`, with no root entry (P3 rule 5). Deep imports are impossible through the exports map.
- `src/` imports only its own files, uses no Node API and no `process` (tested by a static scan and by importing with `globalThis.crypto` removed).

### Lint (D8, D9, D10)

- `bricx/domain-clock` now also covers `packages/ids/src`, and bans `Math.random` in domain and ids source next to `Date.now()` and `new Date()`. Tests in `packages/ids/test` are exempt (they pass a real clock to the 1M-id run).
- New boundaries element `ids` (`packages/ids/src`) and policy: ids source imports no workspace package, no npm module and no Node built-in. It is the bottom of the dependency graph (ids ← money ← validation). The money and validation edges are added by P3-02 and P3-04.
- `tooling/eslint-smoke`: 9 new fixtures (ids → money, ids → db, ids → npm, ids → `node:crypto`, `Date.now()`, `new Date()`, `Math.random()` in ids; `Math.random()` in domain; ids tests allowed) plus the ids allowed control. The every-package fixtures moved from `packages/ids` to `packages/db`, which has no extra rule.
- **Real workspace proof (owed since P1-03):** `check-real.mjs` lints probe text with the root `eslint.config.mjs` at the real `packages/ids/src/uuid-v7.ts` path. It must report exactly the built-in, npm and workspace-package imports (`../../config/src/api.js`, the real package on disk), `Date.now()` and `Math.random()`, and nothing at `packages/ids/test/generator.test.ts`. The proof through pnpm workspace links comes with P3-02, the first package that depends on `@bricx/ids`.

### Coverage (D11, changed by the architect)

- `packages/ids` joins `STRICT_PATHS` in `@bricx/vitest-config`: 95% lines. `tooling/vitest-smoke` gains `strict-ids-below` (ids at 80% fails on the 95% rule, not the global 70%). The two "loose" fixtures, which used `packages/ids` as the example of a non-strict path, now use `packages/i18n`. The ROADMAP P1-04 entry records the new strict path.

### Tests (P3 rules 1–3, ruling, architect additions)

- Tests were written first and failed against stubs (269 of 293).
- The 1M-id run is repeated with three clocks: frozen (every id in one millisecond, also counted with a `Set`), stepping with a 5 ms jump back every 50,000 calls, and the real clock passed in by the test. Each checks strict increase; the last two also check that sorting the strings leaves generation order unchanged. Elapsed time is a test annotation (shown by `--reporter=verbose`), with no time limit.
- The 48-bit field equals the clock value bit for bit for 210 values, including 0, 2^32, the RFC 9562 example time and 2^48 − 1, and for every id of a running generator.
- Millisecond boundary: the largest possible seed in one millisecond followed by the smallest in the next still sorts in generation order.
- Permanent sabotage tests: the property checks pass on the real code and fail on each of 8 broken variants (a counter that never increments, a generator that follows a backwards clock, a truncated timestamp, variant 11, version 4, a parser that accepts uppercase, one that accepts any version, one that echoes its input).

## Alternatives rejected

- **`uuid` 14.0.2 (D1 A):** with the clock injected it would only pack bytes, its own monotonic path reads the real clock, its Node entry loads `node:crypto`, and its validation accepts uppercase. A dependency with an ADR, a DEPENDENCIES row and Dependabot bumps for about 40 lines of byte packing is not worth it.
- **`uuid` 14.0.3 (`latest`):** under 7 days old.
- **uuid's 32-bit sequence:** fewer ids per millisecond before the timestamp has to move; nothing in the layout needs it.
- **RFC 9562 §6.2 method 3 (sub-millisecond clock bits in `rand_a`, as PostgreSQL 18 does):** the injected clock has millisecond resolution only.
- **Throwing when the clock goes backwards:** a device clock corrected by NTP would stop id creation offline.
- **Case-insensitive parsing:** two spellings of one id would compare unequal as strings and as map keys.
- **A root entry:** P3 rule 5.

## Consequences

Positive:
- No dependency, no install script and no Node import: the same code runs on the API, the worker and devices.
- Seeds and tests get reproducible ids from a fixed clock and a seeded `fillRandom` (P6-05b).

Negative:
- Untrusted input must be lowercased at API boundaries before parsing; forgetting it gives an `uppercase` error, not a silent mismatch. (for architect review)
- If the clock jumps far ahead and then back, ids keep the future timestamp until real time passes it. Their order stays correct, but the timestamp no longer says when the id was made. (for architect review)
- Ordering is guaranteed per generator only. Each app instance should share one generator. (for architect review)
- Hermes (React Native) has no `crypto.getRandomValues`. The client must provide it before the first id is made; ROADMAP P7-01 now says so (`expo-crypto` is listed). Until then, `next()` on a device throws `no_crypto` rather than using weak randomness. (for architect review)
- The ROADMAP P3-01 step and DEPENDENCIES.md named `uuid`; both are amended here. (for architect review)
- About 300,000 ids per second on the agent container (Node 24.21.0), a few times slower than a byte-buffer implementation would be; ids are made one at a time per user action, so this is not tuned. (for architect review)
- ADR 0032's Semgrep trigger ("the first P3 package with `src/`") is reached by this package. Semgrep is not adopted in this PR, because the plan did not include it; the decision is put to the architect in the P3-01 PR. (for architect review)
