// fast-check properties (P3-02 Done-when + rulings): allocate sums back
// exactly, each part is within one minor unit of its exact share (equal
// ratios: parts differ by at most one), add is associative, add/subtract are
// inverses, the JSON round trip preserves the value, and a convert round trip
// stays inside the bound derived in ADR 0045 (no fitting to test output).
import Decimal from "decimal.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { allocate } from "../src/allocate.js";
import { currencyExponent } from "../src/currency.js";
import { convert } from "../src/fx.js";
import { add, fromMinor, subtract } from "../src/money.js";
import type { Money } from "../src/money.js";
import { Rounding } from "../src/rounding.js";
import { MoneySchema } from "../src/schema.js";
import {
  abs,
  amountArb,
  currencyArb,
  decimalStringArb,
  smallAmountArb,
} from "./helpers.js";
import { checkAllocation } from "./checks.js";

const RUNS = { numRuns: 500 };

const moneyArb = fc
  .tuple(amountArb, currencyArb)
  .map(([a, c]) => fromMinor(a, c));
const smallMoneyTriple = fc
  .tuple(smallAmountArb, smallAmountArb, smallAmountArb, currencyArb)
  .map(
    ([a, b, c, cur]) =>
      [fromMinor(a, cur), fromMinor(b, cur), fromMinor(c, cur)] as const,
  );

// Ratios: 1..12 parts, bigint or decimal strings (up to 4 fraction digits),
// at least one non-zero.
const bigintRatiosArb = fc
  .array(fc.bigInt({ min: 0n, max: 10_000n }), { minLength: 1, maxLength: 12 })
  .filter((r) => r.some((x) => x > 0n));
const stringRatiosArb = fc
  .array(decimalStringArb(1000n, 4), { minLength: 1, maxLength: 12 })
  .filter((r) => r.some((x) => new Decimal(x).gt(0)));

describe("allocate properties", () => {
  it("parts sum exactly to the original and each is within one unit of its exact share (bigint ratios)", () => {
    fc.assert(
      fc.property(moneyArb, bigintRatiosArb, (m, ratios) => {
        checkAllocation(m, ratios, allocate(m, ratios));
      }),
      RUNS,
    );
  });

  it("the same with decimal-string ratios", () => {
    fc.assert(
      fc.property(moneyArb, stringRatiosArb, (m, ratios) => {
        checkAllocation(m, ratios, allocate(m, ratios));
      }),
      RUNS,
    );
  });

  it("equal ratios: parts never differ by more than one minor unit, larger parts first", () => {
    fc.assert(
      fc.property(moneyArb, fc.integer({ min: 1, max: 50 }), (m, n) => {
        const parts = allocate(
          m,
          Array.from({ length: n }, () => 1n),
        ).map((p) => p.amount);
        const max = parts.reduce((a, b) => (b > a ? b : a));
        const min = parts.reduce((a, b) => (b < a ? b : a));
        expect(max - min <= 1n).toBe(true);
        // Ties go to the lowest index: magnitudes never increase along the list.
        for (let i = 1; i < parts.length; i += 1) {
          expect(abs(parts[i] ?? 0n) <= abs(parts[i - 1] ?? 0n)).toBe(true);
        }
      }),
      RUNS,
    );
  });
});

describe("arithmetic properties", () => {
  it("add is associative", () => {
    fc.assert(
      fc.property(smallMoneyTriple, ([a, b, c]) => {
        expect(add(add(a, b), c)).toEqual(add(a, add(b, c)));
      }),
      RUNS,
    );
  });

  it("add is commutative and zero is its identity", () => {
    fc.assert(
      fc.property(smallMoneyTriple, ([a, b]) => {
        expect(add(a, b)).toEqual(add(b, a));
        expect(add(a, fromMinor(0n, a.currency))).toEqual(a);
      }),
      RUNS,
    );
  });

  it("subtract undoes add, and add undoes subtract", () => {
    fc.assert(
      fc.property(smallMoneyTriple, ([a, b]) => {
        expect(subtract(add(a, b), b)).toEqual(a);
        expect(add(subtract(a, b), b)).toEqual(a);
      }),
      RUNS,
    );
  });
});

