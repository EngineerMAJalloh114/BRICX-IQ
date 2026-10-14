# 0049. `@bricx/domain`: Clock, Result, code-only errors, data-defined state machines with an XState mirror, exact units of measure

- Status: Accepted
- Date: 2026-10-14
- Deciders: Mohamed Abass Jalloh
- Source: P3-06 (plan approved 2026-10-14 20:26Z with architect rulings 1–6; D1–D5, D7–D9 and D11–D14 accepted as written, the 34 unit factors re-derived by hand by the architect); the P3 standing rules (2026-10-13); CLAUDE.md rules 1, 7, 8 and 9; ADR 0023 (dependency policy); ADR 0041 (ids), ADR 0045 (money), ADR 0046 (i18n), ADR 0047 (validation, generated reference data), ADR 0048 (permissions, dependency edges).

## Context

ROADMAP P3-06 asks for the domain kernel shared by the API, the worker and the client: a `Clock` interface (rule 7: domain code never reads the system clock), a `Result` type, domain error classes, a generic state-machine helper `defineMachine({ states, transitions, guards })` used by the server and mirrored by XState on the client, and units of measure (SI and imperial, a conversion table, a default per region). The owner added: the package stays pure (no Node, db or app import, no `Date.now()`, `new Date()` or `Math.random`); it reuses ids, money and i18n only through justified edges, and money and i18n stay unlinked; errors carry codes only and map to i18n keys added in en, fr and ar; quantities never pass through floats; conversion factors are exact data re-derived independently; region defaults are data, not branches; an illegal transition returns a `Result` and never throws; property tests with fast-check; the XState mirror is derived and checked without adding xstate to the package; bounds before parsing with work-done tests; a boundaries element with smoke fixtures and sabotage proofs; strict coverage.

Evidence (Node 24.22.0; raw output in the PR):

- `xstate` 5.33.2: published 2026-09-15T19:59:03.496Z (29 days before install, 7-day rule met), MIT, no dependencies, no install scripts, `sha512-8tC7yXgeCvpT8gKEeEje6ikJJG1wpnoLiXe+HfECW8m10ubMd3QxKOwWA8KxPJVBcLwfdRoMKYxIBGYKmo37/A==`. Installed only in `tooling/xstate-mirror` (dev), never in `packages/domain`.
- Unicode CLDR 48.2 (tag `release-48-2`, commit `11299982335beb974c1c63c45265184e759c0f41`), `common/supplemental/supplementalData.xml` (SHA-256 `cd2af39aef82fdbfba4d591c87548203350538ad2318486d104b3b38b8d62f1a`): its `<measurementData>` element lists the territories using the US and UK measurement systems; every other territory is metric. The element is committed as `packages/domain/data/source/measurement-data.xml` (SHA-256 `c8b155880840d5d2368da17ba645cb220dd7111e3ac7805b759eb6b5ee4a5308`) with the Unicode License V3 (`UNICODE-LICENSE.txt`, SHA-256 `b49d0e9f8ead51ca8b7df6fec89cc3ae6809198b4b9d43c74216da0118f23f5b`) and `source.json` naming commit, URL and hashes.
- `@bricx/money/rounding` already holds the 7-mode `Rounding` enum (ADR 0045), and money's `multiply` accepts a factor of up to 12 integer and 12 fraction digits.

## Decision

### Clock (ruling 5)

`./clock` exports `interface Clock { now(): number }`: an integer epoch millisecond from 0 to `MAX_CLOCK_MS` = 2^48 − 1, the same range as `@bricx/ids`'s `IdClock` (a type test proves a domain `Clock` is assignable to it; `@bricx/ids` is a devDependency for that one test and nothing else). `fixedClock(ms)` and `manualClock(ms)` throw `ClockError("invalid_clock")` for a non-integer, negative or over-range value. `manualClock` adds `advance(ms)` and `set(ms)`, which return `Result<number, ClockError>`: `advance` checks the delta and the sum, so the clock never wraps past the maximum (two permanent mutants: a constructor accepting a fraction and an `advance` that accepts a fraction and wraps). The package provides no system clock; the apps build one. ESLint bans `Date.now()`, zero-argument `new Date()` and `Math.random` under `packages/domain/src` (since P1-03, re-proved at the real path).

### Result

