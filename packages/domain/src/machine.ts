// A data-defined finite state machine (P3-06 D7-D9, ruling 3). defineMachine
// checks a definition once and throws MachineError on a programming error;
// transition is a pure function that never throws and returns a Result for
// every input, garbage included. Names coming in are untrusted strings:
// they are bounded before any lookup and looked up only in Maps and Sets
// built from the definition, never on plain objects. toXStateConfig derives
// the XState v5 config the client mirrors; tooling/xstate-mirror proves the
// two agree step by step (ADR 0049).
import { MachineError } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

export type Guard<C> = (context: C) => boolean;

export interface Transition<
  S extends string,
  E extends string,
  G extends string,
> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly guard?: G;
}

export interface MachineDefinition<
  S extends string,
  E extends string,
  G extends string,
  C,
> {
  readonly id: string;
  readonly initial: NoInfer<S>;
  readonly states: readonly S[];
  readonly events: readonly E[];
  readonly final: readonly NoInfer<S>[];
  readonly transitions: readonly Transition<
    NoInfer<S>,
    NoInfer<E>,
    NoInfer<G>
  >[];
  readonly guards?: { readonly [K in G]: Guard<C> };
}

export interface Machine<
  S extends string,
  E extends string,
  G extends string,
  C,
> {
  readonly id: string;
  readonly initial: S;
  readonly states: readonly S[];
  readonly events: readonly E[];
  readonly final: readonly S[];
  readonly transitions: readonly Transition<S, E, G>[];
  readonly guards: { readonly [K in G]: Guard<C> };
}

export type TransitionResult<S extends string> = Result<S, MachineError>;

/** XState v5 config data (no xstate import here). */
export interface XStateTransitionConfig {
  readonly target: string;
  readonly guard?: string;
}
export interface XStateStateConfig {
  readonly type?: "final";
  readonly on?: Readonly<Record<string, XStateTransitionConfig>>;
}
export interface XStateMachineConfig {
  readonly id: string;
  readonly initial: string;
  readonly states: Readonly<Record<string, XStateStateConfig>>;
}

// --- Internal lookup structures, keyed by the frozen machine ---------------

interface Internal {
  readonly states: ReadonlySet<string>;
  readonly events: ReadonlySet<string>;
  readonly final: ReadonlySet<string>;
  /** state -> event -> transition */
  readonly table: ReadonlyMap<
    string,
    ReadonlyMap<string, Transition<string, string, string>>
  >;
  readonly guards: ReadonlyMap<string, Guard<unknown>>;
}

const internals = new WeakMap<object, Internal>();

const NAME = /^[a-z][a-z0-9_]*$/;

/** 1 to 64 chars, lowercase letters, digits and underscores, first a letter, not an Object.prototype name. */
function isName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= LIMITS.nameLength &&
    NAME.test(value) &&
    !Object.hasOwn(Object.prototype, value)
  );
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function fail(code: MachineError["code"]): never {
  throw new MachineError(code);
}

function names(
  value: unknown,
  limit: number,
  tooMany: MachineError["code"],
): string[] {
  if (!Array.isArray(value)) fail("invalid_definition");
  if (value.length > limit) fail(tooMany);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value as unknown[]) {
    if (!isName(item)) fail("invalid_name");
    if (seen.has(item)) fail("duplicate_name");
    seen.add(item);
    out.push(item);
  }
  return out;
}

// --- Structural checks on a parsed definition (D8) -------------------------

/** What the structural checks see once names, bounds and the table are in place. */
export interface ParsedDefinition {
  readonly initial: string;
  readonly states: readonly string[];
  readonly final: ReadonlySet<string>;
  readonly table: ReadonlyMap<
    string,
    ReadonlyMap<string, Transition<string, string, string>>
  >;
}

export type DefinitionCheck = (parsed: ParsedDefinition) => void;

/** Every state is reachable from the initial state. */
export const checkReachable: DefinitionCheck = ({ initial, states, table }) => {
  const reached = new Set<string>([initial]);
  const frontier = [initial];
  for (
    let current = frontier.pop();
    current !== undefined;
    current = frontier.pop()
  ) {
    for (const t of table.get(current)?.values() ?? []) {
      if (!reached.has(t.to)) {
        reached.add(t.to);
        frontier.push(t.to);
      }
    }
  }
  for (const s of states) if (!reached.has(s)) fail("unreachable_state");
};

