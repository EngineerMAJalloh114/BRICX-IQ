// The project status machine (P6-05, ADR 0075 D14; owner condition C3):
// draft -> active | archived; active -> on_hold | completed;
// on_hold -> active | completed; completed -> archived; archived is final
// and nothing reopens. Built on the data-defined machine (ADR 0049): the
// event of a move is its target status, so the API's { to } is the event.
// Moving to archived needs project.project.archive, any other move
// project.project.update (no new catalogue keys). Pure: no clock, no I/O.
import { MachineError } from "./errors.ts";
import { defineMachine, transitionInput } from "./machine.ts";
import { type Result, err, ok } from "./result.ts";

/** The ROADMAP's five statuses, in order; draft is the initial one. */
export const PROJECT_STATUSES = Object.freeze([
  "draft",
  "active",
  "on_hold",
  "completed",
  "archived",
] as const);

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

/** The moves, as ruled (C3). */
export const PROJECT_STATUS_MACHINE = defineMachine({
  id: "project_status",
  initial: "draft",
  states: [...PROJECT_STATUSES],
  events: ["active", "on_hold", "completed", "archived"],
  final: ["archived"],
  transitions: [
    { from: "draft", event: "active", to: "active" },
    { from: "draft", event: "archived", to: "archived" },
    { from: "active", event: "on_hold", to: "on_hold" },
    { from: "active", event: "completed", to: "completed" },
    { from: "on_hold", event: "active", to: "active" },
    { from: "on_hold", event: "completed", to: "completed" },
    { from: "completed", event: "archived", to: "archived" },
  ],
});

const STATUS_SET: ReadonlySet<string> = new Set(PROJECT_STATUSES);

const isProjectStatus = (value: unknown): value is ProjectStatus =>
  typeof value === "string" && STATUS_SET.has(value);

/**
 * The status after moving `from` to `to`, or a MachineError
 * (illegal_transition for a refused move, unknown_state / unknown_event /
 * invalid_input for anything that is not a status). Never throws.
 */
export function nextProjectStatus(
  from: unknown,
  to: unknown,
): Result<ProjectStatus, MachineError> {
  const result = transitionInput(PROJECT_STATUS_MACHINE, from, to, undefined);
  if (!result.ok) return result;
  // The machine only ever answers one of its declared states; the check
  // narrows the type without a cast.
  return isProjectStatus(result.value)
    ? ok(result.value)
    : /* v8 ignore next */ err(new MachineError("invalid_input"));
}

/** The catalogue action a move to `to` needs: archive for archived, else update. */
export function projectStatusAction(to: ProjectStatus): "archive" | "update" {
  return to === "archived" ? "archive" : "update";
}
