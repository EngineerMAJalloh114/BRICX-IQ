// Internal (not in the exports map): a private decimal.js constructor, so
// money never reads or changes the global Decimal configuration. Precision
// 64 holds a 19-digit amount times a 24-digit rate (43 digits) exactly.
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

/** A plain decimal string: optional "-", no leading zeros, optional fraction. */
const SIGNED_DECIMAL = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const UNSIGNED_DECIMAL = /^(?:0|[1-9]\d*)(?:\.\d+)?$/;

/**
 * A finite Decimal from a Decimal or a plain decimal string; anything else
 * (a JS number included) throws `code`.
 */
export function toDecimal(
  value: unknown,
  code: MoneyErrorCode,
  signed: boolean,
): Decimal {
  if (typeof value === "string") {
    if (!(signed ? SIGNED_DECIMAL : UNSIGNED_DECIMAL).test(value))
      throw new MoneyError(code);
    return new D(value);
  }
  if (Decimal.isDecimal(value)) {
    const d = new D(value);
    if (!d.isFinite()) throw new MoneyError(code);
    return d;
  }
  throw new MoneyError(code);
}

/** Rounds to an integer with `mode` and returns it as a bigint. */
export const toBigInt = (d: Decimal, mode: Decimal.Rounding): bigint =>
  BigInt(d.toDecimalPlaces(0, mode).toFixed(0));
