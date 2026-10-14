// The XState v5 mirror of a @bricx/domain machine (P3-06 D10, ruling 2).
// The client (P9-06) builds its XState machine from toXStateConfig(machine)
// and the same guard functions; this module does exactly that, on the
// server side, so the tests can run every step through both engines.
//
// Equivalence mapping (ruling 2b):
//   domain ok(target)              <-> snapshot.can(event) is true and the
//                                      next snapshot's value is target
//   domain err("illegal_transition") <-> can is false and the value is unchanged
//   domain err("guard_rejected")     <-> can is false and the value is unchanged
// A guard that throws is outside the mapping: domain fails closed
// (err("guard_failed")); XState lets the exception propagate.
import { toXStateConfig } from "@bricx/domain/machine";
import type { Machine } from "@bricx/domain/machine";
import { createMachine, transition } from "xstate";
import type { AnyStateMachine } from "xstate";

export interface MirrorStep {
  /** The state value after the event (unchanged when nothing fired). */
  readonly value: string;
  /** snapshot.can(event) before the step. */
  readonly can: boolean;
}

export interface Mirror {
  readonly machine: AnyStateMachine;
  /** The configured state names, as XState sees them. */
  readonly states: readonly string[];
  /** The state names XState marks final. */
  readonly final: readonly string[];
  step(state: string, event: string, context: unknown): MirrorStep;
}

/** An XState machine built from the domain machine's config and guards. */
export function createMirror<
  S extends string,
  E extends string,
  G extends string,
  C,
>(domain: Machine<S, E, G, C>): Mirror {
  const config = toXStateConfig(domain);
  const guards: Record<string, (args: { context: C }) => boolean> = {};
  for (const [name, guard] of Object.entries<(context: C) => boolean>(
    domain.guards,
  )) {
    guards[name] = ({ context }) => guard(context);
  }
  const machine: AnyStateMachine = createMachine(config, { guards });
  const states = Object.keys(machine.states);
  const final = states.filter((s) => machine.states[s]?.type === "final");
  return {
    machine,
    states,
    final,
    step(state, event, context) {
      const snapshot = machine.resolveState({ value: state, context });
      const can = snapshot.can({ type: event });
      const [next] = transition(machine, snapshot, { type: event });
      const value: unknown = next.value;
      if (typeof value !== "string")
        throw new Error("mirror: a flat machine has a string state value");
      return { value, can };
    },
  };
}
