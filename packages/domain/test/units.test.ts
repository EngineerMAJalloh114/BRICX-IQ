// Units of measure (D1-D5, ruling 4): exact bigint quantities, strict
// decimal strings, conversion with an explicit scale and rounding, compare
// and equals by exact value.
import { Rounding } from "@bricx/money/rounding";
import { describe, expect, it } from "vitest";
import { QuantityError } from "../src/errors.ts";
import { LIMITS } from "../src/limits.ts";
import {
  DIMENSIONS,
  UNITS,
  UNIT_KEYS,
  compare,
  convert,
  dimensionOf,
  equals,
  isQuantity,
  isUnitCode,
  parseQuantity,
  quantity,
  toDecimalString,
  toJSON,
} from "../src/units.ts";
import type { Quantity, UnitCode } from "../src/units.ts";

function q(value: string, unit: UnitCode): Quantity {
  const result = parseQuantity(value, unit);
  if (!result.ok)
    throw new Error(`fixture ${value} ${unit}: ${result.error.code}`);
  return result.value;
}

const code = (result: { ok: boolean; error?: QuantityError }) =>
  result.ok ? "ok" : result.error?.code;

describe("the unit list (D3, D4)", () => {
  it("has the 34 approved units in five dimensions", () => {
    expect(UNITS.map((u) => u.code)).toEqual([
      "mm",
      "cm",
      "m",
      "km",
      "in",
      "ft",
      "yd",
      "mi",
      "mm2",
      "cm2",
      "m2",
      "ha",
      "km2",
      "in2",
      "ft2",
      "yd2",
      "ac",
      "mi2",
      "cm3",
      "l",
      "m3",
      "in3",
      "ft3",
      "yd3",
      "us_gal",
      "imp_gal",
      "g",
      "kg",
      "t",
      "oz",
      "lb",
      "short_ton",
      "long_ton",
      "ea",
    ]);
    expect(DIMENSIONS).toEqual(["length", "area", "volume", "mass", "count"]);
  });

  it("each dimension has exactly one base unit (factor 1)", () => {
    for (const dimension of DIMENSIONS) {
      const bases = UNITS.filter(
        (u) => u.dimension === dimension && u.factor === "1",
      ).map((u) => u.code);
      expect(bases).toHaveLength(1);
    }
  });

  it("the list and its entries are frozen", () => {
    expect(Object.isFrozen(UNITS)).toBe(true);
    expect(UNITS.every((u) => Object.isFrozen(u))).toBe(true);
  });

  it("every unit has its own i18n key common:unit.<code>", () => {
    for (const u of UNITS) {
      expect(UNIT_KEYS[u.code]).toBe(`common:unit.${u.code}`);
    }
    expect(Object.keys(UNIT_KEYS)).toHaveLength(UNITS.length);
  });

  it("isUnitCode and dimensionOf use only the unit table", () => {
    expect(isUnitCode("m")).toBe(true);
    expect(isUnitCode("M")).toBe(false);
    expect(isUnitCode("constructor")).toBe(false);
    expect(isUnitCode("__proto__")).toBe(false);
    expect(isUnitCode(1)).toBe(false);
    expect(dimensionOf("us_gal")).toBe("volume");
    expect(dimensionOf("ea")).toBe("count");
  });
});

describe("parseQuantity (ruling 4)", () => {
  it.each([
    ["0", 0n, 0],
    ["12", 12n, 0],
    ["12.5", 125n, 1],
    ["12.500", 12500n, 3],
    ["-3.25", -325n, 2],
    ["0.000000001", 1n, 9],
    ["999999999999", 999999999999n, 0],
    ["-999999999999.999999999", -999999999999999999999n, 9],
  ])("%s is coefficient %s at scale %i", (value, coefficient, scale) => {
    const result = parseQuantity(value, "m");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.coefficient).toBe(coefficient);
      expect(result.value.scale).toBe(scale);
      expect(result.value.unit).toBe("m");
      expect(Object.isFrozen(result.value)).toBe(true);
      expect(isQuantity(result.value)).toBe(true);
    }
  });

  it("trailing zeros are kept: 12.500 keeps scale 3 and prints back as 12.500", () => {
    const value = q("12.500", "m");
    expect(value.scale).toBe(3);
    expect(toDecimalString(value)).toBe("12.500");
    expect(toJSON(value)).toEqual({ value: "12.500", unit: "m" });
  });

  it.each(["-0", "-0.000", "-0.0"])(
    "%s is zero with no sign (a quantity has no negative zero)",
    (value) => {
      const result = parseQuantity(value, "kg");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.coefficient).toBe(0n);
        expect(toDecimalString(result.value).startsWith("-")).toBe(false);
        expect(Object.is(Number(result.value.coefficient), -0)).toBe(false);
      }
    },
  );

  it("-0.000 keeps scale 3 and prints as 0.000", () => {
    expect(toDecimalString(q("-0.000", "kg"))).toBe("0.000");
  });

  it.each([
    "+5",
    ".5",
    "5.",
    "05",
    "00",
    "-05",
    "1e3",
    "1E3",
    " 5",
    "5 ",
    "",
    "-",
    "--5",
    "5,0",
    "1_000",
    "0x10",
    "Infinity",
    "NaN",
    "١٢",
    "５",
    "5.5.5",
  ])("%j is invalid_quantity", (value) => {
    expect(code(parseQuantity(value, "m"))).toBe("invalid_quantity");
  });

  it("more than 9 fraction digits is quantity_precision", () => {
    expect(code(parseQuantity("1.0000000001", "m"))).toBe("quantity_precision");
    expect(code(parseQuantity("0.0000000000", "m"))).toBe("quantity_precision");
  });

  it("more than 12 integer digits is quantity_out_of_range", () => {
    expect(code(parseQuantity("1000000000000", "m"))).toBe(
      "quantity_out_of_range",
    );
    expect(code(parseQuantity("-1000000000000.5", "m"))).toBe(
      "quantity_out_of_range",
    );
  });

  it("a string over 40 characters is invalid_quantity before any parsing", () => {
    expect(LIMITS.quantityString).toBe(40);
    expect(code(parseQuantity("1".repeat(41), "m"))).toBe("invalid_quantity");
  });

  it("a non-string value is invalid_quantity", () => {
    const parse = parseQuantity as (
      v: unknown,
      u: unknown,
    ) => ReturnType<typeof parseQuantity>;
    for (const v of [5, 5n, null, undefined, {}, ["5"], new String("5")]) {
      expect(code(parse(v, "m"))).toBe("invalid_quantity");
    }
  });

  it.each([
    "M",
    "metre",
    "",
    "constructor",
    "__proto__",
    "toString",
    "x".repeat(17),
  ])("unit %j is unknown_unit", (unit) => {
    expect(code(parseQuantity("1", unit))).toBe("unknown_unit");
  });
});

