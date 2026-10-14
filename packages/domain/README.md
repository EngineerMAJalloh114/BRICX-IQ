# @bricx/domain

The BRICX IQ domain kernel (P3-06, ADR 0049): the injected `Clock`, the `Result` type, code-only domain errors, state machines defined as data and run by one pure function (mirrored by XState on the client), and units of measure with exact `bigint` quantities and CLDR region defaults. Runs on the API, the worker and devices: the source imports only its own files, its `data/`, `@bricx/money/rounding` and, type-only, `@bricx/i18n/keys`. No clock, no randomness, no Node API.

```ts
import { manualClock } from "@bricx/domain/clock";
import { defineMachine, transition, toXStateConfig } from "@bricx/domain/machine";
import { Rounding } from "@bricx/money/rounding";
import { convert, parseQuantity } from "@bricx/domain/units";
import { defaultUnit } from "@bricx/domain/regions";

const approval = defineMachine({
  id: "approval",
  initial: "draft",
  states: ["draft", "submitted", "approved"],
  events: ["submit", "approve"],
  final: ["approved"],
  transitions: [
    { from: "draft", event: "submit", to: "submitted" },
    { from: "submitted", event: "approve", to: "approved", guard: "other_actor" },
  ],
  guards: { other_actor: (ctx: { requester: string; actor: string }) => ctx.requester !== ctx.actor },
});
transition(approval, "submitted", "approve", { requester: "a", actor: "a" }); // { ok: false, error: MachineError guard_rejected }
toXStateConfig(approval); // plain XState v5 config data; xstate itself is not installed here

const q = parseQuantity("12.500", "m"); // { ok: true, value: Quantity }
if (q.ok) convert(q.value, "ft", { scale: 3, rounding: Rounding.HALF_EVEN }); // { quantity 41.010 ft, exact: false }
defaultUnit("SL", "length"); // { ok: true, value: "m" }
const clock = manualClock(1_700_000_000_000);
clock.advance(1000); // { ok: true, value: 1700000001000 }
```

## Rules

- **Pure and injected.** `Clock` is `{ now(): number }`, an integer epoch millisecond in `0..2^48-1` (the `@bricx/ids` range). `fixedClock` and `manualClock` are for tests and seeds; the apps supply the real one. ESLint bans `Date.now()`, `new Date()` and `Math.random` under `src/`.
- **Results, not throws, for run-time input.** `transition`, `parseQuantity`, `convert`, `unitSystemFor`, `defaultUnit`, `advance` and `set` return `Result<T, DomainError>`; the constructors (`defineMachine`, `quantity`, `fixedClock`, `manualClock`) throw on a programming error.
- **Machines are data.** States, events and transitions are closed lists; `defineMachine` rejects duplicate or malformed names (`^[a-z][a-z0-9_]*$`, ≤ 64 characters, never an `Object.prototype` name), undeclared or unused names, unreachable states, dead ends and exits from final states. Lookups are `Map`/`Set` only, so `__proto__` or `constructor` as a state or event is just `err`.
- **Quantities never touch floats.** A `Quantity` is `coefficient: bigint` × 10^−`scale` (scale 0–9, ≤ 12 integer digits), serialised as `{ "value": "12.500", "unit": "m" }`. Factors are exact decimal strings re-derived in `test/factors.test.ts`; `convert` multiplies by an exact rational and rounds once, with the caller's scale and `Rounding` (no default).
- **Region defaults are data.** `data/region-units.json` is generated from a SHA-256-pinned CLDR 48.2 `measurementData` snapshot (`pnpm --filter @bricx/domain gen:region-units`, `--check` for drift): US and LR use `us_customary`, everything else (the UK included) `metric`.
- **Bounds before parsing; errors carry codes only.** Limits are in `./limits`. User-facing codes map to `errors:domain.<code>`, developer errors to `errors:generic`; unit labels are `common:unit.<code>`.

## Entry points

`./clock`, `./result`, `./errors`, `./machine`, `./units`, `./regions`, `./limits`. No root barrel, no deep imports.

## Tests

`pnpm --filter @bricx/domain test` runs the clock, result and error tests, one test per definition error, legal/illegal/guarded transitions, prototype-name inputs, fast-check properties against a list-scan oracle, the unit factor re-derivation, the bigint rounding oracle for all 7 modes, parse edge cases, region data drift and country checks, bounds (work-done counting), a client-safe test (no `process`, no `crypto`), 15 behaviour mutants and 10 compiler sabotages. `tooling/xstate-mirror` runs the same machines through XState 5.33.2 and requires identical outcomes.
