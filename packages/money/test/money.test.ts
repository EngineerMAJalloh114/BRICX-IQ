// Money values (P3-02 step 2): bigint minor units + ISO 4217 code, immutable,
// created only by factories that take a bigint or a string, never a number.
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  MAX_AMOUNT,
  MIN_AMOUNT,
  add,
  compare,
  equals,
  fromMajor,
  fromMinor,
  isMoney,
  isNegative,
  isPositive,
  isZero,
  multiply,
  negate,
  subtract,
  toMajorString,
  toMoneyJson,
  zero,
} from "../src/money.js";
import { Rounding } from "../src/rounding.js";
import { BHD, EUR, JPY, USD, expectMoneyError } from "./helpers.js";

describe("factories", () => {
  it("fromMinor takes a bigint or a canonical minor-unit string", () => {
    expect(fromMinor(1234n, USD)).toEqual({ amount: 1234n, currency: "USD" });
    expect(fromMinor("-1234", "USD").amount).toBe(-1234n);
    expect(fromMinor("0", USD).amount).toBe(0n);
  });

  it("fromMinor parses the currency string strictly", () => {
    expectMoneyError(() => fromMinor(1n, "usd"), "invalid_currency");
    expectMoneyError(() => fromMinor(1n, "SLL"), "historical_currency");
  });

  it("fromMinor rejects a JS number at run time (callers without types)", () => {
    expectMoneyError(
      () => fromMinor(12 as unknown as bigint, USD),
      "invalid_amount",
      ["12"],
    );
    expectMoneyError(
      () => fromMinor(1.5 as unknown as bigint, USD),
      "invalid_amount",
      ["1.5"],
    );
  });

  it.each([
    "1.5",
    "1e3",
    "+1",
    " 1",
    "1 ",
    "01",
    "-0",
    "",
    "-",
    "0x10",
    "1_000",
  ])("fromMinor rejects the string %j", (input) => {
    expectMoneyError(() => fromMinor(input, USD), "invalid_amount", [
      input.trim(),
    ]);
  });

  it("enforces the signed 64-bit range at both ends", () => {
    expect(fromMinor(MAX_AMOUNT, USD).amount).toBe(2n ** 63n - 1n);
    expect(fromMinor(MIN_AMOUNT, USD).amount).toBe(-(2n ** 63n));
    expectMoneyError(() => fromMinor(MAX_AMOUNT + 1n, USD), "out_of_range");
    expectMoneyError(() => fromMinor(MIN_AMOUNT - 1n, USD), "out_of_range");
    expectMoneyError(
      () => fromMinor("9223372036854775808", USD),
      "out_of_range",
      ["9223372036854775808"],
    );
  });

  it("fromMajor reads a decimal string using the currency exponent", () => {
    expect(fromMajor("12.34", USD).amount).toBe(1234n);
    expect(fromMajor("12.3", USD).amount).toBe(1230n);
    expect(fromMajor("12", USD).amount).toBe(1200n);
    expect(fromMajor("-0.5", USD).amount).toBe(-50n);
    expect(fromMajor("1234", JPY).amount).toBe(1234n);
    expect(fromMajor("1.234", BHD).amount).toBe(1234n);
  });

  it("fromMajor never rounds: more fraction digits than the exponent throws (D11)", () => {
    expectMoneyError(
      () => fromMajor("1.234", USD),
      "too_many_fraction_digits",
      ["1.234"],
    );
    expectMoneyError(() => fromMajor("1.5", JPY), "too_many_fraction_digits", [
      "1.5",
    ]);
  });

  it.each(["1e2", "+1", "01.5", "1.", ".5", "-0", "-0.00", " 1", "1,5", "abc"])(
    "fromMajor rejects %j",
    (input) => {
      expectMoneyError(() => fromMajor(input, USD), "invalid_amount", [
        input.trim(),
      ]);
    },
  );

  it("fromMajor rejects a non-string at run time", () => {
    expectMoneyError(
      () => fromMajor(12 as unknown as string, USD),
      "invalid_amount",
    );
  });

  it("zero", () => {
    expect(zero(EUR)).toEqual({ amount: 0n, currency: "EUR" });
  });
});

describe("immutability", () => {
  it("values are frozen; writes throw in strict mode", () => {
    const m = fromMinor(1n, USD);
    expect(Object.isFrozen(m)).toBe(true);
    expect(() => {
      (m as { amount: bigint }).amount = 2n;
    }).toThrow(TypeError);
    expect(m.amount).toBe(1n);
  });

  it("operations return new values and leave inputs unchanged", () => {
    const a = fromMinor(5n, USD);
    const b = fromMinor(7n, USD);
    const sum = add(a, b);
    expect(sum).not.toBe(a);
    expect(a.amount).toBe(5n);
    expect(b.amount).toBe(7n);
  });

  it("isMoney is true only for values made by the factories", () => {
    expect(isMoney(fromMinor(1n, USD))).toBe(true);
    expect(isMoney({ amount: 1n, currency: "USD" })).toBe(false);
    expect(isMoney(Object.freeze({ amount: 1n, currency: "USD" }))).toBe(false);
    expect(isMoney(null)).toBe(false);
  });

  it("operations reject look-alike objects", () => {
    const fake = { amount: 1n, currency: USD } as unknown as ReturnType<
      typeof zero
    >;
    expectMoneyError(() => add(fake, zero(USD)), "not_money");
  });
});

