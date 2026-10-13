// Independent oracle for multiply and convert (architect review of PR #35,
// item 3). Plain bigint rationals only, no decimal.js: a decimal string is
// scaled to an integer, the exact result is n / d with d > 0, and n / d is
// rounded with each of the seven modes by integer division. Comparing the
// library with this catches double rounding that example tests miss.
import fc from "fast-check";
import { expect } from "vitest";
import { currencyExponent } from "../src/currency.js";
import type { CurrencyCode } from "../src/currency.js";
import { MoneyError } from "../src/errors.js";
import type { MoneyErrorCode } from "../src/errors.js";
import { MAX_AMOUNT, MIN_AMOUNT, fromMinor } from "../src/money.js";
import type { Money } from "../src/money.js";
import { Rounding } from "../src/rounding.js";
import { BHD, CLF, EUR, JPY, USD } from "./helpers.js";

export const ALL_MODES: readonly Rounding[] = Object.values(Rounding);

/** n / d (d > 0) rounded to an integer with `mode`, in bigint only. */
export function roundDiv(n: bigint, d: bigint, mode: Rounding): bigint {
  const q = n / d; // truncates toward zero
  const r = n % d; // has the sign of n
  if (r === 0n) return q;
  const away = q + (n < 0n ? -1n : 1n);
  const twice = 2n * (r < 0n ? -r : r);
  const half = twice > d ? 1 : twice < d ? -1 : 0;
  switch (mode) {
    case Rounding.DOWN:
      return q;
    case Rounding.UP:
      return away;
    case Rounding.CEILING:
      return n > 0n ? away : q;
    case Rounding.FLOOR:
      return n < 0n ? away : q;
    case Rounding.HALF_UP:
      return half >= 0 ? away : q;
    case Rounding.HALF_DOWN:
      return half > 0 ? away : q;
    case Rounding.HALF_EVEN:
      return half > 0 ? away : half < 0 ? q : q % 2n === 0n ? q : away;
  }
}

/** "-12.340" -> { value: -12340n, scale: 3 }. */
export function scaledDecimal(s: string): { value: bigint; scale: number } {
  const negative = s.startsWith("-");
  const [whole = "", fraction = ""] = (negative ? s.slice(1) : s).split(".");
  const value = BigInt(`${whole}${fraction}`);
  return { value: negative ? -value : value, scale: fraction.length };
}

/** Significant integer digits and fraction digits, trailing zeros not counted. */
export function digitCounts(s: string): { integer: number; fraction: number } {
  const [whole = "", fraction = ""] = s.replace(/^-/, "").split(".");
  return {
    integer: whole === "0" ? 0 : whole.length,
    fraction: fraction.replace(/0+$/, "").length,
  };
}

const LIMIT = 12;
const within = (s: string): boolean => {
  const c = digitCounts(s);
  return c.integer <= LIMIT && c.fraction <= LIMIT;
};

type Outcome = { amount: bigint } | { error: MoneyErrorCode };

const inRange = (x: bigint): Outcome =>
  x > MAX_AMOUNT || x < MIN_AMOUNT ? { error: "out_of_range" } : { amount: x };

/** The exact multiply result, ignoring the digit limits. */
export function exactMultiply(
  amount: bigint,
  factor: string,
  mode: Rounding,
): Outcome {
  const f = scaledDecimal(factor);
  return inRange(roundDiv(amount * f.value, 10n ** BigInt(f.scale), mode));
}

/** What multiply must do: the limits first, then the exact result. */
export function referenceMultiply(
  amount: bigint,
  factor: string,
  mode: Rounding,
): Outcome {
  return within(factor)
    ? exactMultiply(amount, factor, mode)
    : { error: "factor_precision" };
}

/** What convert must do: amount · rate · 10^(e_t − e_s), limits first. */
export function referenceConvert(
  amount: bigint,
  rate: string,
  source: CurrencyCode,
  target: CurrencyCode,
  mode: Rounding,
): Outcome {
  if (!within(rate)) return { error: "rate_precision" };
  const r = scaledDecimal(rate);
  const shift = currencyExponent(target) - currencyExponent(source);
  const n = amount * r.value * 10n ** BigInt(Math.max(0, shift));
  const d = 10n ** BigInt(r.scale + Math.max(0, -shift));
  return inRange(roundDiv(n, d, mode));
}

/** Runs `fn` and reports its outcome the way the reference does. */
export function outcome(fn: () => Money): Outcome {
  try {
    return { amount: fn().amount };
  } catch (error) {
    if (error instanceof MoneyError) return { error: error.code };
    throw error;
  }
}

// ---- arbitraries -------------------------------------------------------

export const modeArb = fc.constantFrom(...ALL_MODES);

