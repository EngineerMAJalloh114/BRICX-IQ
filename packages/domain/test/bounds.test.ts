// Bounds before parsing (design constraint 5). Oversized input is rejected
// before any element is read, any regex runs or any Map is consulted. The
// work done is counted (proxies, spies), never timed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineError } from "../src/errors.ts";
import { LIMITS } from "../src/limits.ts";
import { defineMachine, transitionInput } from "../src/machine.ts";
import { unitSystemFor } from "../src/regions.ts";
import { parseQuantity } from "../src/units.ts";
import { base, countingArray, projectMachine } from "./helpers.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

const define = defineMachine as (definition: unknown) => unknown;
const codeOf = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return (error as MachineError).code;
  }
  return "none";
};

describe("limits", () => {
  it("are the approved values", () => {
    expect(LIMITS).toEqual({
      machineStates: 64,
      machineEvents: 64,
      machineTransitions: 256,
      machineGuards: 32,
      nameLength: 64,
      quantityString: 40,
      unitCode: 16,
      integerDigits: 12,
      maxScale: 9,
      countryCode: 2,
    });
    expect(Object.isFrozen(LIMITS)).toBe(true);
  });
});

describe("defineMachine reads no element of an oversized list", () => {
  it.each([
    ["states", LIMITS.machineStates, "too_many_states"],
    ["events", LIMITS.machineEvents, "too_many_events"],
    ["final", LIMITS.machineStates, "too_many_states"],
    ["transitions", LIMITS.machineTransitions, "too_many_transitions"],
  ] as const)("%s with a length of a million", (field, _limit, code) => {
    const { array, reads } = countingArray(["a"], 1_000_000);
    expect(codeOf(() => define({ ...base(), [field]: array }))).toBe(code);
    expect(reads()).toBe(0);
  });

  it("guards: counting stops at the limit + 1 and no guard is read", () => {
    let enumerated = 0;
    let read = 0;
    const keys = Array.from({ length: 10_000 }, (_, i) => `g${String(i)}`);
    const guards = new Proxy(
      {},
      {
        ownKeys: () => {
          enumerated += 1;
          return keys;
        },
        getOwnPropertyDescriptor: () => ({
          value: () => true,
          enumerable: true,
          configurable: true,
        }),
        get: () => {
          read += 1;
          return () => true;
        },
      },
    );
    expect(codeOf(() => define({ ...base(), guards }))).toBe("too_many_guards");
    expect(read).toBe(0);
    expect(enumerated).toBeLessThanOrEqual(1);
  });

  it("a name is length-checked before the name regex runs", () => {
    const exec = vi.spyOn(RegExp.prototype, "exec");
    expect(codeOf(() => define({ ...base(), id: "a".repeat(100_000) }))).toBe(
      "invalid_name",
    );
    expect(exec).not.toHaveBeenCalled();
  });
});

describe("transitionInput consults no Map for an oversized name", () => {
  it("state and event over 64 characters", () => {
    const has = vi.spyOn(Map.prototype, "has");
    const get = vi.spyOn(Map.prototype, "get");
    const setHas = vi.spyOn(Set.prototype, "has");
    const long = "a".repeat(1_000_000);
    const s = transitionInput(projectMachine, long, "activate", undefined);
    const e = transitionInput(projectMachine, "draft", long, undefined);
    expect(!s.ok && s.error.code).toBe("invalid_input");
    expect(!e.ok && e.error.code).toBe("invalid_input");
    // The machine lookup itself is a WeakMap, not a Map or a Set.
    expect(has).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(setHas).not.toHaveBeenCalled();
  });
});

describe("parseQuantity and unitSystemFor run no regex on oversized input", () => {
  it("a quantity string of a million characters", () => {
    const exec = vi.spyOn(RegExp.prototype, "exec");
    const result = parseQuantity("1".repeat(1_000_000), "m");
    expect(!result.ok && result.error.code).toBe("invalid_quantity");
    expect(exec).not.toHaveBeenCalled();
  });

  it("a unit code of a million characters is not looked up", () => {
    const has = vi.spyOn(Map.prototype, "has");
    const get = vi.spyOn(Map.prototype, "get");
    const result = parseQuantity("1", "m".repeat(1_000_000));
    expect(!result.ok && result.error.code).toBe("unknown_unit");
    expect(has).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
  });

  it("a country code of a million characters", () => {
    const exec = vi.spyOn(RegExp.prototype, "exec");
    const result = unitSystemFor("U".repeat(1_000_000));
    expect(!result.ok && result.error.code).toBe("invalid_country");
    expect(exec).not.toHaveBeenCalled();
  });
});
