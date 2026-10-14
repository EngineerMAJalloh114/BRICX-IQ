// Deliberately broken variants (P3 rule 1, permanent sabotage). Each one
// is a plausible mistake a future edit could make; sabotage.test.ts proves
// a named check in checks.ts catches it. The real code never imports this
// file.
import { Rounding } from "@bricx/money/rounding";
import { fixedClock, manualClock } from "../src/clock.ts";
import type { Clock, ManualClock } from "../src/clock.ts";
import { pow10, roundDiv } from "../src/decimal.ts";
import { MachineError } from "../src/errors.ts";
import {
  DEFINITION_CHECKS,
  checkDeadEnds,
  checkReachable,
  defineMachine,
  defineMachineWith,
  toXStateConfig,
  transitionInput,
} from "../src/machine.ts";
import type { XStateMachineConfig } from "../src/machine.ts";
import { err, ok } from "../src/result.ts";
import { UNITS, convert, parseQuantity, quantity } from "../src/units.ts";
import type { Quantity } from "../src/units.ts";
import type {
  AnyMachine,
  Convert,
  Define,
  Parse,
  Step,
  ToConfig,
} from "./checks.ts";

const defineAny = defineMachine as Define;

// 1. Guards ignored: the first matching transition fires whatever the guard says.
export const stepIgnoringGuards: Step = (machine, state, event) => {
  const t = machine.transitions.find(
    (x) => x.from === state && x.event === event,
  );
  return t === undefined
    ? err(new MachineError("illegal_transition"))
    : ok(t.to);
};

// 15 (ruling 3). A plain-object table instead of Maps: "constructor" and
// "toString" find Object.prototype members.
export const stepObjectLookup: Step = (machine, state, event, context) => {
  const table: Record<
    string,
    Record<string, { to: string; guard?: string }>
  > = {};
  for (const s of machine.states) table[s] = {};
  for (const t of machine.transitions) {
    const row = table[t.from] ?? {};
    row[t.event] =
      t.guard === undefined ? { to: t.to } : { to: t.to, guard: t.guard };
    table[t.from] = row;
  }
  if (typeof state !== "string" || typeof event !== "string")
    return err(new MachineError("invalid_input"));
  const row = table[state];
  if (row === undefined) return err(new MachineError("unknown_state"));
  const t: unknown = row[event];
  if (t === undefined) return err(new MachineError("illegal_transition"));
  const target = (t as { to?: unknown }).to;
  const guardName = (t as { guard?: unknown }).guard;
  if (typeof guardName === "string") {
    const guards: Record<string, ((context: unknown) => boolean) | undefined> =
      machine.guards;
    const guard = guards[guardName];
    if (guard === undefined || !guard(context))
      return err(new MachineError("guard_rejected"));
  }
  return ok(typeof target === "string" ? target : "");
};

// 2. Undeclared targets are declared on the fly instead of rejected.
export const defineAutoDeclaringTargets: Define = (definition) => {
  const def = definition as { states: string[]; transitions: { to: string }[] };
  const states = [
    ...new Set([...def.states, ...def.transitions.map((t) => t.to)]),
  ];
  return defineAny({
    ...def,
    states,
    final: [
      ...(definition as { final: string[] }).final,
      ...states.filter((s) => !def.states.includes(s)),
    ],
  });
};

// 3. The reachability check removed.
export const defineWithoutReachability: Define = defineMachineWith(
  DEFINITION_CHECKS.filter((c) => c !== checkReachable),
) as Define;

// 5. The dead-end check removed.
export const defineWithoutDeadEnds: Define = defineMachineWith(
  DEFINITION_CHECKS.filter((c) => c !== checkDeadEnds),
) as Define;

// 4. Elements read before the length bound.
export const defineReadsFirst: Define = (definition) => {
  const def = definition as { states?: unknown };
  if (Array.isArray(def.states)) Array.from(def.states as unknown[]);
  return defineAny(definition);
};

// 6. Conversion always truncates.
export const convertTruncating: Convert = (value, unit, options) =>
  convert(value, unit, { ...options, rounding: Rounding.DOWN });

// 7. Conversion with the factor ratio inverted (to / from).
const factorOf = (code: string): { n: bigint; d: bigint } => {
  const unit = UNITS.find((u) => u.code === code);
  if (unit === undefined) throw new Error("mutant: unknown unit");
  const [i = "0", f = ""] = unit.factor.split(".");
  return { n: BigInt(i + f), d: pow10(f.length) };
};
export const convertInverted: Convert = (value: Quantity, unit, options) => {
  const from = factorOf(value.unit);
  const to = factorOf(unit);
  const numerator = value.coefficient * to.n * from.d * pow10(options.scale);
  const denominator = to.d * from.n * pow10(value.scale);
  const rounded = roundDiv(numerator, denominator, options.rounding);
  const built = quantity(rounded, options.scale, unit);
  return built.ok ? ok({ quantity: built.value }) : built;
};

// 8. Exponent notation accepted.
export const parseAcceptingExponent: Parse = (value, unit) => {
  const m = /^(-?\d+)[eE](\d+)$/.exec(value);
  if (m !== null)
    return parseQuantity(`${m[1] ?? ""}${"0".repeat(Number(m[2]))}`, unit);
  return parseQuantity(value, unit);
};

// 9. The regex runs before the length bound.
const DECIMAL = /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;
export const parseRegexFirst: Parse = (value, unit) => {
  DECIMAL.exec(value);
  return parseQuantity(value, unit);
};

// 10. The input echoed in the error.
export const stepEchoingInput: Step = (machine, state, event, context) => {
  const result = transitionInput(machine, state, event, context);
  if (result.ok) return result;
  const echo = new MachineError(result.error.code);
  echo.message = `${echo.message}: ${String(state)} ${String(event)}`;
  return err(echo);
};

// 11. Region defaults chosen by a code branch (as source text).
export const regionsBranchingSource = `export function unitSystemFor(country: string) {
  if (country === "US" || country === "LR") return ok("us_customary");
  return ok("metric");
}
`;

// 12. toXStateConfig drops the guards.
export const toXStateConfigDroppingGuards: ToConfig = (
  machine: AnyMachine,
): XStateMachineConfig => {
  const config = toXStateConfig(machine);
  const states: Record<
    string,
    { type?: "final"; on?: Record<string, { target: string }> }
  > = {};
  for (const [name, state] of Object.entries(config.states)) {
    states[name] =
      state.on === undefined
        ? { type: "final" }
        : {
            on: Object.fromEntries(
              Object.entries(state.on).map(([e, t]) => [
                e,
                { target: t.target },
              ]),
            ),
          };
  }
  return { ...config, states };
};

// 13. A clock that accepts any number.
export const fixedClockLoose = (ms: number): Clock =>
  Object.freeze({ now: () => ms });

// 14. advance() without the range check: a fraction passes, the time wraps.
export const manualClockWrapping = (ms: number): ManualClock => {
  let at = ms;
  return {
    now: () => at,
    advance: (delta) => {
      at = (at + delta) % 2 ** 48;
      return ok(at);
    },
    set: (value) => {
      at = value;
      return ok(at);
    },
  };
};

export { fixedClock as realFixedClock, manualClock as realManualClock };