`./result`: `Result<T, E> = { ok: true; value: T } | { ok: false; error: E }`, frozen, with `ok`, `err`, `isOk`, `isErr`, `map`, `mapErr` and `andThen`. The shape matches ids' parse results on `ok` and `value`. A type test proves a `Result` cannot be read without narrowing (compiler sabotage: `error` made available on the `ok` arm).

### Domain errors and i18n keys

`./errors`: abstract `DomainError` (`code`, `key`, a fixed lowercase message per code, `toJSON` → `{ name, code, key }`, never an input value or a `cause`), with `MachineError` (22 codes), `QuantityError` (9 codes) and `ClockError` (`invalid_clock`). Each class has a closed code list and a union with a two-way compile-time agreement check (three compiler sabotages add a code to a union only). User-facing codes map to new keys in en, fr and ar: `errors:domain.illegal_transition`, `errors:domain.guard_rejected`, `errors:domain.invalid_quantity`, `errors:domain.quantity_precision`, `errors:domain.quantity_out_of_range`, `errors:domain.unknown_unit` and `errors:domain.incompatible_units`; developer errors (a bad definition, scale, rounding, clock value or oversized input) map to the existing `errors:generic`. Each unit has a label key `common:unit.<code>` (the symbol, `m²`, `US gal`). **The fr and ar text is machine-drafted** and needs native review before production or Tolgee import. Every key is checked at compile time against `@bricx/i18n/keys` (`MessageKey`) and at run time against the three catalogs; a fast-check test proves no input text reaches a message, JSON or stack prefix.

### State machines (D7–D9, ruling 3)

`./machine`: `defineMachine({ id, initial, states, events, final, transitions, guards })` takes plain data (states and events as string lists, transitions `{ from, event, to, guard? }`, guards as named pure predicates `(context) => boolean`) and returns a frozen `Machine` whose lookup tables live in a module-private `WeakMap`. A bad definition throws `MachineError` (a programming error, caught at module load and in tests): names must be 1–64 characters matching `^[a-z][a-z0-9_]*$` and not an `Object.prototype` property name; duplicates, an unknown initial state, undeclared states, events or guards, unused guards, two transitions on one `(state, event)`, unreachable states, non-final states with no way out and final states with outgoing transitions are rejected (D8); bounds (64 states, 64 events, 256 transitions, 32 guards) are checked before any element is read.

`transition(machine, state, event, context)` never throws and returns `Result<S, MachineError>` for every input: `illegal_transition` when no transition matches, `guard_rejected` when the guard returns anything but `true`, `guard_failed` when the guard throws (fail closed), `unknown_state` / `unknown_event` for a name the machine does not know, `invalid_input` for a foreign machine object or an oversized name. All lookups are `Map`/`Set` or `Object.hasOwn` (ruling 3): `__proto__`, `constructor`, `toString` and `hasOwnProperty` as state or event give `err`, never a prototype value and never a throw, names over 64 characters are rejected before any lookup, and a permanent mutant with a plain-object lookup is caught. `transitionInput` is the same function typed over `unknown` for wire input; `availableEvents` and `transitionTable` are read helpers. Property tests (fast-check): every result equals a naive list-scan oracle, a rejecting guard never lets a transition through, `transition` never throws on arbitrary input, every state of a generated valid definition is reachable.

### XState mirror (D10, ruling 2)

`toXStateConfig(machine)` returns plain XState v5 config data (`{ id, initial, states: { <state>: { type?: "final", on: { <event>: { target, guard? } } } } }`) with no xstate import. The private package `tooling/xstate-mirror` is the only place xstate is installed until P9-06: it builds `createMachine(config, { guards })` from the same guard functions and runs every step through both engines. Equivalence mapping (ruling 2b), tested on the two fixture machines (every state × event, and every context for the guarded one) and on fast-check random machines (300 random walks and 200 exhaustive state × event × guard-outcome sweeps): domain `ok(target)` ⇔ `snapshot.can(event)` is true and the next snapshot's value is `target`; domain `err("illegal_transition")` ⇔ `can` is false and the value is unchanged; domain `err("guard_rejected")` ⇔ `can` is false and the value is unchanged. A guard that throws is outside the mapping: domain fails closed with `guard_failed`, XState lets the exception propagate; the client must not pass a throwing guard. The mirror's `createMachine` result is also checked for the same state list, initial state and final states, and the config survives a JSON round trip (pure data). **Condition 2a:** `apps/client` will install `xstate` at exactly the version pinned in `tooling/xstate-mirror` (5.33.2 today); any other version requires amending this ADR in the same PR. A test in the mirror package fails if the installed xstate is not 5.33.2.

