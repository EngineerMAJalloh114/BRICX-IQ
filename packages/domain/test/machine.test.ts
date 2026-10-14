// defineMachine and transition (P3-06 D7-D9, ruling 3). Definitions are
// checked at load and throw MachineError; transition never throws and
// returns a Result for every input, garbage included.
import { describe, expect, it } from "vitest";
import { MachineError } from "../src/errors.ts";
import { LIMITS } from "../src/limits.ts";
import {
  availableEvents,
  defineMachine,
  toXStateConfig,
  transition,
  transitionInput,
  transitionTable,
} from "../src/machine.ts";
import {
  OTHER_ACTOR,
  PROTOTYPE_NAMES,
  SAME_ACTOR,
  approvalMachine,
  base,
  projectMachine,
} from "./helpers.ts";

const define = defineMachine as (definition: unknown) => unknown;

function definitionError(definition: unknown): string {
  try {
    define(definition);
  } catch (error) {
    expect(error).toBeInstanceOf(MachineError);
    return (error as MachineError).code;
  }
  throw new Error("expected a MachineError");
}

describe("defineMachine accepts a valid definition", () => {
  it("returns a frozen machine with frozen copies of the data", () => {
    expect(Object.isFrozen(projectMachine)).toBe(true);
    expect(Object.isFrozen(projectMachine.states)).toBe(true);
    expect(Object.isFrozen(projectMachine.transitions)).toBe(true);
    expect(projectMachine.transitions.every((t) => Object.isFrozen(t))).toBe(
      true,
    );
    expect(projectMachine.initial).toBe("draft");
    expect(projectMachine.final).toEqual(["archived"]);
  });

  it("keeps no reference to the caller's arrays", () => {
    const def = base();
    const machine = define(def) as typeof projectMachine;
    def.states.push("c");
    def.transitions.push({ from: "b", event: "go", to: "a" });
    expect(machine.states).toEqual(["a", "b"]);
    expect(machine.transitions).toHaveLength(1);
  });
});