const digitsArb = (min: number, max: number) =>
  fc
    .array(fc.constantFrom("0", "1", "2", "3", "4", "5", "6", "7", "8", "9"), {
      minLength: min,
      maxLength: max,
    })
    .map((d) => d.join(""));

const sign = (negative: boolean, s: string) =>
  negative && !/^0(?:\.0*)?$/.test(s) ? `-${s}` : s;

/** A canonical decimal string with at most 12 + 12 digits. */
export const factorWithinArb = fc
  .tuple(
    fc.boolean(),
    fc.bigInt({ min: 0n, max: 10n ** 12n - 1n }),
    digitsArb(0, 12),
  )
  .map(([negative, i, f]) =>
    sign(negative, f === "" ? i.toString() : `${i.toString()}.${f}`),
  );

/** Exact ties and near ties within the limits (x.5, x.25, x.4999…). */
export const factorTieArb = fc
  .tuple(
    fc.boolean(),
    fc.bigInt({ min: 0n, max: 999n }),
    digitsArb(0, 10),
    fc.constantFrom("5", "49", "51", "499999999", "500000001"),
  )
  .map(([negative, i, f, tail]) =>
    sign(negative, `${i.toString()}.${`${f}${tail}`.slice(0, 12)}`),
  );

/** Near ties with 64 to 70 fraction digits: beyond the limits. */
export const factorLongArb = fc
  .tuple(
    fc.boolean(),
    fc.bigInt({ min: 0n, max: 999n }),
    fc.integer({ min: 63, max: 69 }),
    fc.boolean(),
  )
  .map(([negative, i, k, below]) =>
    sign(
      negative,
      `${i.toString()}.${below ? `4${"9".repeat(k)}` : `5${"0".repeat(k - 1)}1`}`,
    ),
  );

/** Over the limits by one digit on either side. */
export const factorOverArb = fc
  .tuple(
    fc.boolean(),
    fc.bigInt({ min: 10n ** 12n, max: 10n ** 13n - 1n }),
    digitsArb(13, 20),
    fc.boolean(),
  )
  .map(([negative, i, f, wide]) =>
    sign(negative, wide ? i.toString() : `0.${f.replace(/0$/, "1")}`),
  );

/** Amounts: mostly small (so ties and in-range results are common), some full range, some powers of ten. */
export const oracleAmountArb = fc.oneof(
  fc.bigInt({ min: -1000n, max: 1000n }),
  fc.bigInt({ min: MIN_AMOUNT, max: MAX_AMOUNT }),
  fc
    .tuple(fc.boolean(), fc.integer({ min: 0, max: 6 }))
    .map(([n, j]) => (n ? -1n : 1n) * 10n ** BigInt(j)),
);

export const oracleCurrencyArb = fc.constantFrom(USD, EUR, JPY, BHD, CLF);

/** A positive rate within NUMERIC(24,12). */
export const rateWithinArb = fc
  .tuple(fc.bigInt({ min: 0n, max: 10n ** 12n - 1n }), digitsArb(0, 12))
  .map(([i, f]) => (f === "" ? i.toString() : `${i.toString()}.${f}`))
  .filter((s) => !/^0(?:\.0*)?$/.test(s));

/** Positive near-tie rates beyond the limits. */
export const rateLongArb = factorLongArb.map((s) => s.replace(/^-/, ""));

// ---- the checks (shared with the sabotage tests) ------------------------

type Multiply = (m: Money, factor: string, mode: Rounding) => Money;
type Convert = (
  m: Money,
  rate: string,
  target: CurrencyCode,
  mode: Rounding,
) => { money: Money };

/** multiply agrees with the reference (limits included) for every case. */
export function checkMultiply(
  fn: Multiply,
  factorArb: fc.Arbitrary<string>,
  numRuns: number,
  reference = referenceMultiply,
): void {
  fc.assert(
    fc.property(oracleAmountArb, factorArb, modeArb, (amount, factor, mode) => {
      const m = fromMinor(amount, USD);
      expect(outcome(() => fn(m, factor, mode))).toEqual(
        reference(amount, factor, mode),
      );
    }),
    { numRuns },
  );
}

/** convert agrees with the reference (limits included) for every case. */
export function checkConvert(
  fn: Convert,
  rateArb: fc.Arbitrary<string>,
  numRuns: number,
): void {
  fc.assert(
    fc.property(
      oracleAmountArb,
      rateArb,
      oracleCurrencyArb,
      oracleCurrencyArb,
      modeArb,
      (amount, rate, source, target, mode) => {
        const m = fromMinor(amount, source);
        expect(outcome(() => fn(m, rate, target, mode).money)).toEqual(
          referenceConvert(amount, rate, source, target, mode),
        );
      },
    ),
    { numRuns },
  );
}