### Quantities and units (D1–D5, ruling 4)

`./units`: a `Quantity` is a frozen branded value `{ coefficient: bigint, scale: 0..9, unit }` meaning `coefficient × 10^−scale`, at most 12 integer digits, signed (returns and stock adjustments). No `number` reaches it: `quantity(coefficient: bigint, scale, unit)` and `parseQuantity(value: string, unit)` are the factories (compiler sabotages: `number` accepted for the coefficient or the string). The JSON form is `{ "value": "12.500", "unit": "m" }`, the value a plain decimal string (length ≤ 40 checked before the regex `^(-)?(0|[1-9][0-9]*)(?:\.([0-9]+))?$`; `-0` and `-0.000` are zero with no sign; `+5`, `.5`, `5.`, `05`, `1e3`, ` 5`, `5 ` and `""` are rejected; trailing zeros are kept, `12.500` has scale 3). 12 + 9 digits fit money's factor limit (12 + 12), so a quantity string feeds `@bricx/money` `multiply` without loss and maps to `NUMERIC(21,9)` later.

34 units in `src/units-data.ts`, every factor an exact terminating decimal string to the SI base of its dimension (length m, area m², volume m³, mass kg, count 1): mm, cm, m, km, in, ft, yd, mi; mm2, cm2, m2, ha, km2, in2, ft2, yd2, ac, mi2; cm3, l, m3, in3, ft3, yd3, us_gal, imp_gal; g, kg, t, oz, lb, short_ton, long_ton; ea. Definitions: SI prefixes; the international inch 0.0254 m and pound 0.45359237 kg (1959 agreement; NIST HB 44 App. C, SP 811 App. B); US gallon 231 in³; imperial gallon 4.54609 L (UK Weights and Measures Act 1985, Sch. 1); acre 43 560 ft²; short ton 2000 lb; long ton 2240 lb. `test/factors.test.ts` re-derives every factor from those definitions by a separate path with bigint rationals (ft = 12 in, yd = 3 ft, mi = 5280 ft, squares and cubes, gal = 231 in³, oz = lb / 16) and requires equality with the stored string; the architect re-derived all 34 by hand. Temperature (affine) and time (no fixed working day) are left out (D4); material-specific counts (bags, rolls) belong to P11-01.

`convert(q, toUnit, { scale, rounding })`: scale and rounding are both required (no default; the `Rounding` enum is `@bricx/money/rounding`, so quantities and money round the same way), the value is multiplied by `factor(from) / factor(to)` as an exact rational and rounded once in bigint, returning `{ quantity, exact }`; different dimensions give `incompatible_units`, more than 12 integer digits after rounding give `quantity_out_of_range` (the `999999999999.9` scale 0 HALF_UP case is tested). A definitional bigint oracle (floor/ceil bracketing per mode) and money's `multiply` check the rounding on fast-check inputs for all 7 modes. `compare` works across scales; `equals` ignores scale (ruling 4).

### Region defaults (D6 as amended by ruling 1)

