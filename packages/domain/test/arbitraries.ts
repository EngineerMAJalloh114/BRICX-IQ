// fast-check arbitraries for valid machine definitions. Every generated
// definition is valid by construction: a chain s0 -> s1 -> ... -> last
// keeps every state reachable and every non-final state with a way out,
// the last state is the only final one, extra transitions leave non-final
// states with distinct (state, event) pairs, and a guard is declared only
// when a transition uses it.
import fc from "fast-check";
import type { PlainTransition } from "./oracle.ts";

export interface GeneratedDefinition {
  readonly id: string;
  readonly initial: string;
  readonly states: readonly string[];
  readonly events: readonly string[];
  readonly final: readonly string[];
  readonly transitions: readonly PlainTransition[];
  readonly guardNames: readonly string[];
}

export type GuardContext = Readonly<Record<string, boolean>>;

/** The guard functions for a definition: guard g passes when context[g] === true. */
export function guardsFor(
  names: readonly string[],
): Record<string, (context: GuardContext) => boolean> {
  const guards: Record<string, (context: GuardContext) => boolean> = {};
  for (const name of names) {
    guards[name] = (context) => context[name] === true;
  }
  return guards;
}

export const definitionArbitrary: fc.Arbitrary<GeneratedDefinition> = fc
  .record({
    stateCount: fc.integer({ min: 2, max: 8 }),
    eventCount: fc.integer({ min: 1, max: 4 }),
    chainEvents: fc.array(fc.nat(3), { minLength: 7, maxLength: 7 }),
    chainGuards: fc.array(fc.option(fc.nat(2), { nil: undefined }), {
      minLength: 7,
      maxLength: 7,
    }),
    extras: fc.array(
      fc.record({
        from: fc.nat(7),
        event: fc.nat(3),
        to: fc.nat(7),
        guard: fc.option(fc.nat(2), { nil: undefined }),
      }),
      { maxLength: 16 },
    ),
  })
  .map(({ stateCount, eventCount, chainEvents, chainGuards, extras }) => {
    const states = Array.from(
      { length: stateCount },
      (_, i) => `s${String(i)}`,
    );
    const events = Array.from(
      { length: eventCount },
      (_, i) => `e${String(i)}`,
    );
    const last = states[stateCount - 1] ?? "s0";
    const transitions: PlainTransition[] = [];
    const taken = new Set<string>();
    const add = (from: number, event: number, to: number, guard?: number) => {
      const f = states[from % (stateCount - 1)] ?? "s0";
      const e = events[event % eventCount] ?? "e0";
      const t = states[to % stateCount] ?? "s0";
      if (taken.has(`${f}\u0000${e}`)) return;
      taken.add(`${f}\u0000${e}`);
      transitions.push(
        guard === undefined
          ? { from: f, event: e, to: t }
          : { from: f, event: e, to: t, guard: `g${String(guard)}` },
      );
    };
    for (let i = 0; i < stateCount - 1; i += 1) {
      add(i, chainEvents[i] ?? 0, i + 1, chainGuards[i]);
    }
    for (const x of extras) add(x.from, x.event, x.to, x.guard);
    const guardNames = [
      ...new Set(
        transitions.flatMap((t) => (t.guard === undefined ? [] : [t.guard])),
      ),
    ].sort();
    return {
      id: "generated",
      initial: "s0",
      states,
      events,
      final: [last],
      transitions,
      guardNames,
    };
  });

/** A walk: events (by index) with the guard outcomes for each step. */
export const walkArbitrary = fc.array(
  fc.record({
    event: fc.nat(3),
    guards: fc.record({ g0: fc.boolean(), g1: fc.boolean(), g2: fc.boolean() }),
  }),
  { maxLength: 24 },
);
