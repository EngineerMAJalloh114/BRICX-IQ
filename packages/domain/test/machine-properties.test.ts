// Property tests (P3-06 design constraint 4): every reachable state is
// declared, guards cannot be bypassed, transition never throws, and
// transition agrees with the naive oracle on random machines and walks.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MachineError } from "../src/errors.ts";
import {
  availableEvents,
  defineMachine,
  transitionInput,
} from "../src/machine.ts";
import {
  definitionArbitrary,
  guardsFor,
  walkArbitrary,
} from "./arbitraries.ts";
import type { GeneratedDefinition, GuardContext } from "./arbitraries.ts";
import { naiveStep, reachable } from "./oracle.ts";

const RUNS = 300;

function build(def: GeneratedDefinition) {
  return defineMachine({
    id: def.id,
    initial: def.initial,
    states: def.states,
    events: def.events,
    final: def.final,
    transitions: def.transitions,
    guards: guardsFor(def.guardNames),
  });
}

describe("random valid machines", () => {
  it("every generated definition is accepted", () => {
    fc.assert(
      fc.property(definitionArbitrary, (def) => {
        expect(build(def).states).toEqual(def.states);
      }),
      { numRuns: RUNS },
    );
  });

  it("every state a walk reaches is declared and reachable from initial", () => {
    fc.assert(
      fc.property(definitionArbitrary, walkArbitrary, (def, walk) => {
        const machine = build(def);
        const declared = new Set(def.states);
        const canReach = reachable(def.initial, def.transitions);
        let state: string = machine.initial;
        for (const step of walk) {
          const event = def.events[step.event % def.events.length] ?? "e0";
          const result = transitionInput(machine, state, event, step.guards);
          if (result.ok) state = result.value;
          expect(declared.has(state)).toBe(true);
          expect(canReach.has(state)).toBe(true);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("agrees with the naive oracle on every step", () => {
    fc.assert(
      fc.property(definitionArbitrary, walkArbitrary, (def, walk) => {
        const machine = build(def);
        let state: string = machine.initial;
        for (const step of walk) {
          const event = def.events[step.event % def.events.length] ?? "e0";
          const guardResult = (g: string) =>
            (step.guards as GuardContext)[g] === true;
          const expected = naiveStep(
            def.transitions,
            def.states,
            def.events,
            state,
            event,
            guardResult,
          );
          const actual = transitionInput(machine, state, event, step.guards);
          if (expected.ok) {
            expect(actual).toEqual({ ok: true, value: expected.value });
            state = expected.value;
          } else {
            expect(actual.ok).toBe(false);
            expect(!actual.ok && actual.error.code).toBe(expected.code);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("a guard that says no is never bypassed, from any state, by any event", () => {
    fc.assert(
      fc.property(definitionArbitrary, (def) => {
        const machine = build(def);
        const allFalse: GuardContext = { g0: false, g1: false, g2: false };
        for (const t of def.transitions) {
          if (t.guard === undefined) continue;
          const result = transitionInput(machine, t.from, t.event, allFalse);
          expect(result.ok).toBe(false);
          expect(!result.ok && result.error.code).toBe("guard_rejected");
          const only: GuardContext = { ...allFalse, [t.guard]: true };
          expect(transitionInput(machine, t.from, t.event, only)).toEqual({
            ok: true,
            value: t.to,
          });
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("availableEvents is exactly the events with a transition from the state", () => {
    fc.assert(
      fc.property(definitionArbitrary, (def) => {
        const machine = build(def);
        for (const state of def.states) {
          const expected = def.events.filter((e) =>
            def.transitions.some((t) => t.from === state && t.event === e),
          );
          expect(availableEvents(machine, state)).toEqual(expected);
        }
      }),
      { numRuns: RUNS },
    );
  });
});

describe("never throws, whatever comes in", () => {
  it("transitionInput on arbitrary state, event and context values", () => {
    fc.assert(
      fc.property(
        definitionArbitrary,
        fc.anything(),
        fc.anything(),
        fc.anything(),
        (def, state, event, context) => {
          const machine = build(def);
          const result = transitionInput(machine, state, event, context);
          expect(typeof result.ok).toBe("boolean");
          if (result.ok) expect(def.states).toContain(result.value);
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("defineMachine on arbitrary input throws only MachineError", () => {
    const define = defineMachine as (definition: unknown) => unknown;
    fc.assert(
      fc.property(fc.anything(), (definition) => {
        try {
          define(definition);
        } catch (error) {
          expect(error).toBeInstanceOf(MachineError);
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("defineMachine on near-valid input (fields replaced by anything) throws only MachineError", () => {
    const define = defineMachine as (definition: unknown) => unknown;
    const field = fc.constantFrom(
      "id",
      "initial",
      "states",
      "events",
      "final",
      "transitions",
      "guards",
    );
    fc.assert(
      fc.property(
        definitionArbitrary,
        field,
        fc.anything(),
        (def, key, value) => {
          try {
            define({
              ...def,
              guards: guardsFor(def.guardNames),
              [key]: value,
            });
          } catch (error) {
            expect(error).toBeInstanceOf(MachineError);
          }
        },
      ),
      { numRuns: RUNS },
    );
  });
});
