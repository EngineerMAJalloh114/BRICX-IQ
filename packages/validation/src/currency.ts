// CurrencySchema (P3-04 D6): an ISO 4217 code that can form Money, checked
// by @bricx/money's parseCurrencyCode; the rules are never redefined here.
// Issue messages are @bricx/money's own codes (invalid_currency,
// historical_currency, no_minor_unit), which the envelope reports as
// money.<code> with the errors:money.<code> key.
import { parseCurrencyCode } from "@bricx/money/currency";
import type { CurrencyCode } from "@bricx/money/currency";
import { MoneyError } from "@bricx/money/errors";
import { boundedString } from "./bounded.ts";
import { FORMATS } from "./formats.ts";

/** The MoneyError code parseCurrencyCode throws for `value`. */
function currencyIssue(value: string): string {
  try {
    parseCurrencyCode(value);
    return "invalid_currency";
  } catch (error) {
    return error instanceof MoneyError ? error.code : "invalid_currency";
  }
}

export const CurrencySchema = boundedString(
  FORMATS.currency,
  "invalid_currency",
  currencyIssue,
).transform((value): CurrencyCode => parseCurrencyCode(value));

export type { CurrencyCode };
