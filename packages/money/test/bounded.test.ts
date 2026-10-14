// Bounded decimal inputs (architect review of PR #35, items 1 and 2): every
// factor, rate and ratio is checked for length, digits and exponent before
// any toFixed() or BigInt parse, so a long or huge-exponent input is
// rejected at once and a factor never needs more than one rounding.
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { allocate } from "../src/allocate.js";
import { convert } from "../src/fx.js";
import { fromMinor, multiply } from "../src/money.js";
import { Rounding } from "../src/rounding.js";
import { EUR, USD, expectMoneyError } from "./helpers.js";

const one = fromMinor(1n, USD);
const MS = 50;

/** Runs `fn`, which must throw `code`, and asserts it took under 50 ms. */
function rejectsQuickly(
  fn: () => unknown,
  code: Parameters<typeof expectMoneyError>[1],
): void {
  const start = performance.now();
  expectMoneyError(fn, code);
  expect(performance.now() - start).toBeLessThan(MS);
}

describe("multiply: the 70-digit tie case is rejected, not double-rounded", () => {
  const factor = `0.4${"9".repeat(69)}`;
  it("factor 0.4 followed by 69 nines throws factor_precision (exact answer would be 0, double rounding gave 1)", () => {
    expectMoneyError(
      () => multiply(one, factor, Rounding.HALF_UP),
      "factor_precision",
      [factor],
    );
  });
  it("the same near tie within 12 fraction digits rounds once, exactly", () => {
    expect(multiply(one, "0.499999999999", Rounding.HALF_UP).amount).toBe(0n);
    expect(multiply(one, "0.5", Rounding.HALF_UP).amount).toBe(1n);
  });
});

describe("factor limits: 12 integer + 12 fraction digits, signed", () => {
  it("12 + 12 digits is accepted at the boundary, both signs, string and Decimal", () => {
    const max = "999999999999.999999999999";
    expect(multiply(one, max, Rounding.DOWN).amount).toBe(999999999999n);
    expect(multiply(one, `-${max}`, Rounding.DOWN).amount).toBe(-999999999999n);
    expect(multiply(one, new Decimal(max), Rounding.UP).amount).toBe(
      1000000000000n,
    );
  });
  it("13 integer digits throws factor_precision", () => {
    expectMoneyError(
      () => multiply(one, "1000000000000", Rounding.DOWN),
      "factor_precision",
      ["1000000000000"],
    );
    expectMoneyError(
      () => multiply(one, new Decimal("1000000000000"), Rounding.DOWN),
      "factor_precision",
    );
  });
  it("13 fraction digits throws factor_precision", () => {
    expectMoneyError(
      () => multiply(one, "0.1234567890123", Rounding.DOWN),
      "factor_precision",
      ["0.1234567890123"],
    );
    expectMoneyError(
      () => multiply(one, new Decimal("-0.0000000000001"), Rounding.DOWN),
      "factor_precision",
    );
  });
  it("trailing fraction zeros are not counted, up to the 80-character cap", () => {
    const eighty = `1.${"0".repeat(78)}`;
    expect(eighty).toHaveLength(80);
    expect(multiply(one, eighty, Rounding.DOWN).amount).toBe(1n);
    expectMoneyError(
      () => multiply(one, `${eighty}0`, Rounding.DOWN),
      "invalid_factor",
    );
  });
});

describe("huge exponents are rejected before any toFixed (under 50 ms)", () => {
  for (const text of ["1e+5000000", "-1e+5000000", "1e-5000000"]) {
    const huge = new Decimal(text);
    it(`${text} as a factor`, () => {
      rejectsQuickly(
        () => multiply(one, huge, Rounding.HALF_EVEN),
        "factor_precision",
      );
    });
    if (!text.startsWith("-")) {
      it(`${text} as a rate`, () => {
        rejectsQuickly(() => convert(one, huge, EUR), "rate_precision");
      });
      it(`${text} as a ratio`, () => {
        rejectsQuickly(() => allocate(one, [huge, 1n]), "invalid_ratio");
      });
    }
  }
});

describe("a 1 MB string is rejected by the length cap (under 50 ms)", () => {
  const mb = "1".repeat(1_000_000);
  const mbFraction = `0.${"0".repeat(1_000_000)}1`;
  it("as a factor", () => {
    rejectsQuickly(() => multiply(one, mb, Rounding.DOWN), "invalid_factor");
    rejectsQuickly(
      () => multiply(one, mbFraction, Rounding.DOWN),
      "invalid_factor",
    );
  });
  it("as a rate", () => {
    rejectsQuickly(() => convert(one, mb, EUR), "invalid_rate");
    rejectsQuickly(() => convert(one, mbFraction, EUR), "invalid_rate");
  });
  it("as a ratio", () => {
    rejectsQuickly(() => allocate(one, [mb]), "invalid_ratio");
    rejectsQuickly(() => allocate(one, [mbFraction]), "invalid_ratio");
  });
});

describe("ratios keep the 64-digit cap, checked first", () => {
  it("64 digits is accepted, 65 is rejected (string, Decimal, bigint)", () => {
    const d64 = "9".repeat(64);
    expect(
      allocate(fromMinor(2n, USD), [d64, d64]).map((p) => p.amount),
    ).toEqual([1n, 1n]);
    expect(
      allocate(fromMinor(2n, USD), [new Decimal(d64), 10n ** 64n - 1n]),
    ).toHaveLength(2);
    expectMoneyError(() => allocate(one, [`${d64}9`]), "invalid_ratio");
    expectMoneyError(
      () => allocate(one, [new Decimal(`${d64}9`)]),
      "invalid_ratio",
    );
    expectMoneyError(() => allocate(one, [10n ** 64n]), "invalid_ratio");
    expectMoneyError(
      () => allocate(one, [`0.${"1".repeat(63)}`, `0.${"1".repeat(64)}`]),
      "invalid_ratio",
    );
  });
});
