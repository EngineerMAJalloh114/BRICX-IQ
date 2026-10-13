// MoneyError (P3 rule 9): a code and a fixed message chosen by the code;
// never the input, no `cause`.
import { describe, expect, it } from "vitest";
import { MoneyError } from "../src/errors.js";
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
