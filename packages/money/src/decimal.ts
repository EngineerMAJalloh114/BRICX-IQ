// Internal (not in the exports map): a private decimal.js constructor, so
// money never reads or changes the global Decimal configuration. Precision
// 64 holds a 19-digit amount times a 24-digit factor or rate (43 digits)
// exactly, so the only rounding is the final one to an integer.
import Decimal from "decimal.js";
import { MoneyError } from "./errors.js";
import type { MoneyErrorCode } from "./errors.js";
import { Rounding, isRounding } from "./rounding.js";

export const D = Decimal.clone({
  precision: 64,
  rounding: Decimal.ROUND_HALF_EVEN,
  toExpNeg: -1000,
  toExpPos: 1000,
});
export type D = Decimal;

const modes: Readonly<Record<Rounding, Decimal.Rounding>> = {
  [Rounding.HALF_EVEN]: Decimal.ROUND_HALF_EVEN,
  [Rounding.HALF_UP]: Decimal.ROUND_HALF_UP,
  [Rounding.HALF_DOWN]: Decimal.ROUND_HALF_DOWN,
  [Rounding.UP]: Decimal.ROUND_UP,
  [Rounding.DOWN]: Decimal.ROUND_DOWN,
  [Rounding.CEILING]: Decimal.ROUND_CEIL,
  [Rounding.FLOOR]: Decimal.ROUND_FLOOR,
};

/** decimal.js's constant for a mode; throws invalid_rounding otherwise. */
export function decimalRounding(mode: unknown): Decimal.Rounding {
  if (!isRounding(mode)) throw new MoneyError("invalid_rounding");
  return modes[mode];
}

/** The longest decimal string any input may be; checked before the regex. */
export const MAX_DECIMAL_STRING_LENGTH = 80;

/** A plain decimal string: optional "-", no leading zeros, optional fraction. */
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const UNSIGNED_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Digit limits for one kind of input (factor, rate or ratio). */
export interface DecimalLimits {
  /** A leading "-" is allowed in strings (Decimal objects carry their sign). */
  readonly signed: boolean;
  /** Significant integer digits ("0.5" has none). */
  readonly integerDigits: number;
  /** Fraction digits; trailing zeros carry no value and are not counted. */
  readonly fractionDigits: number;
  /** Integer digits (at least one, the "0" of a pure fraction) plus fraction digits. */
  readonly totalDigits: number;
  /** Thrown for anything that is not a plain decimal string or a finite Decimal. */
  readonly invalid: MoneyErrorCode;
  /** Thrown for a well-formed value beyond the digit limits. */
  readonly precision: MoneyErrorCode;
}

function checkDigits(
  integer: number,
  fraction: number,
  limits: DecimalLimits,
): void {
  if (
    integer > limits.integerDigits ||
    fraction > limits.fractionDigits ||
    Math.max(integer, 1) + fraction > limits.totalDigits
  ) {
    throw new MoneyError(limits.precision);
  }
}

/**
 * The one bounded parser for factors, rates and ratios. Every check runs
 * before the value is converted, printed (toFixed) or parsed as a BigInt:
 * strings are length-capped first, then matched, then their digits counted;
 * Decimal objects are checked for finiteness, then exponent, then decimal
 * places (both O(1) in decimal.js), which also bound precision(). Anything else (a JS number
 * included) throws `limits.invalid`.
 */
export function parseDecimal(value: unknown, limits: DecimalLimits): Decimal {
  if (typeof value === "string") {
    if (
      value.length > MAX_DECIMAL_STRING_LENGTH ||
      !(limits.signed ? SIGNED_DECIMAL : UNSIGNED_DECIMAL).test(value)
    ) {
      throw new MoneyError(limits.invalid);
    }
    const [whole = "", fraction = ""] = value.replace(/^-/, "").split(".");
    checkDigits(
      whole === "0" ? 0 : whole.length,
      fraction.replace(/0+$/, "").length,
      limits,
    );
    return new D(value);
  }
  if (Decimal.isDecimal(value)) {
    if (!value.isFinite()) throw new MoneyError(limits.invalid);
    // e is the base-10 exponent of the leading digit: e + 1 integer digits.
    if (value.e + 1 > limits.integerDigits) {
      throw new MoneyError(limits.precision);
    }
    const fraction = value.decimalPlaces();
    if (fraction > limits.fractionDigits) {
      throw new MoneyError(limits.precision);
    }
    // precision() (significant digits) is at most (e + 1) + decimal places,
    // so the two checks above already bound it; checkDigits adds the total.
    checkDigits(Math.max(value.e + 1, 0), fraction, limits);
    return new D(value);
  }
  throw new MoneyError(limits.invalid);
}

/** Rounds to an integer with `mode` and returns it as a bigint. */
export const toBigInt = (d: Decimal, mode: Decimal.Rounding): bigint =>
  BigInt(d.toDecimalPlaces(0, mode).toFixed(0));
