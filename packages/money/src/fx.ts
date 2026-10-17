// convert (P3-02 step 3): `rate` is target major units per one source major
// unit. The result in target minor units is
//     amount · rate · 10^(e_target − e_source)
// computed exactly (64-digit precision holds 19 + 24 digits), then rounded
// once with `rounding` (default HALF_EVEN, the only default in the package).
// The rate must fit the NUMERIC(24,12) column it is stored in, so the stored
// rate is exactly the rate used; nothing is rounded silently.
import { currencyExponent, parseCurrencyCode } from "./currency.js";
import type { CurrencyCode } from "./currency.js";
import { D, decimalRounding, parseDecimal, toBigInt } from "./decimal.js";
import type { DecimalLimits } from "./decimal.js";
import { MoneyError } from "./errors.js";
import { fromMinor, isMoney } from "./money.js";
import type { DecimalLike, Money } from "./money.js";
import { Rounding } from "./rounding.js";

export const RATE_INTEGER_DIGITS = 12;
export const RATE_FRACTION_DIGITS = 12;

const RATE_LIMITS: DecimalLimits = {
  signed: false,
  integerDigits: RATE_INTEGER_DIGITS,
  fractionDigits: RATE_FRACTION_DIGITS,
  totalDigits: RATE_INTEGER_DIGITS + RATE_FRACTION_DIGITS,
  invalid: "invalid_rate",
  precision: "rate_precision",
};

export interface Conversion {
  readonly money: Money;
  /** The rate as a normalised plain decimal string ("1.25"). */
  readonly rateUsed: string;
}

/**
 * A positive rate that fits NUMERIC(24,12). Trailing fraction zeros carry no
 * value and are not counted ("1.50" has one fraction digit).
 */
export function parseRate(rate: unknown): D {
  const d = parseDecimal(rate, RATE_LIMITS);
  if (!d.isPositive() || d.isZero()) throw new MoneyError("invalid_rate");
  return d;
}

export function convert(
  money: Money,
  rate: DecimalLike,
  target: CurrencyCode | string,
  rounding: Rounding = Rounding.HALF_EVEN,
): Conversion {
  if (!isMoney(money)) throw new MoneyError("not_money");
  const mode = decimalRounding(rounding);
  const r = parseRate(rate);
  const code = parseCurrencyCode(target);
  const shift = currencyExponent(code) - currencyExponent(money.currency);
  const exact = new D(money.amount.toString()).mul(r).mul(new D(10).pow(shift));
  return Object.freeze({
    money: fromMinor(toBigInt(exact, mode), code),
    rateUsed: r.toFixed(),
  });
}
