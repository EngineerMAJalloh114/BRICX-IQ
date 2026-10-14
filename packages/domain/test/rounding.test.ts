// Rounding of quantity conversions against two independent oracles:
// - the definitional bigint oracle (test/oracle.ts), on any n / d;
// - @bricx/money's multiply, which rounds with decimal.js, on n / 10^k
//   (multiply by the factor 10^-k), for all 7 modes.
import { fromMinor, multiply } from "@bricx/money/money";
import { Rounding } from "@bricx/money/rounding";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { roundDiv } from "../src/decimal.ts";
import { convert, quantity, toDecimalString } from "../src/units.ts";
import { definitionalRound } from "./oracle.ts";

const MODES = Object.values(Rounding);

describe("roundDiv", () => {
  it("agrees with the definitional oracle on random n / d, every mode", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 30n), max: 10n ** 30n }),
        fc.bigInt({ min: 1n, max: 10n ** 20n }),
        fc.constantFrom(...MODES),
        (n, d, mode) => {
          expect(roundDiv(n, d, mode)).toBe(definitionalRound(n, d, mode));
        },
      ),
      { numRuns: 5000 },
    );
  });

  it("agrees on exact halves and near-halves, every mode", () => {
    for (const mode of MODES) {
      for (let n = -50n; n <= 50n; n += 1n) {
        for (const d of [1n, 2n, 3n, 4n, 10n]) {
          expect(
            roundDiv(n, d, mode),
            `${String(n)}/${String(d)} ${mode}`,
          ).toBe(definitionalRound(n, d, mode));
        }
      }
    }
  });

  it("never returns negative zero (bigint has none) and is exact when d divides n", () => {
    expect(roundDiv(-1n, 3n, Rounding.HALF_EVEN)).toBe(0n);
    expect(roundDiv(12n, 4n, Rounding.UP)).toBe(3n);
  });
});

describe("convert rounds like @bricx/money (decimal.js), all 7 modes", () => {
  it("rescaling a quantity to fewer places equals money's multiply by 10^-k", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: -(10n ** 17n), max: 10n ** 17n }),
        fc.integer({ min: 1, max: 9 }),
        fc.constantFrom(...MODES),
        (coefficient, drop, mode) => {
          const scale = 9;
          const built = quantity(coefficient % 10n ** 21n, scale, "m");
          if (!built.ok) return;
          const target = scale - drop;
          const converted = convert(built.value, "m", {
            scale: target,
            rounding: mode,
          });
          expect(converted.ok).toBe(true);
          if (!converted.ok) return;
          const factor = `0.${"0".repeat(drop - 1)}1`;
          const viaMoney = multiply(
            fromMinor(built.value.coefficient, "JPY"),
            factor,
            mode,
          );
          expect(converted.value.quantity.coefficient).toBe(viaMoney.amount);
        },
      ),
      { numRuns: 3000 },
    );
  });

  it("a worked case per mode: 1.005 m to 2 places", () => {
    const built = quantity(1005n, 3, "m");
    if (!built.ok) throw new Error("fixture");
    const at2 = (mode: Rounding) => {
      const r = convert(built.value, "m", { scale: 2, rounding: mode });
      return r.ok ? toDecimalString(r.value.quantity) : r.error.code;
    };
    expect(at2(Rounding.HALF_EVEN)).toBe("1.00");
    expect(at2(Rounding.HALF_UP)).toBe("1.01");
    expect(at2(Rounding.HALF_DOWN)).toBe("1.00");
    expect(at2(Rounding.UP)).toBe("1.01");
    expect(at2(Rounding.DOWN)).toBe("1.00");
    expect(at2(Rounding.CEILING)).toBe("1.01");
    expect(at2(Rounding.FLOOR)).toBe("1.00");
  });
});
