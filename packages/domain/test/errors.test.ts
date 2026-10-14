// Domain errors (design constraint 2, P3 rule 9): a code and an i18n key,
// a fixed message chosen by the code, never the input, no cause. Every key
// exists in the en, fr and ar catalogs.
import { readFileSync } from "node:fs";
import path from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { fixedClock, manualClock } from "../src/clock.ts";
import {
  CLOCK_ERROR_CODES,
  CLOCK_ERROR_KEYS,
  ClockError,
  DomainError,
  MACHINE_ERROR_CODES,
  MACHINE_ERROR_KEYS,
  MachineError,
  QUANTITY_ERROR_CODES,
  QUANTITY_ERROR_KEYS,
  QuantityError,
} from "../src/errors.ts";
import { defineMachine, transitionInput } from "../src/machine.ts";
import { parseQuantity } from "../src/units.ts";
import { unitSystemFor } from "../src/regions.ts";
import { projectMachine } from "./helpers.ts";

const i18nDir = path.join(import.meta.dirname, "../../i18n/locales");
const catalog = (locale: string, ns: string): Record<string, string> =>
  JSON.parse(
    readFileSync(path.join(i18nDir, locale, `${ns}.json`), "utf8"),
  ) as Record<string, string>;

const allKeys = [
  ...Object.values(MACHINE_ERROR_KEYS),
  ...Object.values(QUANTITY_ERROR_KEYS),
  ...Object.values(CLOCK_ERROR_KEYS),
];

describe("codes and keys", () => {
  it("every code has a key, and the key lists match the code lists", () => {
    expect(Object.keys(MACHINE_ERROR_KEYS).sort()).toEqual(
      [...MACHINE_ERROR_CODES].sort(),
    );
    expect(Object.keys(QUANTITY_ERROR_KEYS).sort()).toEqual(
      [...QUANTITY_ERROR_CODES].sort(),
    );
    expect(Object.keys(CLOCK_ERROR_KEYS).sort()).toEqual(
      [...CLOCK_ERROR_CODES].sort(),
    );
  });

  it.each(["en", "fr", "ar"])(
    "every key exists in the %s catalog",
    (locale) => {
      for (const key of allKeys) {
        const [ns, name] = key.split(":") as [string, string];
        expect(catalog(locale, ns)[name], `${locale} ${key}`).toBeTypeOf(
          "string",
        );
      }
    },
  );

  it("user-facing codes map to errors:domain.<code>; developer errors to errors:generic", () => {
    const userFacing = new Set([
      "illegal_transition",
      "guard_rejected",
      "invalid_quantity",
      "quantity_precision",
      "quantity_out_of_range",
      "unknown_unit",
      "incompatible_units",
    ]);
    const pairs: [string, string][] = [
      ...Object.entries(MACHINE_ERROR_KEYS),
      ...Object.entries(QUANTITY_ERROR_KEYS),
      ...Object.entries(CLOCK_ERROR_KEYS),
    ];
    for (const [code, key] of pairs) {
      expect(key).toBe(
        userFacing.has(code) ? `errors:domain.${code}` : "errors:generic",
      );
    }
    const domainKeys = Object.keys(catalog("en", "errors")).filter((k) =>
      k.startsWith("domain."),
    );
    expect(domainKeys.sort()).toEqual(
      [...userFacing].map((c) => `domain.${c}`).sort(),
    );
  });
});

describe("error objects", () => {
  it.each([
    ["MachineError", new MachineError("illegal_transition")],
    ["QuantityError", new QuantityError("unknown_unit")],
    ["ClockError", new ClockError("invalid_clock")],
  ] as const)(
    "%s is a DomainError with a code, a key and no cause",
    (name, e) => {
      expect(e).toBeInstanceOf(DomainError);
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe(name);
      expect(e.cause).toBeUndefined();
      expect(e.message.length).toBeGreaterThan(0);
      expect(JSON.parse(JSON.stringify(e))).toEqual({
        name,
        code: e.code,
        key: e.key,
      });
    },
  );

  it("messages differ per code within a class", () => {
    const messages = MACHINE_ERROR_CODES.map(
      (c) => new MachineError(c).message,
    );
    expect(new Set(messages).size).toBe(messages.length);
    const q = QUANTITY_ERROR_CODES.map((c) => new QuantityError(c).message);
    expect(new Set(q).size).toBe(q.length);
  });
});

/** The text an error shows anywhere: message, stack, JSON. */
const shown = (e: Error): string =>
  `${e.message}\n${e.stack ?? ""}\n${JSON.stringify(e)}`;

// Inputs that cannot occur in a fixed message by chance.
const marker = fc
  .string({ minLength: 6, maxLength: 30 })
  .map((s) => `ZQ${s.replace(/\s/g, "")}QZ`);

describe("no input value reaches an error (P3 rule 9)", () => {
  it("transitionInput with an untrusted state or event", () => {
    fc.assert(
      fc.property(marker, (value) => {
        for (const [s, e] of [
          [value, "activate"],
          ["draft", value],
        ]) {
          const result = transitionInput(projectMachine, s, e, undefined);
          expect(!result.ok && shown(result.error).includes(value)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("defineMachine with a bad name", () => {
    fc.assert(
      fc.property(marker, (value) => {
        try {
          defineMachine({
            id: value,
            initial: "a",
            states: ["a"],
            events: ["e"],
            final: ["a"],
            transitions: [],
          });
          throw new Error("expected a MachineError");
        } catch (error) {
          expect(error).toBeInstanceOf(MachineError);
          expect(shown(error as Error).includes(value)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("parseQuantity with a bad value or unit", () => {
    fc.assert(
      fc.property(marker, (value) => {
        for (const result of [
          parseQuantity(value, "m"),
          parseQuantity("1", value),
        ]) {
          expect(result.ok).toBe(false);
          expect(!result.ok && shown(result.error).includes(value)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("unitSystemFor with a bad country", () => {
    fc.assert(
      fc.property(marker, (value) => {
        const result = unitSystemFor(value);
        expect(!result.ok && shown(result.error).includes(value)).toBe(false);
      }),
      { numRuns: 200 },
    );
  });

  it("clocks with a bad instant", () => {
    const bad = 123_456.789;
    try {
      fixedClock(bad);
    } catch (error) {
      expect(shown(error as Error)).not.toContain("123456");
    }
    const result = manualClock(0).advance(bad);
    expect(!result.ok && shown(result.error).includes("123456")).toBe(false);
  });
});