describe("arithmetic", () => {
  it("add and subtract", () => {
    expect(add(fromMinor(5n, USD), fromMinor(7n, USD)).amount).toBe(12n);
    expect(subtract(fromMinor(5n, USD), fromMinor(7n, USD)).amount).toBe(-2n);
  });

  it("add and subtract throw on a currency mismatch", () => {
    expectMoneyError(
      () => add(fromMinor(1n, USD), fromMinor(1n, EUR)),
      "currency_mismatch",
      ["USD", "EUR"],
    );
    expectMoneyError(
      () => subtract(fromMinor(1n, USD), fromMinor(1n, EUR)),
      "currency_mismatch",
    );
  });

  it("results outside 64 bits throw instead of wrapping", () => {
    expectMoneyError(
      () => add(fromMinor(MAX_AMOUNT, USD), fromMinor(1n, USD)),
      "out_of_range",
    );
    expectMoneyError(
      () => subtract(fromMinor(MIN_AMOUNT, USD), fromMinor(1n, USD)),
      "out_of_range",
    );
    expectMoneyError(() => negate(fromMinor(MIN_AMOUNT, USD)), "out_of_range");
  });

  it("negate", () => {
    expect(negate(fromMinor(5n, USD)).amount).toBe(-5n);
    expect(negate(zero(USD)).amount).toBe(0n);
  });

  it("compare, equals and sign tests", () => {
    const one = fromMinor(1n, USD);
    const two = fromMinor(2n, USD);
    expect(compare(one, two)).toBe(-1);
    expect(compare(two, one)).toBe(1);
    expect(compare(one, fromMinor(1n, USD))).toBe(0);
    expect(equals(one, fromMinor(1n, USD))).toBe(true);
    expect(equals(one, fromMinor(1n, EUR))).toBe(false);
    expectMoneyError(
      () => compare(one, fromMinor(1n, EUR)),
      "currency_mismatch",
    );
    expect(isZero(zero(USD))).toBe(true);
    expect(isNegative(fromMinor(-1n, USD))).toBe(true);
    expect(isPositive(one)).toBe(true);
    expect(isPositive(zero(USD))).toBe(false);
  });
});

describe("multiply(ratio, rounding)", () => {
  it("multiplies by a Decimal or a decimal string with the given rounding", () => {
    expect(
      multiply(fromMinor(1000n, USD), new Decimal("0.15"), Rounding.HALF_EVEN)
        .amount,
    ).toBe(150n);
    expect(multiply(fromMinor(5n, USD), "0.5", Rounding.HALF_EVEN).amount).toBe(
      2n,
    );
    expect(multiply(fromMinor(5n, USD), "0.5", Rounding.HALF_UP).amount).toBe(
      3n,
    );
    expect(multiply(fromMinor(5n, USD), "-0.5", Rounding.HALF_UP).amount).toBe(
      -3n,
    );
  });

  it.each([
    [Rounding.HALF_EVEN, 2n, -2n],
    [Rounding.HALF_UP, 3n, -3n],
    [Rounding.HALF_DOWN, 2n, -2n],
    [Rounding.UP, 3n, -3n],
    [Rounding.DOWN, 2n, -2n],
    [Rounding.CEILING, 3n, -2n],
    [Rounding.FLOOR, 2n, -3n],
  ])("%s rounds 2.5 to %s and -2.5 to %s", (mode, pos, neg) => {
    expect(multiply(fromMinor(5n, USD), "0.5", mode).amount).toBe(pos);
    expect(multiply(fromMinor(-5n, USD), "0.5", mode).amount).toBe(neg);
  });

  it("rounding is required: a missing or unknown mode throws", () => {
    expectMoneyError(
      () =>
        multiply(fromMinor(5n, USD), "0.5", undefined as unknown as Rounding),
      "invalid_rounding",
    );
    expectMoneyError(
      () =>
        multiply(fromMinor(5n, USD), "0.5", "BANKERS" as unknown as Rounding),
      "invalid_rounding",
      ["BANKERS"],
    );
  });

  it("rejects a JS number, a malformed string or a non-finite Decimal as the ratio", () => {
    expectMoneyError(
      () =>
        multiply(
          fromMinor(5n, USD),
          0.5 as unknown as string,
          Rounding.HALF_EVEN,
        ),
      "invalid_factor",
    );
    expectMoneyError(
      () => multiply(fromMinor(5n, USD), "1e2", Rounding.HALF_EVEN),
      "invalid_factor",
      ["1e2"],
    );
    expectMoneyError(
      () =>
        multiply(fromMinor(5n, USD), new Decimal(Infinity), Rounding.HALF_EVEN),
      "invalid_factor",
    );
  });

  it("is exact far above 2^53", () => {
    const big = fromMinor(9_007_199_254_740_993n, USD);
    expect(multiply(big, "3", Rounding.HALF_EVEN).amount).toBe(
      27_021_597_764_222_979n,
    );
    expectMoneyError(
      () => multiply(fromMinor(MAX_AMOUNT, USD), "2", Rounding.DOWN),
      "out_of_range",
    );
  });
});

describe("serialisation", () => {
  it("toMoneyJson carries the amount as a string of minor units", () => {
    expect(toMoneyJson(fromMinor(-1234n, USD))).toEqual({
      amount: "-1234",
      currency: "USD",
    });
    expect(JSON.stringify(toMoneyJson(fromMinor(MAX_AMOUNT, USD)))).toBe(
      '{"amount":"9223372036854775807","currency":"USD"}',
    );
  });

  it("toMajorString is exact for every exponent", () => {
    expect(toMajorString(fromMinor(1234n, USD))).toBe("12.34");
    expect(toMajorString(fromMinor(-5n, USD))).toBe("-0.05");
    expect(toMajorString(fromMinor(1234n, JPY))).toBe("1234");
    expect(toMajorString(fromMinor(1n, BHD))).toBe("0.001");
    expect(toMajorString(fromMinor(MIN_AMOUNT, USD))).toBe(
      "-92233720368547758.08",
    );
  });
});
