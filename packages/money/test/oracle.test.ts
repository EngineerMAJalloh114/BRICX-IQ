// Oracle property tests (architect review of PR #35, item 3): multiply and
// convert against a plain bigint rational reference, all seven rounding
// modes, signed amounts, factors and rates within and beyond the limits.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { convert } from "../src/fx.js";
import { multiply } from "../src/money.js";
import { Rounding } from "../src/rounding.js";
import {
  ALL_MODES,
  checkConvert,
  checkMultiply,
  digitCounts,
  factorLongArb,
  factorOverArb,
  factorTieArb,
  factorWithinArb,
  rateLongArb,
  rateWithinArb,
  roundDiv,
} from "./oracle.js";

describe("the reference itself", () => {
  it("rounds ±2.5, ±1.5 and ±0.4 like decimal.js's seven modes", () => {
    const table: Record<Rounding, readonly bigint[]> = {
      [Rounding.HALF_EVEN]: [2n, -2n, 2n, -2n, 0n, 0n],
      [Rounding.HALF_UP]: [3n, -3n, 2n, -2n, 0n, 0n],
      [Rounding.HALF_DOWN]: [2n, -2n, 1n, -1n, 0n, 0n],
      [Rounding.UP]: [3n, -3n, 2n, -2n, 1n, -1n],
      [Rounding.DOWN]: [2n, -2n, 1n, -1n, 0n, 0n],
      [Rounding.CEILING]: [3n, -2n, 2n, -1n, 1n, 0n],
      [Rounding.FLOOR]: [2n, -3n, 1n, -2n, 0n, -1n],
    };
    const cases = [25n, -25n, 15n, -15n, 4n, -4n];
    for (const mode of ALL_MODES)
      expect(cases.map((n) => roundDiv(n, 10n, mode))).toEqual(table[mode]);
  });

  it("counts significant integer and fraction digits", () => {
    expect(digitCounts("-0.500")).toEqual({ integer: 0, fraction: 1 });
    expect(digitCounts("120.0")).toEqual({ integer: 3, fraction: 0 });
  });
});

describe("multiply matches the bigint oracle (all 7 modes)", () => {
  it("factors within 12 + 12 digits (1,000 cases)", () => {
    checkMultiply(multiply, factorWithinArb, 1000);
  });
  it("ties and near ties within the limits (1,000 cases)", () => {
    checkMultiply(multiply, factorTieArb, 1000);
  });
  it("factors beyond the limits are rejected with factor_precision (500 cases)", () => {
    checkMultiply(multiply, fc.oneof(factorLongArb, factorOverArb), 500);
  });
});

describe("convert matches the bigint oracle (all 7 modes)", () => {
  it("rates within NUMERIC(24,12) across exponent pairs (1,000 cases)", () => {
    checkConvert(convert, rateWithinArb, 1000);
  });
  it("rates beyond the limits are rejected with rate_precision (500 cases)", () => {
    checkConvert(convert, rateLongArb, 500);
  });
});