describe("quantity(coefficient, scale, unit)", () => {
  it("builds the same value as the string form", () => {
    const built = quantity(12500n, 3, "m");
    expect(built.ok && toDecimalString(built.value)).toBe("12.500");
  });

  it.each([-1, 10, 1.5, Number.NaN])("scale %s is invalid_scale", (scale) => {
    expect(code(quantity(1n, scale, "m"))).toBe("invalid_scale");
  });

  it("checks the 12 integer digits at its scale", () => {
    expect(quantity(999999999999999n, 3, "m").ok).toBe(true);
    expect(code(quantity(1000000000000000n, 3, "m"))).toBe(
      "quantity_out_of_range",
    );
  });

  it("rejects a non-bigint coefficient and an unknown unit", () => {
    const build = quantity as (
      c: unknown,
      s: unknown,
      u: unknown,
    ) => ReturnType<typeof quantity>;
    expect(code(build(1, 0, "m"))).toBe("invalid_quantity");
    expect(code(build(1n, 0, "furlong"))).toBe("unknown_unit");
  });

  it("-0n is 0n", () => {
    const built = quantity(-0n, 2, "m");
    expect(built.ok && toDecimalString(built.value)).toBe("0.00");
  });
});

describe("convert (D2)", () => {
  const H = { rounding: Rounding.HALF_EVEN };

  it("an exact conversion is exact", () => {
    const result = convert(q("1", "ft"), "in", { scale: 0, ...H });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(toDecimalString(result.value.quantity)).toBe("12");
      expect(result.value.quantity.unit).toBe("in");
      expect(result.value.exact).toBe(true);
    }
  });

  it.each([
    ["1", "in", "mm", 1, "25.4", true],
    ["1", "mi", "km", 6, "1.609344", true],
    ["1", "ac", "m2", 7, "4046.8564224", true],
    ["1", "us_gal", "l", 9, "3.785411784", true],
    ["1", "imp_gal", "l", 5, "4.54609", true],
    ["1", "lb", "kg", 8, "0.45359237", true],
    ["1", "long_ton", "kg", 7, "1016.0469088", true],
    ["1", "yd3", "m3", 9, "0.764554858", false],
    ["1", "m", "ft", 4, "3.2808", false],
    ["10", "m3", "yd3", 2, "13.08", false],
    ["2.5", "t", "short_ton", 3, "2.756", false],
    ["1", "ha", "ac", 4, "2.4711", false],
  ] as const)(
    "%s %s -> %s at scale %i is %s (exact %s)",
    (value, from, to, scale, expected, exact) => {
      const result = convert(q(value, from), to, { scale, ...H });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(toDecimalString(result.value.quantity)).toBe(expected);
        expect(result.value.exact).toBe(exact);
      }
    },
  );

  it("rounds once, by the caller's mode", () => {
    const value = q("2.5", "m");
    const at0 = (rounding: Rounding) => {
      const r = convert(value, "m", { scale: 0, rounding });
      return r.ok ? toDecimalString(r.value.quantity) : r.error.code;
    };
    expect(at0(Rounding.HALF_EVEN)).toBe("2");
    expect(at0(Rounding.HALF_UP)).toBe("3");
    expect(at0(Rounding.HALF_DOWN)).toBe("2");
    expect(at0(Rounding.UP)).toBe("3");
    expect(at0(Rounding.DOWN)).toBe("2");
    expect(at0(Rounding.CEILING)).toBe("3");
    expect(at0(Rounding.FLOOR)).toBe("2");
    const negative = q("-2.5", "m");
    const neg = (rounding: Rounding) => {
      const r = convert(negative, "m", { scale: 0, rounding });
      return r.ok ? toDecimalString(r.value.quantity) : r.error.code;
    };
    expect(neg(Rounding.HALF_UP)).toBe("-3");
    expect(neg(Rounding.CEILING)).toBe("-2");
    expect(neg(Rounding.FLOOR)).toBe("-3");
  });

  it("a rounding carry that adds a 13th integer digit is out of range (ruling 4)", () => {
    const value = q("999999999999.9", "m");
    const up = convert(value, "m", { scale: 0, rounding: Rounding.HALF_UP });
    expect(code(up)).toBe("quantity_out_of_range");
    const down = convert(value, "m", { scale: 0, rounding: Rounding.DOWN });
    expect(down.ok && toDecimalString(down.value.quantity)).toBe(
      "999999999999",
    );
  });

  it("a result too large for 12 integer digits is out of range", () => {
    const result = convert(q("999999999999", "km"), "mm", { scale: 0, ...H });
    expect(code(result)).toBe("quantity_out_of_range");
  });

  it("a conversion across dimensions is incompatible_units", () => {
    expect(code(convert(q("1", "m"), "kg", { scale: 0, ...H }))).toBe(
      "incompatible_units",
    );
    expect(code(convert(q("1", "ea"), "m", { scale: 0, ...H }))).toBe(
      "incompatible_units",
    );
  });

  it("an unknown target unit, a bad scale and a bad rounding are rejected", () => {
    const to = convert as (
      v: unknown,
      u: unknown,
      o: unknown,
    ) => ReturnType<typeof convert>;
    expect(code(to(q("1", "m"), "furlong", { scale: 0, ...H }))).toBe(
      "unknown_unit",
    );
    expect(code(to(q("1", "m"), "ft", { scale: 10, ...H }))).toBe(
      "invalid_scale",
    );
    expect(code(to(q("1", "m"), "ft", { scale: 2 }))).toBe("invalid_rounding");
    expect(
      code(to(q("1", "m"), "ft", { scale: 2, rounding: "half_even" })),
    ).toBe("invalid_rounding");
    expect(code(to(q("1", "m"), "ft", null))).toBe("invalid_scale");
    expect(
      code(
        to({ coefficient: 1n, scale: 0, unit: "m" }, "ft", { scale: 0, ...H }),
      ),
    ).toBe("invalid_quantity");
  });

  it("the result keeps no negative zero", () => {
    const r = convert(q("-0.4", "m"), "m", { scale: 0, ...H });
    expect(r.ok && toDecimalString(r.value.quantity)).toBe("0");
  });
});