/** A final state has no transition out. */
export const checkFinalStates: DefinitionCheck = ({ states, final, table }) => {
  for (const s of states) {
    if (final.has(s) && (table.get(s)?.size ?? 0) > 0)
      fail("final_has_transitions");
  }
};

/** A non-final state has a transition out. */
export const checkDeadEnds: DefinitionCheck = ({ states, final, table }) => {
  for (const s of states) {
    if (!final.has(s) && (table.get(s)?.size ?? 0) === 0)
      fail("dead_end_state");
  }
};

/** The checks defineMachine runs, in order. Internal: sabotage tests build a defineMachine with one removed. */
export const DEFINITION_CHECKS: readonly DefinitionCheck[] = Object.freeze([
  checkReachable,
  checkFinalStates,
  checkDeadEnds,
]);

// --- defineMachine ----------------------------------------------------------

/** defineMachine with a given list of structural checks (internal; the real one uses DEFINITION_CHECKS). */
export function defineMachineWith(
  checks: readonly DefinitionCheck[],
): typeof defineMachine {
  return (definition) => define(definition, checks);
}

export function defineMachine<
  S extends string,
  E extends string,
  G extends string = never,
  C = unknown,
>(definition: MachineDefinition<S, E, G, C>): Machine<S, E, G, C> {
  return define(definition, DEFINITION_CHECKS);
}

function define<S extends string, E extends string, G extends string, C>(
  definition: MachineDefinition<S, E, G, C>,
  checks: readonly DefinitionCheck[],
): Machine<S, E, G, C> {
  if (!isPlainObject(definition)) fail("invalid_definition");
  const def: Record<string, unknown> = definition;

  if (!isName(def["id"])) fail("invalid_name");
  const id = def["id"];
  const states = names(def["states"], LIMITS.machineStates, "too_many_states");
  const events = names(def["events"], LIMITS.machineEvents, "too_many_events");
  const final = names(def["final"], LIMITS.machineStates, "too_many_states");
  if (states.length === 0 || events.length === 0) fail("invalid_definition");
  const stateSet = new Set(states);
  const eventSet = new Set(events);
  if (!isName(def["initial"]) || !stateSet.has(def["initial"]))
    fail("unknown_initial");
  const initial = def["initial"];
  for (const s of final) if (!stateSet.has(s)) fail("undeclared_state");
  const finalSet = new Set(final);

  // Guards: count the keys before reading any value.
  const rawGuards = def["guards"];
  const guardMap = new Map<string, Guard<unknown>>();
  if (rawGuards !== undefined) {
    if (!isPlainObject(rawGuards)) fail("invalid_definition");
    const keys = Object.keys(rawGuards);
    if (keys.length > LIMITS.machineGuards) fail("too_many_guards");
    for (const key of keys) {
      if (!isName(key)) fail("invalid_name");
      const fn: unknown = rawGuards[key];
      if (typeof fn !== "function") fail("invalid_definition");
      guardMap.set(key, fn as Guard<unknown>);
    }
  }

  // Transitions: at most one per (state, event).
  const rawTransitions = def["transitions"];
  if (!Array.isArray(rawTransitions)) fail("invalid_definition");
  if (rawTransitions.length > LIMITS.machineTransitions)
    fail("too_many_transitions");
  const table = new Map<
    string,
    Map<string, Transition<string, string, string>>
  >();
  for (const s of states) table.set(s, new Map());
  const transitions: Transition<string, string, string>[] = [];
  const usedGuards = new Set<string>();
  for (const raw of rawTransitions as unknown[]) {
    if (!isPlainObject(raw)) fail("invalid_definition");
    const from: unknown = raw["from"];
    const event: unknown = raw["event"];
    const to: unknown = raw["to"];
    const guard: unknown = raw["guard"];
    if (!isName(from)) fail("invalid_name");
    if (!stateSet.has(from)) fail("undeclared_state");
    if (!isName(event)) fail("invalid_name");
    if (!eventSet.has(event)) fail("undeclared_event");
    if (!isName(to)) fail("invalid_name");
    if (!stateSet.has(to)) fail("undeclared_state");
    if (guard !== undefined) {
      if (!isName(guard)) fail("invalid_name");
      if (!guardMap.has(guard)) fail("undeclared_guard");
      usedGuards.add(guard);
    }
    const row = table.get(from);
    if (row === undefined || row.has(event)) fail("duplicate_transition");
    const t: Transition<string, string, string> = Object.freeze(
      guard === undefined ? { from, event, to } : { from, event, to, guard },
    );
    row.set(event, t);
    transitions.push(t);
  }
  for (const key of guardMap.keys())
    if (!usedGuards.has(key)) fail("unused_guard");

  const parsed: ParsedDefinition = { initial, states, final: finalSet, table };
  for (const check of checks) check(parsed);

  const guards: Record<string, Guard<unknown>> = {};
  for (const [key, fn] of guardMap) guards[key] = fn;
  const machine = Object.freeze({
    id,
    initial,
    states: Object.freeze(states),
    events: Object.freeze(events),
    final: Object.freeze(final),
    transitions: Object.freeze(transitions),
    guards: Object.freeze(guards),
  }) as unknown as Machine<S, E, G, C>;
  internals.set(machine, {
    states: stateSet,
    events: eventSet,
    final: finalSet,
    table,
    guards: guardMap,
  });
  return machine;
}

