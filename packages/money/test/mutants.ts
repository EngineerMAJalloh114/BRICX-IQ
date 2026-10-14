// Deliberately broken variants for the sabotage tests (P3 rule 1). Each is
// the real behaviour with one defect; sabotage.test.ts runs the real checks
// against every one and requires them to fail.
import Decimal from "decimal.js";
import { allocate } from "../src/allocate.js";
import { currencyExponent } from "../src/currency.js";
import type { CurrencyCode } from "../src/currency.js";
import { MoneyError } from "../src/errors.js";
import { convert } from "../src/fx.js";
import { D, decimalRounding, toBigInt } from "../src/decimal.js";
import { add, fromMinor, toMajorString } from "../src/money.js";
import type { Money } from "../src/money.js";
import { Rounding } from "../src/rounding.js";

type Ratio = bigint | string | Decimal;
export type Allocate = (m: Money, ratios: readonly Ratio[]) => readonly Money[];

const toDecimal = (r: Ratio) =>
  new Decimal(typeof r === "bigint" ? r.toString() : r);

/** Floors every share and drops the remainder: parts do not sum back. */
export const allocateDropsRemainder: Allocate = (m, ratios) => {
  const sum = ratios.reduce<Decimal>(
    (a, r) => a.plus(toDecimal(r)),
    new Decimal(0),
  );
  return ratios.map((r) =>
    fromMinor(
      BigInt(
        new Decimal(m.amount.toString())
          .mul(toDecimal(r))
          .div(sum)
          .toFixed(0, Decimal.ROUND_DOWN),
      ),
      m.currency,
    ),
  );
};

/** Gives leftover units to the highest index on a tie, not the lowest. */
export const allocateTiesToHighestIndex: Allocate = (m, ratios) =>
  [...allocate(m, [...ratios].reverse())].reverse();

/** Gives every leftover unit to the first part, ignoring remainders. */
export const allocateLeftoverToFirst: Allocate = (m, ratios) => {
  const floors = allocateDropsRemainder(m, ratios);
  const leftover = floors.reduce((a, p) => a - p.amount, m.amount);
  return floors.map((p, i) =>
    i === 0 ? fromMinor(p.amount + leftover, m.currency) : p,
  );
};

/** Floors signed shares, so a negative total is not split symmetrically. */
export const allocateSignedFloor: Allocate = (m, ratios) => {
  if (m.amount >= 0n) return allocate(m, ratios);
  const sum = ratios.reduce<Decimal>(
    (a, r) => a.plus(toDecimal(r)),
    new Decimal(0),
  );
  const floors = ratios.map((r) =>
    BigInt(
      new Decimal(m.amount.toString())
        .mul(toDecimal(r))
        .div(sum)
        .toFixed(0, Decimal.ROUND_FLOOR),
    ),
  );
  const leftover = floors.reduce((a, f) => a - f, m.amount);
  return floors.map((f, i) =>
    fromMinor(i === 0 ? f + leftover : f, m.currency),
  );
};

/** Adds across currencies, keeping the first currency. */
export const addIgnoresCurrency = (a: Money, b: Money): Money =>
  fromMinor(a.amount + b.amount, a.currency);

/** Converts with the rate only, ignoring the two exponents. */
export const convertIgnoresExponents = (
  m: Money,
  rate: string,
  target: CurrencyCode,
  rounding: Rounding = Rounding.HALF_EVEN,
) => {
  const real = convert(fromMinor(m.amount, target), rate, target, rounding);
  return real;
};

/** Defaults convert to HALF_UP instead of HALF_EVEN. */
export const convertDefaultsHalfUp = (
  m: Money,
  rate: string,
  target: CurrencyCode,
) => convert(m, rate, target, Rounding.HALF_UP);

/** Rounds a rate with too many digits instead of throwing. */
export const convertRoundsRate = (
  m: Money,
  rate: string,
  target: CurrencyCode,
) =>
  convert(
    m,
    new Decimal(rate).toDecimalPlaces(12, Decimal.ROUND_HALF_EVEN),
    target,
  );

/** Formats through a JS number (float): loses digits above 2^53. */
export const formatViaNumber = (m: Money, locale: string): string => {
  const e = currencyExponent(m.currency);
  // The defect under test: the exact major string becomes a float.
  const value = Number.parseFloat(toMajorString(m));
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: m.currency,
    minimumFractionDigits: e,
    maximumFractionDigits: e,
  }).format(value);
};

/** Echoes the input in the error message. */
export const fromMinorEchoes = (
  amount: string,
  currency: CurrencyCode,
): Money => {
  try {
    return fromMinor(amount, currency);
  } catch (error) {
    if (error instanceof MoneyError) {
      const leaky = new MoneyError(error.code);
      Object.defineProperty(leaky, "message", {
        value: `${error.message}: ${amount}`,
      });
      throw leaky;
    }
    throw error;
  }
};

/**
 * multiply without the bounded parser (the code before the architect
 * review): any finite factor, multiplied at precision 64, then rounded a
 * second time to an integer, so a long near-tie factor double-rounds.
 */
export const multiplyUncapped = (
  m: Money,
  factor: string,
  rounding: Rounding,
): Money =>
  fromMinor(
    toBigInt(
      new D(m.amount.toString()).mul(new D(factor)),
      decimalRounding(rounding),
    ),
    m.currency,
  );

/** Real add, for the control rows. */
export const realAdd = add;
