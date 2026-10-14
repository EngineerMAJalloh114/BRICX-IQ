// Fixture machines and small helpers shared by the tests. The project
// status machine is the one ROADMAP P6-04 names; the approval machine has
// guards (segregation of duties and a limit), as P9-05 will.
import { defineMachine } from "../src/machine.ts";

export const PROJECT_STATES = [
  "draft",
  "active",
  "on_hold",
  "completed",
  "archived",
] as const;

export const projectMachine = defineMachine({
  id: "project_status",
  initial: "draft",
  states: PROJECT_STATES,
  events: ["activate", "hold", "resume", "complete", "archive"],
  final: ["archived"],
  transitions: [
    { from: "draft", event: "activate", to: "active" },
    { from: "draft", event: "archive", to: "archived" },
    { from: "active", event: "hold", to: "on_hold" },
    { from: "on_hold", event: "resume", to: "active" },
    { from: "active", event: "complete", to: "completed" },
    { from: "completed", event: "archive", to: "archived" },
  ],
});

export interface ApprovalContext {
  readonly requesterId: string;
  readonly actorId: string;
  readonly withinLimit: boolean;
}

export const approvalMachine = defineMachine({
  id: "approval",
  initial: "draft",
  states: ["draft", "submitted", "approved", "rejected", "paid"],
  events: ["submit", "approve", "reject", "revise", "pay"],
  final: ["paid"],
  guards: {
    not_requester: (c: ApprovalContext) => c.actorId !== c.requesterId,
    within_limit: (c: ApprovalContext) => c.withinLimit,
  },
  transitions: [
    { from: "draft", event: "submit", to: "submitted" },
    {
      from: "submitted",
      event: "approve",
      to: "approved",
      guard: "not_requester",
    },
    {
      from: "submitted",
      event: "reject",
      to: "rejected",
      guard: "not_requester",
    },
    { from: "rejected", event: "revise", to: "draft" },
    { from: "approved", event: "pay", to: "paid", guard: "within_limit" },
  ],
});

export const OTHER_ACTOR: ApprovalContext = Object.freeze({
  requesterId: "u1",
  actorId: "u2",
  withinLimit: true,
});
export const SAME_ACTOR: ApprovalContext = Object.freeze({
  requesterId: "u1",
  actorId: "u1",
  withinLimit: true,
});

/** Names on Object.prototype: untrusted input must never reach them. */
export const PROTOTYPE_NAMES: readonly string[] = Object.freeze([
  "__proto__",
  "constructor",
  "toString",
  "hasOwnProperty",
  "valueOf",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "__defineGetter__",
  "__lookupGetter__",
]);

/** A minimal valid definition, as plain data, for the definition tests. */
export function base(): {
  id: string;
  initial: string;
  states: string[];
  events: string[];
  final: string[];
  transitions: { from: string; event: string; to: string; guard?: string }[];
  guards?: Record<string, (context: unknown) => boolean>;
} {
  return {
    id: "m",
    initial: "a",
    states: ["a", "b"],
    events: ["go"],
    final: ["b"],
    transitions: [{ from: "a", event: "go", to: "b" }],
  };
}

/** Counts property reads of an array without changing it. */
export function countingArray<T>(
  items: readonly T[],
  length = items.length,
): { array: T[]; reads: () => number } {
  let reads = 0;
  const array = new Proxy([...items], {
    get(target, prop, receiver) {
      if (prop === "length") return length;
      if (typeof prop === "string" && /^\d+$/.test(prop)) reads += 1;
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  return { array, reads: () => reads };
}
