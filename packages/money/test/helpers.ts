// Shared test helpers: fast-check arbitraries and exact checks that both the
// real tests and the sabotage tests run.
import fc from "fast-check";
import { expect } from "vitest";
import { listCurrencies, parseCurrencyCode } from "../src/currency.js";
import type { CurrencyCode } from "../src/currency.js";
import { MoneyError } from "../src/errors.js";
import type { MoneyErrorCode } from "../src/errors.js";
import { MAX_AMOUNT, MIN_AMOUNT } from "../src/money.js";

export const USD = parseCurrencyCode("USD");
export const EUR = parseCurrencyCode("EUR");
export const GBP = parseCurrencyCode("GBP");
export const JPY = parseCurrencyCode("JPY");
export const BHD = parseCurrencyCode("BHD");
export const CLF = parseCurrencyCode("CLF");
export const SLE = parseCurrencyCode("SLE");

export const TWO_POW_53 = 2n ** 53n;

/** Any current ISO 4217 code that can form Money. */
export const currencyArb: fc.Arbitrary<CurrencyCode> = fc.constantFrom(
  ...listCurrencies().map((c) => c.code),
);

/** Any amount in the signed 64-bit range (both ends included). */
export const amountArb = fc.bigInt({ min: MIN_AMOUNT, max: MAX_AMOUNT });

/** Amounts small enough that a few additions stay in range. */
export const smallAmountArb = fc.bigInt({
  min: -(2n ** 60n),
  max: 2n ** 60n,
});

/** A non-negative decimal string with up to `dp` fraction digits. */
export function decimalStringArb(
  maxInt: bigint,
  dp: number,
): fc.Arbitrary<string> {
  return fc
    .tuple(
      fc.bigInt({ min: 0n, max: maxInt }),
      fc.bigInt({ min: 0n, max: 10n ** BigInt(dp) - 1n }),
    )
    .map(([i, f]) => {
      if (dp === 0) return i.toString();
      const frac = f.toString().padStart(dp, "0").replace(/0+$/, "");
      return frac === "" ? i.toString() : `${i.toString()}.${frac}`;
    });
}

/** Asserts `fn` throws a MoneyError with `code` whose message has none of `inputs`. */
export function expectMoneyError(
  fn: () => unknown,
  code: MoneyErrorCode,
  inputs: readonly string[] = [],
): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, `expected MoneyError ${code}`).toBeInstanceOf(MoneyError);
  const error = thrown as MoneyError;
  expect(error.code).toBe(code);
  for (const input of inputs) {
    if (input.length > 0) expect(error.message).not.toContain(input);
  }
}

/** Absolute value of a bigint. */
export const abs = (n: bigint): bigint => (n < 0n ? -n : n);
