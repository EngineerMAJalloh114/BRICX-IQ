// P5-05 (ADR 0066): per-member project overrides are pure set algebra over
// catalogue keys. effectiveKeys() is what a project membership grants:
// (bundle ∪ add) − remove, catalogue keys only, sorted and unique, with
// unknown strings dropped (a key the catalogue no longer knows must never
// turn into a 500 at read time). validateOverrides() is the write-time
// check the API runs after zod: bounds, duplicates, catalogue membership,
// add keys at project or own scope only and not already in the bundle,
// remove keys in the bundle, a key never in both, and no overrides at all
// on an immutable bundle (the virtual owner role).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CATALOGUE, type CatalogueKey } from "../src/catalogue.ts";
import { PermissionError } from "../src/errors.ts";
import {
  MAX_OVERRIDE_KEYS,
  NO_OVERRIDES,
  type Overrides,
  effectiveKeys,
  knownKeys,
  validateOverrides,
} from "../src/overrides.ts";
import { ROLES } from "../src/roles.ts";

/** A hand-written project bundle (project and own scope, no finance). */
const PM: readonly CatalogueKey[] = Object.freeze([
  "project.task.read.project",
  "project.task.update.project",
  "project.milestone.read.project",
  "field.dailylog.create.project",
  "field.dailylog.read.project",
  "field.photo.read.project",
] as const);
const TASK_READ_PROJECT = "project.task.read.project";
const BUDGET_READ_PROJECT = "finance.budget.read.project";
const BUDGET_READ_ORG = "finance.budget.read.org";
const TASK_READ_SITE = "project.task.read.site";
const DAILYLOG_UPDATE_OWN = "field.dailylog.update.own";

const errorOf = (run: () => unknown): PermissionError => {
  try {
    run();
  } catch (error) {
    if (error instanceof PermissionError) return error;
  }
  throw new Error("expected a PermissionError");
};

describe("effectiveKeys(bundle, overrides)", () => {
  it("no overrides: the bundle, sorted and unique", () => {
    const out = effectiveKeys(PM, NO_OVERRIDES);
    expect(out).toEqual([...new Set(PM)].sort());
    expect(Object.isFrozen(out)).toBe(true);
    expect(effectiveKeys([...PM, ...PM], {})).toEqual([...PM].sort());
  });

  it("adds, removes, and a removed key wins over an added one", () => {
    expect(PM).not.toContain(BUDGET_READ_PROJECT);
    expect(PM).toContain(TASK_READ_PROJECT);
    const out = effectiveKeys(PM, {
      add: [BUDGET_READ_PROJECT],
      remove: [TASK_READ_PROJECT],
    });
    expect(out).toContain(BUDGET_READ_PROJECT);
    expect(out).not.toContain(TASK_READ_PROJECT);
    expect(out).toHaveLength(PM.length);
    expect(
      effectiveKeys(PM, {
        add: [BUDGET_READ_PROJECT],
        remove: [BUDGET_READ_PROJECT],
      }),
    ).toEqual([...PM].sort());
  });

  it("drops strings the catalogue does not know, in the bundle and in both lists, without throwing", () => {
    expect(
      effectiveKeys(["project.task.read.project", "project.task.fly.project"], {
        add: ["finance.budget.read.project", "not a key", ""],
        remove: ["project.task.read.world"],
      }),
    ).toEqual([BUDGET_READ_PROJECT, TASK_READ_PROJECT]);
  });

  it("an empty bundle with overrides: the adds only", () => {
    expect(effectiveKeys([], { add: [TASK_READ_PROJECT] })).toEqual([
      TASK_READ_PROJECT,
    ]);
    expect(effectiveKeys([], { remove: [TASK_READ_PROJECT] })).toEqual([]);
  });

  it("refuses more than MAX_OVERRIDE_KEYS in a list, or more keys than the catalogue in the bundle, before reading them (too_many_keys)", () => {
    const tooMany: unknown[] = [];
    tooMany.length = MAX_OVERRIDE_KEYS + 1;
    const bundleTooMany: unknown[] = [];
    bundleTooMany.length = CATALOGUE.length + 1;
    expect(
      errorOf(() => effectiveKeys(PM, { add: tooMany as string[] })).code,
    ).toBe("too_many_keys");
    expect(
      errorOf(() => effectiveKeys(PM, { remove: tooMany as string[] })).code,
    ).toBe("too_many_keys");
    expect(
      errorOf(() => effectiveKeys(bundleTooMany as string[], {})).code,
    ).toBe("too_many_keys");
    const atMost = Array.from(
      { length: MAX_OVERRIDE_KEYS },
      () => TASK_READ_PROJECT,
    );
    expect(effectiveKeys([], { add: atMost })).toEqual([TASK_READ_PROJECT]);
  });

  it("property: (bundle ∪ add) − remove over the catalogue, sorted, unique, every element a catalogue key", () => {
    const keys = fc.subarray([...CATALOGUE], { maxLength: MAX_OVERRIDE_KEYS });
    fc.assert(
      fc.property(keys, keys, keys, (bundle, add, remove) => {
        const out = effectiveKeys(bundle, { add, remove });
        const expected = [...new Set([...bundle, ...add])]
          .filter((k) => !remove.includes(k))
          .sort();
        expect(out).toEqual(expected);
        for (const key of out) expect(CATALOGUE).toContain(key);
      }),
    );
  });
});

