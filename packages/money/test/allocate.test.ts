// allocate (P3-02 ruling + his change 5): largest remainder, ties to the
// lowest index, parts sum exactly, zero and negative totals handled, ratios
// summing to zero throw.
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { allocate } from "../src/allocate.js";
import { fromMinor, zero } from "../src/money.js";
import { JPY, TWO_POW_53, USD, expectMoneyError } from "./helpers.js";

const amounts = (parts: readonly { amount: bigint }[]) =>
  parts.map((p) => p.amount);

describe("allocate", () => {
  it("zero total gives all zeros", () => {
    expect(amounts(allocate(zero(USD), [1n, 2n, 3n]))).toEqual([0n, 0n, 0n]);
  });

  it("negative total is allocated on its absolute value and negated (symmetric)", () => {
    expect(amounts(allocate(fromMinor(-100n, USD), [1n, 1n, 1n]))).toEqual([
      -34n,
      -33n,
      -33n,
    ]);
    expect(amounts(allocate(fromMinor(-5n, USD), ["0.3", "0.7"]))).toEqual([
      -2n,
      -3n,
    ]);
  });

  it("a single ratio returns the whole amount", () => {
    expect(amounts(allocate(fromMinor(12345n, USD), [7n]))).toEqual([12345n]);
    expect(amounts(allocate(fromMinor(12345n, USD), ["0.0001"]))).toEqual([
      12345n,
    ]);
  });

  it("a zero ratio gets nothing, even when there is a remainder", () => {
    expect(amounts(allocate(fromMinor(100n, USD), [1n, 0n, 1n, 1n]))).toEqual([
      34n,
      0n,
      33n,
      33n,
    ]);
    expect(amounts(allocate(fromMinor(1n, USD), [0n, 1n]))).toEqual([0n, 1n]);
  });

  it("equal ratios with a remainder: ties go to the lowest index", () => {
    expect(amounts(allocate(fromMinor(100n, USD), [1n, 1n, 1n]))).toEqual([
      34n,
      33n,
      33n,
    ]);
    expect(amounts(allocate(fromMinor(5n, USD), [1n, 1n, 1n]))).toEqual([
      2n,
      2n,
      1n,
    ]);
    expect(
      amounts(allocate(fromMinor(10n, USD), ["0.25", "0.25", "0.25", "0.25"])),
    ).toEqual([3n, 3n, 2n, 2n]);
  });

  it("the largest remainder wins over a lower index", () => {
    // Exact shares 3.3, 3.6, 3.1 (total 10): floors 3,3,3; the single extra unit
    // goes to index 1 (remainder .6).
    expect(amounts(allocate(fromMinor(10n, USD), ["33", "36", "31"]))).toEqual([
      3n,
      4n,
      3n,
    ]);
  });

  it("a total smaller than the number of parts", () => {
    expect(amounts(allocate(fromMinor(2n, USD), [1n, 1n, 1n, 1n, 1n]))).toEqual(
      [1n, 1n, 0n, 0n, 0n],
    );
    expect(amounts(allocate(fromMinor(-2n, JPY), [1n, 1n, 1n]))).toEqual([
      -1n,
      -1n,
      0n,
    ]);
  });

  it("a total above 2^53 is split exactly", () => {
    const total = TWO_POW_53 * 1000n + 8n;
    const parts = allocate(fromMinor(total, USD), [1n, 1n, 1n]);
    expect(amounts(parts)).toEqual([
      3_002_399_751_580_330_670n,
      3_002_399_751_580_330_669n,
      3_002_399_751_580_330_669n,
    ]);
    expect(amounts(parts).reduce((a, b) => a + b, 0n)).toBe(total);
  });

  it("accepts bigint, decimal-string and Decimal ratios together", () => {
    expect(
      amounts(allocate(fromMinor(100n, USD), [1n, "1.0", new Decimal(2)])),
    ).toEqual([25n, 25n, 50n]);
  });

  it("returns frozen parts in the source currency", () => {
    const parts = allocate(fromMinor(10n, JPY), [1n, 1n]);
    expect(parts.every((p) => p.currency === "JPY" && Object.isFrozen(p))).toBe(
      true,
    );
  });

  it("ratios summing to zero throw", () => {
    expectMoneyError(
      () => allocate(fromMinor(10n, USD), [0n, 0n]),
      "ratios_sum_zero",
    );
    expectMoneyError(
      () => allocate(zero(USD), ["0", "0.0"]),
      "ratios_sum_zero",
    );
  });

  it("no ratios throws", () => {
    expectMoneyError(() => allocate(fromMinor(10n, USD), []), "no_ratios");
  });

  it("a negative ratio throws", () => {
    expectMoneyError(
      () => allocate(fromMinor(10n, USD), [1n, -1n]),
      "negative_ratio",
    );
    expectMoneyError(
      () => allocate(fromMinor(10n, USD), ["-0.5", "1"]),
      "negative_ratio",
      ["-0.5"],
    );
    expectMoneyError(
      () => allocate(fromMinor(10n, USD), [new Decimal(-1), 1n]),
      "negative_ratio",
    );
  });

  it("a JS number, malformed string or non-finite Decimal ratio throws", () => {
    expectMoneyError(
      () => allocate(fromMinor(10n, USD), [1 as unknown as bigint]),
      "invalid_ratio",
    );
    expectMoneyError(
      () => allocate(fromMinor(10n, USD), ["1e3"]),
      "invalid_ratio",
      ["1e3"],
    );
    expectMoneyError(
      () => allocate(fromMinor(10n, USD), [new Decimal(NaN)]),
      "invalid_ratio",
    );
    expectMoneyError(
      () => allocate(fromMinor(10n, USD), ["1".repeat(70)]),
      "invalid_ratio",
    );
  });
});
