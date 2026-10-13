// format (P3-02 step 4): Intl.NumberFormat with the fraction digits taken
// from the currency exponent. The formatter is given the exact major-unit
// decimal string (Intl.NumberFormat v3 formats strings exactly), so no float
// is involved and amounts above 2^53 print every digit. P7 must confirm the
// client runtime (Hermes) accepts string input (D10, for architect review).
import { currencyExponent } from "./currency.js";
import { MoneyError } from "./errors.js";
import { isMoney, toMajorString } from "./money.js";
import type { Money } from "./money.js";

export interface FormatOptions {
  /** How the currency is shown: "symbol" (default), "narrowSymbol", "code" or "name". */
  readonly currencyDisplay?: "symbol" | "narrowSymbol" | "code" | "name";
}

export function formatMoney(
  money: Money,
  locale: string,
  options: FormatOptions = {},
): string {
  if (!isMoney(money)) throw new MoneyError("not_money");
  const exponent = currencyExponent(money.currency);
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: money.currency,
      currencyDisplay: options.currencyDisplay ?? "symbol",
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    });
  } catch {
    throw new MoneyError("invalid_locale");
  }
  // Intl's string input is typed as `number | bigint` in TS 5.9's lib; the
  // runtime accepts a decimal string (ECMA-402 Intl.NumberFormat v3).
  return formatter.format(toMajorString(money) as unknown as bigint);
}
