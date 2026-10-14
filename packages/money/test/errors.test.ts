// MoneyError (P3 rule 9): a code and a fixed message chosen by the code;
// never the input, no `cause`.
import { describe, expect, it } from "vitest";
import { MONEY_ERROR_CODES, MoneyError } from "../src/errors.js";
import type { MoneyErrorCode } from "../src/errors.js";

const codes: readonly MoneyErrorCode[] = [
  "invalid_amount",
  "amount_not_string",
  "out_of_range",
  "too_many_fraction_digits",
  "invalid_currency",
  "historical_currency",
  "no_minor_unit",
  "currency_mismatch",
  "not_money",
  "invalid_rounding",
  "invalid_factor",
  "factor_precision",
  "invalid_rate",
  "rate_precision",
  "invalid_ratio",
  "negative_ratio",
  "ratios_sum_zero",
  "no_ratios",
  "invalid_locale",
];

describe("MoneyError", () => {
  it.each(codes)("%s has a fixed message starting with the code", (code) => {
    const error = new MoneyError(code);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("MoneyError");
    expect(error.code).toBe(code);
    expect(error.message.startsWith(`${code}: `)).toBe(true);
    expect(error.message.length).toBeGreaterThan(code.length + 2);
    expect("cause" in error).toBe(false);
  });

  it("messages are distinct", () => {
    const messages = codes.map((c) => new MoneyError(c).message);
    expect(new Set(messages).size).toBe(codes.length);
  });
});

// P3-04 (ADR 0047, architect change 7): the codes as data, so
// @bricx/validation can check that every code has an errors:money.<code>
// i18n key. src/errors.ts also asserts at compile time that the array and
// the MoneyErrorCode union agree in both directions; types-sabotage.test.ts
// proves that assertion fires.
describe("MONEY_ERROR_CODES", () => {
  it("lists every code exactly once, in the union's order", () => {
    expect([...MONEY_ERROR_CODES]).toEqual(codes);
  });

  it("is frozen", () => {
    expect(Object.isFrozen(MONEY_ERROR_CODES)).toBe(true);
  });

  it("every listed code builds a MoneyError with that code", () => {
    for (const code of MONEY_ERROR_CODES) {
      expect(new MoneyError(code).code).toBe(code);
    }
  });
});