describe("defineMachine rejects a bad definition (D8, ruling 3)", () => {
  it.each([
    ["not an object", null, "invalid_definition"],
    ["an array", [], "invalid_definition"],
    ["states not an array", { ...base(), states: "a" }, "invalid_definition"],
    ["no states", { ...base(), states: [] }, "invalid_definition"],
    ["no events", { ...base(), events: [] }, "invalid_definition"],
    ["final not an array", { ...base(), final: "b" }, "invalid_definition"],
    [
      "transitions not an array",
      { ...base(), transitions: {} },
      "invalid_definition",
    ],
    [
      "a transition not an object",
      { ...base(), transitions: ["a"] },
      "invalid_definition",
    ],
    ["guards an array", { ...base(), guards: [] }, "invalid_definition"],
    [
      "a guard not a function",
      {
        ...base(),
        guards: { g: true },
        transitions: [{ from: "a", event: "go", to: "b", guard: "g" }],
      },
      "invalid_definition",
    ],
    ["an id that is not a name", { ...base(), id: "Bad" }, "invalid_name"],
    ["an uppercase state", { ...base(), states: ["a", "B"] }, "invalid_name"],
    [
      "a state with a dash",
      { ...base(), states: ["a", "b-c"] },
      "invalid_name",
    ],
    ["an empty event", { ...base(), events: [""] }, "invalid_name"],
    ["a number as a state", { ...base(), states: ["a", 1] }, "invalid_name"],
    [
      "a name over 64 characters",
      { ...base(), events: ["e".repeat(LIMITS.nameLength + 1)] },
      "invalid_name",
    ],
    [
      "a duplicate state",
      { ...base(), states: ["a", "b", "a"] },
      "duplicate_name",
    ],
    [
      "a duplicate event",
      { ...base(), events: ["go", "go"] },
      "duplicate_name",
    ],
    ["a duplicate final", { ...base(), final: ["b", "b"] }, "duplicate_name"],
    ["an undeclared initial", { ...base(), initial: "z" }, "unknown_initial"],
    ["an undeclared final", { ...base(), final: ["z"] }, "undeclared_state"],
    [
      "a transition from an undeclared state",
      { ...base(), transitions: [{ from: "z", event: "go", to: "b" }] },
      "undeclared_state",
    ],
    [
      "a transition to an undeclared state",
      { ...base(), transitions: [{ from: "a", event: "go", to: "z" }] },
      "undeclared_state",
    ],
    [
      "a transition on an undeclared event",
      { ...base(), transitions: [{ from: "a", event: "fly", to: "b" }] },
      "undeclared_event",
    ],
    [
      "an undeclared guard",
      {
        ...base(),
        transitions: [{ from: "a", event: "go", to: "b", guard: "g" }],
      },
      "undeclared_guard",
    ],
    [
      "an unused guard",
      { ...base(), guards: { g: () => true } },
      "unused_guard",
    ],
    [
      "two transitions for one state and event",
      {
        ...base(),
        states: ["a", "b", "c"],
        final: ["b", "c"],
        transitions: [
          { from: "a", event: "go", to: "b" },
          { from: "a", event: "go", to: "c" },
        ],
      },
      "duplicate_transition",
    ],
    [
      "an unreachable state",
      { ...base(), states: ["a", "b", "c"], final: ["b", "c"] },
      "unreachable_state",
    ],
    ["a non-final dead end", { ...base(), final: [] }, "dead_end_state"],
    [
      "a final state with a way out",
      {
        ...base(),
        events: ["go", "back"],
        transitions: [
          { from: "a", event: "go", to: "b" },
          { from: "b", event: "back", to: "a" },
        ],
      },
      "final_has_transitions",
    ],
  ])("%s", (_name, definition, code) => {
    expect(definitionError(definition)).toBe(code);
  });

  it.each(PROTOTYPE_NAMES)(
    "the prototype name %s is not a valid state, event, guard or id",
    (name) => {
      expect(definitionError({ ...base(), states: ["a", "b", name] })).toBe(
        "invalid_name",
      );
      expect(definitionError({ ...base(), events: ["go", name] })).toBe(
        "invalid_name",
      );
      expect(definitionError({ ...base(), id: name })).toBe("invalid_name");
      const guards: Record<string, () => boolean> = {};
      Object.defineProperty(guards, name, {
        value: () => true,
        enumerable: true,
      });
      expect(definitionError({ ...base(), guards })).toBe("invalid_name");
    },
  );

  it.each([
    ["states", LIMITS.machineStates, "too_many_states"],
    ["events", LIMITS.machineEvents, "too_many_events"],
    ["transitions", LIMITS.machineTransitions, "too_many_transitions"],
  ] as const)("more than the limit of %s (%i)", (field, limit, code) => {
    const names = Array.from({ length: limit + 1 }, (_, i) => `n${String(i)}`);
    const value =
      field === "transitions"
        ? names.map(() => ({ from: "a", event: "go", to: "b" }))
        : names;
    expect(definitionError({ ...base(), [field]: value })).toBe(code);
  });

  it("more guards than the limit", () => {
    const guards: Record<string, () => boolean> = {};
    for (let i = 0; i <= LIMITS.machineGuards; i += 1)
      guards[`g${String(i)}`] = () => true;
    expect(definitionError({ ...base(), guards })).toBe("too_many_guards");
  });

  it("the limits themselves are accepted (a chain of 64 states)", () => {
    const states = Array.from(
      { length: LIMITS.machineStates },
      (_, i) => `s${String(i)}`,
    );
    const transitions = states
      .slice(0, -1)
      .map((s, i) => ({ from: s, event: "next", to: states[i + 1] ?? "" }));
    const machine = define({
      id: "chain",
      initial: "s0",
      states,
      events: ["next"],
      final: [states[states.length - 1]],
      transitions,
    }) as typeof projectMachine;
    expect(machine.states).toHaveLength(LIMITS.machineStates);
  });
});

