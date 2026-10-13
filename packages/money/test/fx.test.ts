// convert (P3-02 step 3; his change 4): rate = target major units per one
// source major unit, Decimal or decimal string, > 0, must fit NUMERIC(24,12);
// rounding defaults to HALF_EVEN only here; returns { money, rateUsed }.
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { convert } from "../src/fx.js";
import { MAX_AMOUNT, fromMinor } from "../src/money.js";
import { Rounding } from "../src/rounding.js";
import { BHD, EUR, JPY, USD, expectMoneyError } from "./helpers.js";

describe("convert", () => {
  it("scales by the rate and both exponents", () => {
    expect(convert(fromMinor(1234n, USD), "150", JPY)).toEqual({
      money: { amount: 1851n, currency: "JPY" },
      rateUsed: "150",
    });
    expect(
      convert(fromMinor(1000n, USD), new Decimal("0.376"), BHD).money.amount,
    ).toBe(3760n);
    expect(convert(fromMinor(1000n, JPY), "0.0066666", USD).money.amount).toBe(
      667n,
    );
  });

  it("defaults to HALF_EVEN and honours an explicit mode", () => {
    expect(convert(fromMinor(5n, USD), "0.5", EUR).money.amount).toBe(2n);
    expect(convert(fromMinor(7n, USD), "0.5", EUR).money.amount).toBe(4n);
    expect(
      convert(fromMinor(5n, USD), "0.5", EUR, Rounding.HALF_UP).money.amount,
    ).toBe(3n);
    expect(
      convert(fromMinor(-5n, USD), "0.5", EUR, Rounding.FLOOR).money.amount,
    ).toBe(-3n);
  });

  it("an unknown rounding mode throws", () => {
    expectMoneyError(
      () =>
        convert(
          fromMinor(5n, USD),
          "0.5",
          EUR,
          "NEAREST" as unknown as Rounding,
        ),
      "invalid_rounding",
    );
  });

  it("returns frozen Money and the rate as a normalised decimal string", () => {
    const { money, rateUsed } = convert(fromMinor(5n, USD), "1.250000", EUR);
    expect(Object.isFrozen(money)).toBe(true);
    expect(rateUsed).toBe("1.25");
  });

  it("parses the target currency strictly", () => {
    expectMoneyError(
      () => convert(fromMinor(5n, USD), "1", "SLL"),
      "historical_currency",
    );
    expectMoneyError(
      () => convert(fromMinor(5n, USD), "1", "eur"),
      "invalid_currency",
    );
  });

  it("is exact far above 2^53 and range-checks the result", () => {
    expect(
      convert(fromMinor(9_007_199_254_740_993n, USD), "1", EUR).money.amount,
    ).toBe(9_007_199_254_740_993n);
    expectMoneyError(
      () => convert(fromMinor(MAX_AMOUNT, USD), "2", EUR),
      "out_of_range",
    );
  });
});

describe("rate limits: NUMERIC(24,12), never rounded silently (his change 4)", () => {
  it("12 integer digits + 12 fraction digits is accepted", () => {
    const rate = "123456789012.123456789012";
    expect(convert(fromMinor(1n, JPY), rate, JPY, Rounding.DOWN).rateUsed).toBe(
      rate,
    );
    expect(
      convert(fromMinor(1n, JPY), "0.000000000001", JPY, Rounding.UP).rateUsed,
    ).toBe("0.000000000001");
  });

  it("13 fraction digits throws", () => {
    expectMoneyError(
      () => convert(fromMinor(1n, USD), "0.0000000000001", EUR),
      "rate_precision",
      ["0.0000000000001"],
    );
    expectMoneyError(
      () => convert(fromMinor(1n, USD), new Decimal("1.1234567890123"), EUR),
      "rate_precision",
    );
  });

  it("13 integer digits throws (more than 24 total digits cannot fit either)", () => {
    expectMoneyError(
      () => convert(fromMinor(1n, USD), "1234567890123", EUR),
      "rate_precision",
    );
    expectMoneyError(
      () => convert(fromMinor(1n, USD), "1234567890123.123456789012", EUR),
      "rate_precision",
    );
  });

  it("trailing fraction zeros carry no value and are not counted", () => {
    expect(
      convert(fromMinor(1n, USD), "1.0000000000000000", EUR).rateUsed,
    ).toBe("1");
  });

  it.each(["0", "0.0", "-1", "1e3", "+1", ".5", "1.", "", "abc", " 1"])(
    "rejects the rate %j",
    (rate) => {
      expectMoneyError(
        () => convert(fromMinor(1n, USD), rate, EUR),
        "invalid_rate",
        [rate.trim()],
      );
    },
  );

  it("rejects a JS number, a zero, negative or non-finite Decimal", () => {
    expectMoneyError(
      () => convert(fromMinor(1n, USD), 1.1 as unknown as string, EUR),
      "invalid_rate",
    );
    expectMoneyError(
      () => convert(fromMinor(1n, USD), new Decimal(0), EUR),
      "invalid_rate",
    );
    expectMoneyError(
      () => convert(fromMinor(1n, USD), new Decimal(-2), EUR),
      "invalid_rate",
    );
    expectMoneyError(
      () => convert(fromMinor(1n, USD), new Decimal(NaN), EUR),
      "invalid_rate",
    );
    expectMoneyError(
      () => convert(fromMinor(1n, USD), new Decimal(Infinity), EUR),
      "invalid_rate",
    );
  });
});
