// Checks shared by the real code and the sabotage mutants (P3 rule 1). Each
// takes the implementation under test as a parameter and throws when it
// misbehaves; sabotage.test.ts runs every check on the real code (must
// pass) and on its mutant in mutants.ts (must throw).
import { Rounding } from "@bricx/money/rounding";
import { expect, vi } from "vitest";
import type { Clock, ManualClock } from "../src/clock.ts";
import { LIMITS } from "../src/limits.ts";
import type {
  Machine,
  MachineDefinition,
  TransitionResult,
  XStateMachineConfig,
} from "../src/machine.ts";
import type { Quantity, QuantityResult } from "../src/units.ts";
import { parseQuantity } from "../src/units.ts";
import {
  OTHER_ACTOR,
  PROTOTYPE_NAMES,
  SAME_ACTOR,
  approvalMachine,
  base,
  countingArray,
  projectMachine,
} from "./helpers.ts";

export type AnyMachine = Machine<string, string, string, unknown>;
export type Define = (definition: unknown) => AnyMachine;
export type Step = (
  machine: AnyMachine,
  state: unknown,
  event: unknown,
  context: unknown,
) => TransitionResult<string>;
export type Convert = (
  value: Quantity,
  unit: string,
  options: { scale: number; rounding: Rounding },
) =>
  | { ok: true; value: { quantity: Quantity } }
  | { ok: false; error: { code: string } };
export type Parse = (value: string, unit: string) => QuantityResult;
export type ToConfig = (machine: AnyMachine) => XStateMachineConfig;

const approval = approvalMachine as AnyMachine;
const project = projectMachine as AnyMachine;

export function fixture(value: string, unit: string): Quantity {
  const result = parseQuantity(value, unit);
  if (!result.ok) throw new Error("fixture");
  return result.value;
}

function thrownCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as { code?: string }).code ?? "no_code";
  }
  return "none";
}

/** A rejecting guard blocks the transition; a passing one lets it through. */
export function checkGuardsEnforced(step: Step): void {
  const blocked = step(approval, "submitted", "approve", SAME_ACTOR);
  expect(blocked.ok).toBe(false);
  expect(!blocked.ok && blocked.error.code).toBe("guard_rejected");
  expect(step(approval, "submitted", "approve", OTHER_ACTOR)).toEqual({
    ok: true,
    value: "approved",
  });
}

/** Ruling 3: a prototype name as a state or event is unknown, never a value, never a throw. */
export function checkPrototypeNames(step: Step): void {
  for (const name of PROTOTYPE_NAMES) {
    for (const machine of [project, approval]) {
      let asState: TransitionResult<string>;
      let asEvent: TransitionResult<string>;
      try {
        asState = step(machine, name, machine.events[0], OTHER_ACTOR);
        asEvent = step(machine, machine.initial, name, OTHER_ACTOR);
      } catch {
        throw new Error(`threw on ${name}`);
      }
      expect(asState.ok, `${name} as a state`).toBe(false);
      expect(!asState.ok && asState.error.code).toBe("unknown_state");
      expect(asEvent.ok, `${name} as an event`).toBe(false);
      expect(!asEvent.ok && asEvent.error.code).toBe("unknown_event");
    }
  }
}

/** A transition to an undeclared state is rejected. */
export function checkUndeclaredTargetRejected(define: Define): void {
  expect(
    thrownCode(() =>
      define({ ...base(), transitions: [{ from: "a", event: "go", to: "z" }] }),
    ),
  ).toBe("undeclared_state");
}

/** An unreachable state is rejected. */
export function checkUnreachableRejected(define: Define): void {
  expect(
    thrownCode(() =>
      define({ ...base(), states: ["a", "b", "c"], final: ["b", "c"] }),
    ),
  ).toBe("unreachable_state");
}

/** A non-final dead end is rejected. */
export function checkDeadEndRejected(define: Define): void {
  expect(thrownCode(() => define({ ...base(), final: [] }))).toBe(
    "dead_end_state",
  );
}

/** An oversized state list is rejected before any element is read. */
export function checkBoundsBeforeRead(define: Define): void {
  const { array, reads } = countingArray(["a"], 1_000_000);
  expect(thrownCode(() => define({ ...base(), states: array }))).toBe(
    "too_many_states",
  );
  expect(reads()).toBe(0);
}

const decimalOf = (result: ReturnType<Convert>): string => {
  if (!result.ok) return result.error.code;
  const q = result.value.quantity;
  const digits = (q.coefficient < 0n ? -q.coefficient : q.coefficient)
    .toString()
    .padStart(q.scale + 1, "0");
  const i = digits.length - q.scale;
  return `${q.coefficient < 0n ? "-" : ""}${digits.slice(0, i)}${q.scale === 0 ? "" : `.${digits.slice(i)}`}`;
};