describe("transition (D7, D9)", () => {
  it("a declared transition moves to its target", () => {
    expect(transition(projectMachine, "draft", "activate", undefined)).toEqual({
      ok: true,
      value: "active",
    });
    expect(transition(projectMachine, "on_hold", "resume", undefined)).toEqual({
      ok: true,
      value: "active",
    });
  });

  it("an event with no transition in this state is illegal_transition", () => {
    const result = transition(projectMachine, "draft", "complete", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBeInstanceOf(MachineError);
      expect(result.error.code).toBe("illegal_transition");
      expect(result.error.key).toBe("errors:domain.illegal_transition");
    }
  });

  it("a final state accepts no event", () => {
    for (const event of projectMachine.events) {
      const result = transition(projectMachine, "archived", event, undefined);
      expect(!result.ok && result.error.code).toBe("illegal_transition");
    }
  });

  it("a guard that passes lets the transition through", () => {
    expect(
      transition(approvalMachine, "submitted", "approve", OTHER_ACTOR),
    ).toEqual({ ok: true, value: "approved" });
  });

  it("a guard that fails gives guard_rejected (requester = approver)", () => {
    const result = transition(
      approvalMachine,
      "submitted",
      "approve",
      SAME_ACTOR,
    );
    expect(!result.ok && result.error.code).toBe("guard_rejected");
    expect(!result.ok && result.error.key).toBe("errors:domain.guard_rejected");
  });

  it("only === true passes: a truthy non-boolean is a rejection", () => {
    const machine = defineMachine({
      id: "truthy",
      initial: "a",
      states: ["a", "b"],
      events: ["go"],
      final: ["b"],
      guards: { g: (c: { value: unknown }) => c.value as boolean },
      transitions: [{ from: "a", event: "go", to: "b", guard: "g" }],
    });
    for (const value of [1, "yes", {}, [], "true"]) {
      const result = transition(machine, "a", "go", { value });
      expect(!result.ok && result.error.code).toBe("guard_rejected");
    }
  });

  it("a guard that throws gives guard_failed, never a throw", () => {
    const machine = defineMachine({
      id: "throws",
      initial: "a",
      states: ["a", "b"],
      events: ["go"],
      final: ["b"],
      guards: {
        g: (c: { fail: boolean }) => {
          if (c.fail) throw new Error("secret detail");
          return true;
        },
      },
      transitions: [{ from: "a", event: "go", to: "b", guard: "g" }],
    });
    const result = transition(machine, "a", "go", { fail: true });
    expect(!result.ok && result.error.code).toBe("guard_failed");
    expect(!result.ok && result.error.message).not.toContain("secret");
    expect(transition(machine, "a", "go", { fail: false }).ok).toBe(true);
  });

  it("calls exactly one guard, once, and none for an unguarded transition", () => {
    let calls = 0;
    const machine = defineMachine({
      id: "count",
      initial: "a",
      states: ["a", "b", "c"],
      events: ["go", "skip"],
      final: ["c"],
      guards: {
        g: () => {
          calls += 1;
          return true;
        },
      },
      transitions: [
        { from: "a", event: "go", to: "b", guard: "g" },
        { from: "b", event: "skip", to: "c" },
      ],
    });
    transition(machine, "a", "go", undefined);
    expect(calls).toBe(1);
    transition(machine, "b", "skip", undefined);
    transition(machine, "a", "skip", undefined);
    expect(calls).toBe(1);
  });
});

