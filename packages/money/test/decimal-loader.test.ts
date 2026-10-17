// decimalConstructor() (P4-08, ADR 0058): the decimal.js constructor is
// taken from the module's `default` whatever the loader (decimal.mjs's
// default here; the UMD build's Decimal.default is Metro's case, P7);
// anything else fails at load with a TypeError.
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { D, decimalConstructor } from "../src/decimal.js";

describe("decimalConstructor", () => {
  it("returns the decimal.js constructor and the module uses it", () => {
    expect(decimalConstructor(Decimal)).toBe(Decimal);
    expect(Decimal.isDecimal(new D("1.5"))).toBe(true);
    expect(new D(1).div(3).precision()).toBe(64);
  });

  it("refuses a module namespace, undefined or a plain function", () => {
    for (const bad of [
      { default: Decimal },
      undefined,
      () => 1,
      Decimal.ROUND_HALF_EVEN,
    ]) {
      expect(() => decimalConstructor(bad)).toThrow(TypeError);
    }
  });
});
