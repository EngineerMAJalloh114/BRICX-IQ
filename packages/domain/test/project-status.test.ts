// The project status machine (P6-05, ADR 0075; owner condition C3):
// draft -> active | archived; active -> on_hold | completed;
// on_hold -> active | completed; completed -> archived; archived is final
// and nothing reopens. Moving to archived needs project.project.archive,
// any other move project.project.update.
// Done-when 3: every (from, to) pair of the 5 x 5 table is generated and
// checked against the ruled list written out below (an oracle independent
// of the machine's definition); the sabotage block proves the check
// catches a machine with one extra edge.
import { describe, expect, it } from "vitest";
import { MachineError } from "../src/errors.ts";
import { toXStateConfig } from "../src/machine.ts";
import {
  PROJECT_STATUSES,
  PROJECT_STATUS_MACHINE,
  type ProjectStatus,
  nextProjectStatus,
  projectStatusAction,
} from "../src/project-status.ts";

/** The ruling, as written (C3). */
const RULED: Readonly<Record<string, readonly string[]>> = {
  draft: ["active", "archived"],
  active: ["on_hold", "completed"],
  on_hold: ["active", "completed"],
  completed: ["archived"],
  archived: [],
};

const PAIRS = PROJECT_STATUSES.flatMap((from) =>
  PROJECT_STATUSES.map((to) => [from, to] as const),
);

type Next = (
  from: unknown,
  to: unknown,
) => ReturnType<typeof nextProjectStatus>;

/** Every pair against the ruling (the sabotage block reuses it). */
function checkEveryPair(next: Next): void {
  for (const [from, to] of PAIRS) {
    const allowed = (RULED[from] ?? []).includes(to);
    const result = next(from, to);
    expect(result.ok, `${from} -> ${to}`).toBe(allowed);
    if (result.ok) expect(result.value).toBe(to);
    else expect(result.error).toBeInstanceOf(MachineError);
  }
}

describe("the statuses", () => {
  it("are the ROADMAP's five, in order; draft is initial, archived the only final one", () => {
    expect(PROJECT_STATUSES).toEqual([
      "draft",
      "active",
      "on_hold",
      "completed",
      "archived",
    ]);
    expect(Object.isFrozen(PROJECT_STATUSES)).toBe(true);
    expect(PROJECT_STATUS_MACHINE.initial).toBe("draft");
    expect(PROJECT_STATUS_MACHINE.final).toEqual(["archived"]);
  });
});

describe("nextProjectStatus() (Done-when 3, C3)", () => {
  it(`allows exactly the ruled moves among all ${String(PAIRS.length)} pairs`, () => {
    expect(PAIRS).toHaveLength(25);
    checkEveryPair(nextProjectStatus);
  });

  it.each(PAIRS)("%s -> %s follows the ruling", (from, to) => {
    expect(nextProjectStatus(from, to).ok).toBe(
      (RULED[from] ?? []).includes(to),
    );
  });

  it("nothing reopens: completed and archived never go back", () => {
    for (const to of ["draft", "active", "on_hold"] as const) {
      expect(nextProjectStatus("completed", to).ok).toBe(false);
      expect(nextProjectStatus("archived", to).ok).toBe(false);
    }
    expect(nextProjectStatus("archived", "archived").ok).toBe(false);
  });

  it("a status to itself is not a move", () => {
    for (const s of PROJECT_STATUSES) {
      expect(nextProjectStatus(s, s).ok).toBe(false);
    }
  });

  it.each([
    [undefined, "active"],
    ["draft", undefined],
    ["closed", "active"],
    ["draft", "reopened"],
    ["__proto__", "active"],
    ["draft", "constructor"],
    [{}, []],
    ["draft".repeat(20), "active"],
  ])("garbage (%j, %j) is an error, never a throw", (from, to) => {
    const result = nextProjectStatus(from, to);
    expect(result.ok).toBe(false);
  });
});

describe("projectStatusAction() (C3)", () => {
  it.each<[ProjectStatus, "archive" | "update"]>([
    ["archived", "archive"],
    ["active", "update"],
    ["on_hold", "update"],
    ["completed", "update"],
    ["draft", "update"],
  ])("moving to %s needs project.project.%s", (to, action) => {
    expect(projectStatusAction(to)).toBe(action);
  });
});

describe("the client mirror", () => {
  it("toXStateConfig() carries the same edges", () => {
    const config = toXStateConfig(PROJECT_STATUS_MACHINE);
    const edges = Object.entries(config.states)
      .flatMap(([from, state]) =>
        Object.values(state.on ?? {}).map((t) => `${from}->${t.target}`),
      )
      .sort();
    const ruled = Object.entries(RULED)
      .flatMap(([from, tos]) => tos.map((to) => `${from}->${to}`))
      .sort();
    expect(edges).toEqual(ruled);
    expect(config.states.archived).toEqual({ type: "final" });
  });
});

describe("sabotage: one extra edge fails the generated check", () => {
  it("a machine that also reopens completed -> active is caught", () => {
    const mutant: Next = (from, to) =>
      from === "completed" && to === "active"
        ? { ok: true, value: "active" }
        : nextProjectStatus(from, to);
    expect(() => {
      checkEveryPair(mutant);
    }).toThrow();
  });

  it("a machine missing archived as a target from draft is caught", () => {
    const mutant: Next = (from, to) =>
      from === "draft" && to === "archived"
        ? { ok: false, error: new MachineError("illegal_transition") }
        : nextProjectStatus(from, to);
    expect(() => {
      checkEveryPair(mutant);
    }).toThrow();
  });
});