describe("transitionInput: untrusted names (ruling 3)", () => {
  it.each(PROTOTYPE_NAMES)(
    "%s as a state or an event is an error, never a prototype value or a throw",
    (name) => {
      for (const machine of [projectMachine, approvalMachine]) {
        const asState = transitionInput(machine, name, "submit", OTHER_ACTOR);
        expect(asState.ok).toBe(false);
        expect(!asState.ok && asState.error.code).toBe("unknown_state");
        const asEvent = transitionInput(machine, "draft", name, OTHER_ACTOR);
        expect(asEvent.ok).toBe(false);
        expect(!asEvent.ok && asEvent.error.code).toBe("unknown_event");
        const both = transitionInput(machine, name, name, OTHER_ACTOR);
        expect(both.ok).toBe(false);
      }
    },
  );

  it.each([
    ["a number", 1],
    ["null", null],
    ["undefined", undefined],
    ["an object", { toString: () => "draft" }],
    ["a String object", new String("draft")],
    ["a symbol", Symbol("draft")],
  ])("%s as a state is invalid_input", (_name, value) => {
    const result = transitionInput(
      projectMachine,
      value,
      "activate",
      undefined,
    );
    expect(!result.ok && result.error.code).toBe("invalid_input");
  });

  it("a name over 64 characters is invalid_input", () => {
    const long = "a".repeat(LIMITS.nameLength + 1);
    const asState = transitionInput(
      projectMachine,
      long,
      "activate",
      undefined,
    );
    expect(!asState.ok && asState.error.code).toBe("invalid_input");
    const asEvent = transitionInput(projectMachine, "draft", long, undefined);
    expect(!asEvent.ok && asEvent.error.code).toBe("invalid_input");
  });

  it("an unknown state and an unknown event", () => {
    const s = transitionInput(projectMachine, "deleted", "activate", undefined);
    expect(!s.ok && s.error.code).toBe("unknown_state");
    const e = transitionInput(projectMachine, "draft", "delete", undefined);
    expect(!e.ok && e.error.code).toBe("unknown_event");
  });

  it("a machine not made by defineMachine is invalid_input", () => {
    const fake = { ...projectMachine };
    const result = transitionInput(fake, "draft", "activate", undefined);
    expect(!result.ok && result.error.code).toBe("invalid_input");
  });

  it("agrees with transition on valid input", () => {
    expect(
      transitionInput(projectMachine, "draft", "activate", undefined),
    ).toEqual(transition(projectMachine, "draft", "activate", undefined));
  });
});

describe("availableEvents, transitionTable, toXStateConfig", () => {
  it("availableEvents lists events with a transition, guards ignored", () => {
    expect(availableEvents(projectMachine, "draft")).toEqual([
      "activate",
      "archive",
    ]);
    expect(availableEvents(projectMachine, "archived")).toEqual([]);
    expect(availableEvents(approvalMachine, "submitted")).toEqual([
      "approve",
      "reject",
    ]);
  });

  it("availableEvents of an untrusted or unknown state is empty", () => {
    const events = availableEvents as (m: unknown, s: unknown) => unknown;
    expect(events(projectMachine, "constructor")).toEqual([]);
    expect(events(projectMachine, 1)).toEqual([]);
    expect(events({}, "draft")).toEqual([]);
  });

  it("transitionTable is the declared transitions", () => {
    expect(transitionTable(approvalMachine)).toEqual(
      approvalMachine.transitions,
    );
  });

  it("toXStateConfig is plain XState v5 config data", () => {
    expect(toXStateConfig(approvalMachine)).toEqual({
      id: "approval",
      initial: "draft",
      states: {
        draft: { on: { submit: { target: "submitted" } } },
        submitted: {
          on: {
            approve: { target: "approved", guard: "not_requester" },
            reject: { target: "rejected", guard: "not_requester" },
          },
        },
        approved: { on: { pay: { target: "paid", guard: "within_limit" } } },
        rejected: { on: { revise: { target: "draft" } } },
        paid: { type: "final" },
      },
    });
  });

  it("toXStateConfig output survives a JSON round trip unchanged", () => {
    const config = toXStateConfig(projectMachine);
    expect(JSON.parse(JSON.stringify(config))).toEqual(config);
  });
});
