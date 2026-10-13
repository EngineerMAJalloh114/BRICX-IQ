// Money (P3-02 step 2): bigint minor units + ISO 4217 code. Values are
// frozen and branded; only the factories here create them, and none takes
// a JS number (P3 rule 8). Every result must fit Postgres bigint (signed
// 64 bits) or the operation throws out_of_range.
import { currencyExponent, parseCurrencyCode } from "./currency.js";
import type { CurrencyCode } from "./currency.js";
import { D, decimalRounding, toBigInt, toDecimal } from "./decimal.js";
import { MoneyError } from "./errors.js";
import type { Rounding } from "./rounding.js";

declare const moneyBrand: unique symbol;

export interface Money {
  /** Minor units (cents for USD, fils for BHD, yen for JPY). */
  readonly amount: bigint;
  readonly currency: CurrencyCode;
  readonly [moneyBrand]: true;
}

/** Money on the wire: the amount is a string of minor units. */
export interface MoneyJson {
  readonly amount: string;
  readonly currency: string;
}

/** A Decimal or a plain decimal string ("0.15", "-2"); never a JS number. */
export type DecimalLike = InstanceType<typeof D> | string;

export const MAX_AMOUNT = 2n ** 63n - 1n;
export const MIN_AMOUNT = -(2n ** 63n);

/** Canonical minor units: optional "-", no "+", no leading zeros, no "-0". */
const MINOR = /^(?:0|-?[1-9]\d*)$/;
/** A major amount: the same integer part, then an optional fraction. */
const MAJOR = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

const made = new WeakSet<object>();

function checkRange(amount: bigint): bigint {
  if (amount > MAX_AMOUNT || amount < MIN_AMOUNT)
    throw new MoneyError("out_of_range");
  return amount;
}

function create(amount: bigint, currency: CurrencyCode): Money {
  const value = Object.freeze({
    amount: checkRange(amount),
    currency,
  }) as Money;
  made.add(value);
  return value;
}

/** True only for values made by this module (not for look-alike objects). */
export const isMoney = (value: unknown): value is Money =>
  typeof value === "object" && value !== null && made.has(value);

function own(value: Money): Money {
  if (!isMoney(value)) throw new MoneyError("not_money");
  return value;
}

function same(a: Money, b: Money): CurrencyCode {
  own(a);
  own(b);
  if (a.currency !== b.currency) throw new MoneyError("currency_mismatch");
  return a.currency;
}

/** Parses canonical minor units; the result is range-checked by create(). */
export function parseMinor(amount: unknown): bigint {
  if (typeof amount === "bigint") return amount;
  if (typeof amount === "string" && MINOR.test(amount)) {
    // More than 20 characters cannot fit 64 bits; skip the BigInt parse.
    if (amount.length > 20) throw new MoneyError("out_of_range");
    return BigInt(amount);
  }
  throw new MoneyError("invalid_amount");
}

/** Money from minor units: a bigint, or a canonical string such as "-1234". */
export function fromMinor(
  amount: bigint | string,
  currency: CurrencyCode | string,
): Money {
  return create(parseMinor(amount), parseCurrencyCode(currency));
}

/**
 * Money from a major-unit decimal string ("12.34" USD -> 1234n). More
 * fraction digits than the exponent throws; nothing is rounded.
 */
export function fromMajor(
  amount: string,
  currency: CurrencyCode | string,
): Money {
  const code = parseCurrencyCode(currency);
  if (typeof amount !== "string" || !MAJOR.test(amount))
    throw new MoneyError("invalid_amount");
  const negative = amount.startsWith("-");
  const [whole = "", fraction = ""] = (
    negative ? amount.slice(1) : amount
  ).split(".");
  const exponent = currencyExponent(code);
  if (fraction.length > exponent)
    throw new MoneyError("too_many_fraction_digits");
  const digits = `${whole}${fraction.padEnd(exponent, "0")}`;
  if (digits.length > 20) throw new MoneyError("out_of_range");
  const magnitude = BigInt(digits);
  if (negative && magnitude === 0n) throw new MoneyError("invalid_amount");
  return create(negative ? -magnitude : magnitude, code);
}

export const zero = (currency: CurrencyCode | string): Money =>
  create(0n, parseCurrencyCode(currency));

/** a + b; throws currency_mismatch or out_of_range. */
export const add = (a: Money, b: Money): Money =>
  create(a.amount + b.amount, same(a, b));

/** a - b; throws currency_mismatch or out_of_range. */
export const subtract = (a: Money, b: Money): Money =>
  create(a.amount - b.amount, same(a, b));

export const negate = (a: Money): Money => create(-own(a).amount, a.currency);

/** -1, 0 or 1; throws currency_mismatch. */
export function compare(a: Money, b: Money): -1 | 0 | 1 {
  same(a, b);
  return a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0;
}

/** Same currency and amount. */
export const equals = (a: Money, b: Money): boolean =>
  own(a).currency === own(b).currency && a.amount === b.amount;

export const isZero = (a: Money): boolean => own(a).amount === 0n;
export const isNegative = (a: Money): boolean => own(a).amount < 0n;
export const isPositive = (a: Money): boolean => own(a).amount > 0n;

/**
 * amount × factor, rounded to a whole minor unit with `rounding` (no
 * default). The factor is a Decimal or a plain decimal string.
 */
export function multiply(
  a: Money,
  factor: DecimalLike,
  rounding: Rounding,
): Money {
  own(a);
  const mode = decimalRounding(rounding);
  const f = toDecimal(factor, "invalid_factor", true);
  return create(toBigInt(new D(a.amount.toString()).mul(f), mode), a.currency);
}

/** The exact major-unit decimal string: 1234n USD -> "12.34", 1n BHD -> "0.001". */
export function toMajorString(a: Money): string {
  const exponent = currencyExponent(own(a).currency);
  const negative = a.amount < 0n;
  const digits = (negative ? -a.amount : a.amount)
    .toString()
    .padStart(exponent + 1, "0");
  const whole = digits.slice(0, digits.length - exponent);
  const fraction = digits.slice(digits.length - exponent);
  return `${negative ? "-" : ""}${whole}${exponent > 0 ? `.${fraction}` : ""}`;
}

/** The wire form: { amount: "-1234", currency: "USD" }. */
export const toMoneyJson = (a: Money): MoneyJson =>
  Object.freeze({ amount: own(a).amount.toString(), currency: a.currency });
