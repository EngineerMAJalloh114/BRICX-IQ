// The fixture machines of @bricx/domain's own tests (packages/domain/test/
// helpers.ts), built again here: the project status machine of ROADMAP
// P6-04 and an approval machine with guards, as P9-05 will have.
import { defineMachine } from "@bricx/domain/machine";

export const projectMachine = defineMachine({
  id: "project_status",
  initial: "draft",
  states: ["draft", "active", "on_hold", "completed", "archived"],
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

export const CONTEXTS: readonly [string, ApprovalContext][] = [
  [
    "other actor, within limit",
    { requesterId: "u1", actorId: "u2", withinLimit: true },
  ],
  [
    "other actor, over limit",
    { requesterId: "u1", actorId: "u2", withinLimit: false },
  ],
  [
    "same actor, within limit",
    { requesterId: "u1", actorId: "u1", withinLimit: true },
  ],
  [
    "same actor, over limit",
    { requesterId: "u1", actorId: "u1", withinLimit: false },
  ],
];