describe("serialisation property", () => {
  it("JSON round trip through MoneySchema preserves every value in the 64-bit range", () => {
    fc.assert(
      fc.property(moneyArb, (m) => {
        const text = JSON.stringify(MoneySchema.encode(m));
        expect(MoneySchema.parse(JSON.parse(text))).toEqual(m);
      }),
      RUNS,
    );
  });
});

// ADR 0045, "Convert round-trip bound". With source exponent e_s, target
// exponent e_t, k = 10^(e_t - e_s), rate r and inverse rate r':
//   t = round1(m·r·k)            |t - m·r·k| <= d1
//   b = round2(t·r'/k)           |b - t·r'/k| <= d2
//   b - m = m(r·r' - 1) + (t - m·r·k)·r'/k + (b - t·r'/k)
//   |b - m| <= |m|·|r·r' - 1| + d1·r'/k + d2
// where d = 1/2 for HALF_* modes and d = 1 for UP, DOWN, CEILING, FLOOR.
const HALF = new Set<Rounding>([
  Rounding.HALF_EVEN,
  Rounding.HALF_UP,
  Rounding.HALF_DOWN,
]);
const delta = (mode: Rounding) => new Decimal(HALF.has(mode) ? "0.5" : "1");

function roundTripBound(
  m: Money,
  target: Money["currency"],
  rate: Decimal,
  inverse: Decimal,
  first: Rounding,
  second: Rounding,
): Decimal {
  const k = new Decimal(10).pow(
    currencyExponent(target) - currencyExponent(m.currency),
  );
  return new Decimal(abs(m.amount).toString())
    .mul(rate.mul(inverse).minus(1).abs())
    .plus(delta(first).mul(inverse).div(k))
    .plus(delta(second));
}

const roundingArb = fc.constantFrom(...Object.values(Rounding));
// Rates from 0.001 to 1000 with up to 12 fraction digits; amounts up to 2^36
// so m·r·10^4 stays far inside 64 bits.
const rateArb = fc
  .bigInt({ min: 1_000_000_000n, max: 1_000_000_000_000_000n })
  .map((n) => new Decimal(n.toString()).div("1e12"));

describe("convert round trip", () => {
  it("convert(convert(m, r), r') - m stays within the derived bound", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(2n ** 36n), max: 2n ** 36n }),
        currencyArb,
        currencyArb,
        rateArb,
        roundingArb,
        roundingArb,
        (amount, source, target, rate, first, second) => {
          const m = fromMinor(amount, source);
          // r' = 1/r rounded HALF_EVEN to 12 places (what a NUMERIC(24,12) column holds).
          const inverse = new Decimal(1)
            .div(rate)
            .toDecimalPlaces(12, Decimal.ROUND_HALF_EVEN);
          const there = convert(m, rate, target, first).money;
          const back = convert(there, inverse, source, second).money;
          const diff = new Decimal(abs(back.amount - m.amount).toString());
          const bound = roundTripBound(m, target, rate, inverse, first, second);
          expect(
            diff.lte(bound),
            `|${diff.toString()}| > ${bound.toString()}`,
          ).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("with an exactly invertible rate and the same exponent, the round trip is within one unit", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(2n ** 50n), max: 2n ** 50n }),
        fc.constantFrom(
          ["2", "0.5"],
          ["4", "0.25"],
          ["1.25", "0.8"],
          ["8", "0.125"],
        ),
        (amount, [r, inv]) => {
          const m = fromMinor(amount, "USD");
          const back = convert(convert(m, r, "EUR").money, inv, "USD").money;
          expect(abs(back.amount - m.amount) <= 1n).toBe(true);
        },
      ),
      RUNS,
    );
  });
});