describe("compare and equals (ruling 4)", () => {
  it("compare orders by value across scales", () => {
    expect(compare(q("12.5", "m"), q("12.500", "m"))).toEqual({
      ok: true,
      value: 0,
    });
    expect(compare(q("12.49", "m"), q("12.5", "m"))).toEqual({
      ok: true,
      value: -1,
    });
    expect(compare(q("2", "m"), q("1.999999999", "m"))).toEqual({
      ok: true,
      value: 1,
    });
    expect(compare(q("-1", "m"), q("0.000", "m"))).toEqual({
      ok: true,
      value: -1,
    });
  });

  it("compare works across units of one dimension, exactly", () => {
    expect(compare(q("1", "ft"), q("12", "in"))).toEqual({
      ok: true,
      value: 0,
    });
    expect(compare(q("1", "ft"), q("0.3048", "m"))).toEqual({
      ok: true,
      value: 0,
    });
    expect(compare(q("1", "ft"), q("0.304800001", "m"))).toEqual({
      ok: true,
      value: -1,
    });
    expect(compare(q("1", "us_gal"), q("1", "imp_gal"))).toEqual({
      ok: true,
      value: -1,
    });
  });

  it("compare across dimensions is incompatible_units", () => {
    expect(code(compare(q("1", "m"), q("1", "kg")))).toBe("incompatible_units");
    const cmp = compare as (
      a: unknown,
      b: unknown,
    ) => ReturnType<typeof compare>;
    expect(code(cmp(q("1", "m"), {}))).toBe("invalid_quantity");
  });

  it("equals ignores scale and is false across dimensions or for non-quantities", () => {
    expect(equals(q("12.5", "m"), q("12.500", "m"))).toBe(true);
    expect(equals(q("-0", "m"), q("0.00", "m"))).toBe(true);
    expect(equals(q("1", "ft"), q("12", "in"))).toBe(true);
    expect(equals(q("12.5", "m"), q("12.51", "m"))).toBe(false);
    expect(equals(q("1", "m"), q("1", "kg"))).toBe(false);
    const eq = equals as (a: unknown, b: unknown) => boolean;
    expect(eq(q("1", "m"), { coefficient: 1n, scale: 0, unit: "m" })).toBe(
      false,
    );
  });
});