`./regions`: `UNIT_SYSTEMS` as data, per slot (`length`, `area`, `volume`, `mass`, `liquid`): metric = m, m2, m3, kg, l; us_customary = ft, ft2, yd3, lb, us_gal. `REGION_UNIT_DEFAULTS` is read from `data/region-units.json`, generated by `scripts/gen-region-units.mjs` from the pinned CLDR snapshot above (`--check` fails on a stale file; a test regenerates it and requires a byte-identical file, as validation does). Mapping of CLDR measurement systems: `metric` → `metric`, `US` → `us_customary`, **`UK` → `metric`** (UK construction is metric; CLDR's UK system covers only GB and MM, and British imperial units are in the table for manual use). The territory list follows CLDR 48.2, no hand edits: the **us_customary set is `LR`, `US`**; everything else, US territories included, is metric. Tests: every listed country code exists in `packages/validation/data/countries.json` (a file read, no import edge); SL, GH, NG, KE, ZA, GB and FR are metric and US is us_customary; every slot names a unit of the right dimension; `unitSystemFor` checks length then `^[A-Z]{2}$` then `Object.hasOwn`, an unlisted valid code gives the world default; a source scan proves no country literal in `src/` (mutant: a code branch choosing the system). P6-03 region configs override per organisation or project.

### Bounds

`./limits`: 64 states, 64 events, 256 transitions, 32 guards, 64-character names, 40-character quantity strings, 16-character unit codes, 12 integer digits, scale 9, 2-character country codes. Every bound is checked before a regex, a loop or a lookup; tests count reads through proxies and counting arrays and assert work done, with no millisecond limits (two mutants: bounds checked after reading, parse regex before the length check).

### Dependency edges (D11)

- `@bricx/money/rounding` (value import): the `Rounding` enum and `isRounding`, used by `convert`. The only domain → money edge.
- `@bricx/i18n/keys` (type-only import of `MessageKey`): error and unit keys checked at compile time. A value import is a lint error (boundaries `dependency: { kind: "value" }`, smoke fixture) and a scan failure.
- `@bricx/ids` (devDependency, one type test): no edge from `src`.
- Nothing else: no validation, permissions, db, app, npm module or `node:` built-in. The boundaries element `domain` is anchored to `packages/domain/src/**` (`partialMatch: false`), with smoke fixtures for each edge and a real-path probe; money and i18n stay unlinked. `zod` is not used (D13): the package parses no wire format, its guards are bounded and hand-written.
- `fast-check` 4.10.2 (dev) for property tests; `xstate` 5.33.2 (dev) only in `tooling/xstate-mirror`.

### Coverage and client safety (D12)

`packages/domain` is in `STRICT_PATHS` (95% lines; vitest smoke fixture `strict-domain-below`). `src/` imports only its own files, its data, `@bricx/money/rounding` and type-only `@bricx/i18n/keys`; a test scans the sources and loads every module with `process` and `crypto` removed. Hermes: must confirm at P7.

### Casts and post-red edits (disclosed)

Three casts in `src/`: `as unknown as Quantity` (`units.ts`, the brand on the frozen object), `as unknown as Machine<S, E, G, C>` (`machine.ts`, the frozen handle) and `as Record<UnitCode, UnitKey>` (`units.ts`, the key map built from the unit list, checked by `UnitKeysExist`). In tests, `defineMachine as Define` and `transitionInput as Step` widen the generics for the mutant checks. After the red run the tests were changed only by Prettier formatting, lint fixes (`String()` in template literals, one `eslint-disable-line` next to an `@ts-expect-error`), two compiler-sabotage anchors made unique, and type fixes in `checks.ts` and `mutants.ts`; the diffs are in the PR.

## Deviations from the plan (for architect review)

1. `src/regions-data.ts` became `data/region-units.json` plus a committed generator and a pinned CLDR snapshot (ruling 1).
2. `advance` and `set` on `manualClock` return `Result<number, ClockError>` instead of throwing; the constructors throw as the ruling says.
3. Exports beyond the plan's list: `equals` (ruling 4), `transitionInput`, `defineMachineWith` and the definition checks (so the mutants can drop one check), `isUnitSystemName`, `parseUnitSystemName`, `isUnitCode`, `dimensionOf`, `isQuantity`, `isClockInstant`, `MAX_CLOCK_MS`, `UNIT_KEYS`, `UNIT_SLOTS`, `UNIT_SYSTEM_NAMES`.
4. Error codes differ from the plan's sketch: the lists are in `src/errors.ts` (22 machine, 9 quantity, 1 clock codes); a broken data file gives `QuantityError("invalid_slot")`.
5. A guard that throws is handled differently by the two engines (domain `guard_failed`, XState propagates); the mapping excludes it.

## Consequences

- Positive: one `Clock` and one `Result` shape for every package above; machines defined once as data and run identically on the server and, through the proven config, in XState on the client; exact quantities that feed money without loss; region defaults traceable to a pinned CLDR release.
- Negative (for architect review): the client's xstate version is bound to 5.33.2 until this ADR is amended; UK users get metric defaults and pick imperial units by hand; 34 units and two systems only until P11 materials add their own; seven fr and ar strings and 34 unit symbols await native review; Hermes behaviour unverified.

## Follow-ups

- **P6-03:** per-organisation and per-project unit-system override on top of `REGION_UNIT_DEFAULTS`.
- **P7-01 / P9-06:** `apps/client` installs `xstate` 5.33.2 (or this ADR is amended); the client builds its machines from `toXStateConfig` and the same guards, never from a hand-written config; Hermes: must confirm at P7.
- **P10 / P11:** time units and labour days; material-specific count units; temperature if ever needed (affine pair, new ADR).
- **Before production:** native review of the fr and ar `errors:domain.*` and `common:unit.*` text.