// --- transition ----------------------------------------------------------

const isBoundedString = (value: unknown): value is string =>
  typeof value === "string" && value.length <= LIMITS.nameLength;

/** The lookup structures of a machine made by defineMachine; undefined for anything else. */
const internalOf = (machine: unknown): Internal | undefined =>
  typeof machine === "object" && machine !== null
    ? internals.get(machine)
    : undefined;

function step(
  machine: unknown,
  state: unknown,
  event: unknown,
  context: unknown,
): TransitionResult<string> {
  const internal = internalOf(machine);
  if (internal === undefined) return err(new MachineError("invalid_input"));
  if (!isBoundedString(state) || !isBoundedString(event))
    return err(new MachineError("invalid_input"));
  if (!internal.states.has(state))
    return err(new MachineError("unknown_state"));
  if (!internal.events.has(event))
    return err(new MachineError("unknown_event"));
  const t = internal.table.get(state)?.get(event);
  if (t === undefined) return err(new MachineError("illegal_transition"));
  if (t.guard !== undefined) {
    const guard = internal.guards.get(t.guard);
    if (guard === undefined) return err(new MachineError("invalid_input"));
    let passed: unknown;
    try {
      passed = guard(context);
    } catch {
      return err(new MachineError("guard_failed"));
    }
    if (passed !== true) return err(new MachineError("guard_rejected"));
  }
  return ok(t.to);
}

/** The next state for an event, with declared state and event types. */
export function transition<
  S extends string,
  E extends string,
  G extends string,
  C,
>(
  machine: Machine<S, E, G, C>,
  state: NoInfer<S>,
  event: NoInfer<E>,
  context: C,
): TransitionResult<S> {
  return step(machine, state, event, context) as TransitionResult<S>;
}

/** The same step for untrusted input: a name that is not a string of at most 64 characters, or not declared, is an error. */
export function transitionInput(
  machine: unknown,
  state: unknown,
  event: unknown,
  context: unknown,
): TransitionResult<string> {
  return step(machine, state, event, context);
}

/** The declared events with a transition from `state`, guards ignored; [] for anything unknown. */
export function availableEvents<
  S extends string,
  E extends string,
  G extends string,
  C,
>(machine: Machine<S, E, G, C>, state: S): readonly E[] {
  const internal = internalOf(machine);
  if (internal === undefined || !isBoundedString(state)) return [];
  const row = internal.table.get(state);
  if (row === undefined) return [];
  return machine.events.filter((event) => row.has(event));
}

/** The declared transitions, in declaration order. */
export const transitionTable = <
  S extends string,
  E extends string,
  G extends string,
  C,
>(
  machine: Machine<S, E, G, C>,
): readonly Transition<S, E, G>[] => machine.transitions;

/** Plain XState v5 config data for the client mirror (ADR 0049). */
export function toXStateConfig<
  S extends string,
  E extends string,
  G extends string,
  C,
>(machine: Machine<S, E, G, C>): XStateMachineConfig {
  const finalSet = new Set<string>(machine.final);
  const states: Record<string, XStateStateConfig> = {};
  for (const state of machine.states) {
    const on: Record<string, XStateTransitionConfig> = {};
    for (const t of machine.transitions) {
      if (t.from !== state) continue;
      on[t.event] =
        t.guard === undefined
          ? { target: t.to }
          : { target: t.to, guard: t.guard };
    }
    states[state] = finalSet.has(state) ? { type: "final" } : { on };
  }
  return { id: machine.id, initial: machine.initial, states };
}
