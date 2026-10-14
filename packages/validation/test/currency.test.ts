// CurrencySchema (P3-04 D6): wraps @bricx/money's parseCurrencyCode; never
// redefines the ISO 4217 rules. Issue messages are MoneyError codes, which
// the envelope maps to errors:money.<code>.
import { listCurrencies } from "@bricx/money/currency";
import { describe, expect, it } from "vitest";
import { CurrencySchema } from "../src/currency.ts";
import { expectRejectedWithoutEcho, messageOf, parsed } from "./helpers.ts";

describe("CurrencySchema", () => {
  it("accepts every currency money lists, and only as itself", () => {
    for (const { code } of listCurrencies()) {
      expect(parsed(CurrencySchema, code)).toBe(code);
    }
  });

  it.each([
    ["SLE", "SLE"],
    ["JPY", "JPY"],
    ["BHD", "BHD"],
  ])("accepts %s", (input, output) => {
    expect(parsed(CurrencySchema, input)).toBe(output);
  });

  it.each([
    ["lowercase", "usd", "invalid_currency"],
    ["unknown", "ABC", "invalid_currency"],
    ["trailing space", "USD ", "invalid_currency"],
    ["empty", "", "invalid_currency"],
    ["historical SLL", "SLL", "historical_currency"],
    ["no minor unit XAU", "XAU", "no_minor_unit"],
  ])("rejects %s as %s", (_label, input, code) => {
    expect(expectRejectedWithoutEcho(CurrencySchema, input)).toEqual([code]);
  });

  it("rejects a long string before any lookup", () => {
    expect(messageOf(CurrencySchema, "U".repeat(1000))).toBe(
      "invalid_currency",
    );
  });

  it("rejects a non-string", () => {
    expect(messageOf(CurrencySchema, 840)).toBe("invalid_currency");
  });
});
