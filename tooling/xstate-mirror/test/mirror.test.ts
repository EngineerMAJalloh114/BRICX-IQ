// Equivalence of the XState mirror and the domain transition (P3-06 D10,
// ruling 2): every (state, event, guard outcome) of the fixture machines and
// of random machines gives the same outcome in both engines, under the
// mapping in src/mirror.ts. xstate is pinned to one exact version here and,
// from P9-06, the same version in apps/client (ADR 0049).
import { createRequire } from "node:module";
import {
  defineMachine,
  toXStateConfig,
  transitionInput,
} from "@bricx/domain/machine";
import type { Machine } from "@bricx/domain/machine";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createMirror } from "../src/mirror.ts";
import {
  definitionArbitrary,
  guardsFor,
  walkArbitrary,
} from "./arbitraries.ts";
import type { GeneratedDefinition, GuardContext } from "./arbitraries.ts";
import { CONTEXTS, approvalMachine, projectMachine } from "./fixtures.ts";

const require = createRequire(import.meta.url);

/** Both engines on one step; throws when they disagree under the mapping. */
function agree(
  machine: Machine<string, string, string, unknown>,
  mirror: ReturnType<typeof createMirror>,
  state: string,
  event: string,
  context: unknown,
): string {
  const domain = transitionInput(machine, state, event, context);
  const xstate = mirror.step(state, event, context);
  if (domain.ok) {
    expect(xstate.can, `${state} --${event}--> can`).toBe(true);
    expect(xstate.value, `${state} --${event}--> value`).toBe(domain.value);
    return domain.value;
  }
  expect(["illegal_transition", "guard_rejected"]).toContain(domain.error.code);
  expect(xstate.can, `${state} --${event}--> can`).toBe(false);
  expect(xstate.value, `${state} --${event}--> unchanged`).toBe(state);
  return state;
}

describe("xstate pin", () => {
  it("is 5.33.2, the version ADR 0049 names for apps/client too", () => {
    const pkg = require("xstate/package.json") as { version: string };
    expect(pkg.version).toBe("5.33.2");
  });
});

describe("toXStateConfig is accepted by createMachine and keeps the shape", () => {
  it.each([
    [
      "project_status",
      projectMachine as Machine<string, string, string, unknown>,
    ],
    ["approval", approvalMachine as Machine<string, string, string, unknown>],
  ])("%s: states, initial and final states match", (_name, machine) => {
    const mirror = createMirror(machine);
    expect(mirror.states).toEqual([...machine.states]);
    expect(mirror.final).toEqual([...machine.final]);
    expect(mirror.machine.config.initial).toBe(machine.initial);
    expect(mirror.machine.id).toBe(machine.id);
  });

  it("the config is pure data: a JSON round trip builds the same machine", () => {
    const config = JSON.parse(
      JSON.stringify(toXStateConfig(approvalMachine)),
    ) as ReturnType<typeof toXStateConfig>;
    expect(config).toEqual(toXStateConfig(approvalMachine));
  });
});

describe("fixture machines: every state x event (x context) agrees", () => {
  const project = projectMachine as Machine<string, string, string, unknown>;
  const projectMirror = createMirror(project);
  const projectCases = project.states.flatMap((state) =>
    project.events.map((event) => [state, event] as const),
  );
  it.each(projectCases)("project_status: %s + %s", (state, event) => {
    agree(project, projectMirror, state, event, undefined);
  });

  const approval = approvalMachine as Machine<string, string, string, unknown>;
  const approvalMirror = createMirror(approval);
  const approvalCases = CONTEXTS.flatMap(([label, context]) =>
    approval.states.flatMap((state) =>
      approval.events.map((event) => [label, state, event, context] as const),
    ),
  );
  it.each(approvalCases)(
    "approval (%s): %s + %s",
    (_label, state, event, context) => {
      agree(approval, approvalMirror, state, event, context);
    },
  );

  it("a guarded step flips with the guard, in both engines", () => {
    const pass = agree(
      approval,
      approvalMirror,
      "submitted",
      "approve",
      CONTEXTS[0]?.[1],
    );
    expect(pass).toBe("approved");
    const stay = agree(
      approval,
      approvalMirror,
      "submitted",
      "approve",
      CONTEXTS[2]?.[1],
    );
    expect(stay).toBe("submitted");
  });
});

function build(def: GeneratedDefinition) {
  return defineMachine({
    id: def.id,
    initial: def.initial,
    states: def.states,
    events: def.events,
    final: def.final,
    transitions: def.transitions,
    guards: guardsFor(def.guardNames),
  }) as Machine<string, string, string, unknown>;
}

describe("random machines agree step by step (fast-check)", () => {
  it("walks from the initial state", () => {
    fc.assert(
      fc.property(definitionArbitrary, walkArbitrary, (def, walk) => {
        const machine = build(def);
        const mirror = createMirror(machine);
        let state: string = machine.initial;
        for (const step of walk) {
          const event = def.events[step.event % def.events.length] ?? "e0";
          state = agree(
            machine,
            mirror,
            state,
            event,
            step.guards satisfies GuardContext,
          );
        }
      }),
      { numRuns: 300 },
    );
  });

  it("every state x event x guard outcome, exhaustively per machine", () => {
    fc.assert(
      fc.property(definitionArbitrary, (def) => {
        const machine = build(def);
        const mirror = createMirror(machine);
        for (const state of def.states) {
          for (const event of def.events) {
            for (const g0 of [false, true]) {
              for (const g1 of [false, true]) {
                agree(machine, mirror, state, event, { g0, g1, g2: g0 !== g1 });
              }
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });
});