describe("knownKeys(values)", () => {
  it("splits catalogue keys from the rest, keeping the order and counting the unknown", () => {
    expect(
      knownKeys([TASK_READ_PROJECT, "x", BUDGET_READ_ORG, "project.task.read"]),
    ).toEqual({ known: [TASK_READ_PROJECT, BUDGET_READ_ORG], unknown: 2 });
    expect(knownKeys([])).toEqual({ known: [], unknown: 0 });
  });

  it("refuses more values than the catalogue holds, before reading them", () => {
    const tooMany: unknown[] = [];
    tooMany.length = CATALOGUE.length + 1;
    expect(errorOf(() => knownKeys(tooMany as string[])).code).toBe(
      "too_many_keys",
    );
  });
});

describe("validateOverrides(overrides, bundle, options)", () => {
  const ok = (overrides: Overrides, bundle: readonly CatalogueKey[] = PM) =>
    validateOverrides(overrides, bundle);

  it("accepts an add at project or own scope not in the bundle, and a remove in the bundle", () => {
    expect(
      ok({ add: [BUDGET_READ_PROJECT], remove: [TASK_READ_PROJECT] }),
    ).toBeUndefined();
    expect(ok({ add: [DAILYLOG_UPDATE_OWN] })).toBeUndefined();
    expect(ok({})).toBeUndefined();
    expect(ok(NO_OVERRIDES)).toBeUndefined();
    expect(ok({ add: [], remove: [] })).toBeUndefined();
  });

  it.each([
    ["an add at org scope", { add: [BUDGET_READ_ORG] }, "add_scope"],
    ["an add at site scope", { add: [TASK_READ_SITE] }, "add_scope"],
    [
      "an add already in the bundle",
      { add: [TASK_READ_PROJECT] },
      "add_in_bundle",
    ],
    [
      "a remove not in the bundle",
      { remove: [BUDGET_READ_PROJECT] },
      "remove_not_in_bundle",
    ],
    [
      "a key in both lists",
      { add: [BUDGET_READ_PROJECT], remove: [BUDGET_READ_PROJECT] },
      "key_in_both",
    ],
    ["an unknown add", { add: ["finance.budget.read.world"] }, "unknown_key"],
    [
      "an unknown remove",
      { remove: ["project.task.fly.project"] },
      "unknown_key",
    ],
    ["an empty string", { add: [""] }, "unknown_key"],
    [
      "a duplicate add",
      { add: [BUDGET_READ_PROJECT, BUDGET_READ_PROJECT] },
      "duplicate_key",
    ],
    [
      "a duplicate remove",
      { remove: [TASK_READ_PROJECT, TASK_READ_PROJECT] },
      "duplicate_key",
    ],
  ])("refuses %s (%s)", (_what, overrides, problem) => {
    expect(validateOverrides(overrides, PM)).toBe(problem);
  });

  it("the first problem wins, in list order: bounds, then add, then remove", () => {
    expect(
      validateOverrides({ add: ["x", BUDGET_READ_ORG], remove: ["y"] }, PM),
    ).toBe("unknown_key");
    expect(
      validateOverrides({ add: [BUDGET_READ_ORG], remove: ["y"] }, PM),
    ).toBe("add_scope");
    expect(
      validateOverrides({ add: [BUDGET_READ_PROJECT], remove: ["y"] }, PM),
    ).toBe("unknown_key");
  });

  it("refuses more than MAX_OVERRIDE_KEYS in either list before reading them (too_many_keys)", () => {
    const tooMany: unknown[] = [];
    tooMany.length = MAX_OVERRIDE_KEYS + 1;
    expect(validateOverrides({ add: tooMany as string[] }, PM)).toBe(
      "too_many_keys",
    );
    expect(validateOverrides({ remove: tooMany as string[] }, PM)).toBe(
      "too_many_keys",
    );
    expect(
      validateOverrides({ add: ["x"], remove: tooMany as string[] }, PM),
    ).toBe("too_many_keys");
  });

  it("an immutable bundle (the owner role) takes no overrides at all; empty lists are fine", () => {
    expect(
      validateOverrides({ add: [BUDGET_READ_PROJECT] }, ROLES.owner, {
        immutable: true,
      }),
    ).toBe("bundle_immutable");
    expect(
      validateOverrides({ remove: ["org.audit.read.org"] }, ROLES.owner, {
        immutable: true,
      }),
    ).toBe("bundle_immutable");
    expect(
      validateOverrides({ add: [], remove: [] }, ROLES.owner, {
        immutable: true,
      }),
    ).toBeUndefined();
    expect(
      validateOverrides({}, ROLES.owner, { immutable: true }),
    ).toBeUndefined();
  });

  it("accepting means effectiveKeys() holds exactly bundle + add − remove (property)", () => {
    const projectOrOwn = CATALOGUE.filter(
      (k) => k.endsWith(".project") || k.endsWith(".own"),
    );
    fc.assert(
      fc.property(
        fc.subarray([...PM]),
        fc.subarray(
          projectOrOwn.filter((k) => !PM.includes(k)),
          { maxLength: MAX_OVERRIDE_KEYS },
        ),
        (remove, add) => {
          expect(validateOverrides({ add, remove }, PM)).toBeUndefined();
          const out = effectiveKeys(PM, { add, remove });
          expect(out).toEqual(
            [...new Set([...PM, ...add])]
              .filter((k) => !remove.includes(k))
              .sort(),
          );
        },
      ),
    );
  });

  it("never echoes a key in a thrown error", () => {
    const tooMany: unknown[] = [];
    tooMany.length = CATALOGUE.length + 1;
    const error = errorOf(() => effectiveKeys(tooMany as string[], {}));
    expect(error.message).toBe("too many catalogue keys");
    expect(error.code).toBe("too_many_keys");
    expect(JSON.stringify(error)).not.toContain("project");
  });
});