/** Conversion rounds by the caller's mode, not always down. */
export function checkConvertRounds(convert: Convert): void {
  const half = fixture("2.5", "m");
  expect(
    decimalOf(convert(half, "m", { scale: 0, rounding: Rounding.HALF_UP })),
  ).toBe("3");
  expect(
    decimalOf(convert(half, "m", { scale: 0, rounding: Rounding.HALF_EVEN })),
  ).toBe("2");
  expect(
    decimalOf(convert(half, "m", { scale: 0, rounding: Rounding.DOWN })),
  ).toBe("2");
  expect(
    decimalOf(convert(half, "m", { scale: 0, rounding: Rounding.CEILING })),
  ).toBe("3");
}

/** Conversion multiplies by from/to, not to/from: 1 ft is 12 in, 1 in is 25.4 mm. */
export function checkConvertDirection(convert: Convert): void {
  const H = { scale: 1, rounding: Rounding.HALF_EVEN };
  expect(decimalOf(convert(fixture("1", "ft"), "in", H))).toBe("12.0");
  expect(decimalOf(convert(fixture("1", "in"), "mm", H))).toBe("25.4");
  expect(decimalOf(convert(fixture("1", "km"), "m", H))).toBe("1000.0");
}

/** Exponent notation, signs, spaces and leading zeros are rejected. */
export function checkParseStrict(parse: Parse): void {
  for (const bad of ["1e3", "1E3", "+5", ".5", "5.", "05", " 5", "5 ", ""]) {
    const result = parse(bad, "m");
    expect(result.ok, bad).toBe(false);
  }
  expect(parse("12.500", "m").ok).toBe(true);
}

/** The length bound runs before the regex: no RegExp.exec on a million characters. */
export function checkParseBoundFirst(parse: Parse): void {
  const exec = vi.spyOn(RegExp.prototype, "exec");
  try {
    const result = parse("1".repeat(1_000_000), "m");
    expect(result.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  } finally {
    exec.mockRestore();
  }
}

/** No input text reaches an error's message, stack or JSON. */
export function checkNoInputInErrors(step: Step): void {
  const marker = "ZQmarker7731QZ";
  for (const [s, e] of [
    [marker, "activate"],
    ["draft", marker],
  ]) {
    const result = step(project, s, e, undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const shown = `${result.error.message}\n${result.error.stack ?? ""}\n${JSON.stringify(result.error)}`;
      expect(shown.includes(marker)).toBe(false);
    }
  }
}

/** Region defaults are data: the source names no country code. */
export function checkRegionDataDriven(source: string): void {
  const code = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  expect([...code.matchAll(/["'`]([A-Z]{2})["'`]/g)].map((m) => m[1])).toEqual(
    [],
  );
}

/** The XState config keeps every guard name. */
export function checkXStateKeepsGuards(toConfig: ToConfig): void {
  const config = toConfig(approval);
  expect(config.states["submitted"]?.on?.["approve"]).toEqual({
    target: "approved",
    guard: "not_requester",
  });
  expect(config.states["approved"]?.on?.["pay"]?.guard).toBe("within_limit");
}

/** A clock constructor rejects a fraction, a negative and a value past 2^48 - 1. */
export function checkClockRejectsFraction(make: (ms: number) => Clock): void {
  for (const bad of [1.5, -1, 2 ** 48]) {
    expect(
      thrownCode(() => make(bad)),
      String(bad),
    ).toBe("invalid_clock");
  }
  expect(make(5).now()).toBe(5);
}

/** advance() rejects a fraction and never wraps past 2^48 - 1. */
export function checkAdvanceBounded(make: (ms: number) => ManualClock): void {
  const clock = make(2 ** 48 - 2);
  const fraction = clock.advance(0.5);
  expect(fraction.ok).toBe(false);
  expect(clock.now()).toBe(2 ** 48 - 2);
  const past = clock.advance(10);
  expect(past.ok).toBe(false);
  expect(!past.ok && past.error.code).toBe("invalid_clock");
  expect(clock.now()).toBe(2 ** 48 - 2);
  expect(clock.advance(1)).toEqual({ ok: true, value: 2 ** 48 - 1 });
}

/** A definition with more than the limit of states is rejected (the limit itself passes). */
export function checkStateLimit(define: Define): void {
  const states = Array.from(
    { length: LIMITS.machineStates + 1 },
    (_, i) => `s${String(i)}`,
  );
  const def: MachineDefinition<string, string, string, unknown> = {
    id: "big",
    initial: "s0",
    states,
    events: ["next"],
    final: [states[states.length - 1] ?? ""],
    transitions: states
      .slice(0, -1)
      .map((s, i) => ({ from: s, event: "next", to: states[i + 1] ?? "" })),
  };
  expect(thrownCode(() => define(def))).toBe("too_many_states");
}
