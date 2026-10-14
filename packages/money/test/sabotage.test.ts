// Sabotage (P3 rule 1, permanent): the checks below pass on the real code
// and fail on each deliberately broken variant in mutants.ts. If a check
// stops catching its mutant, this file fails.
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import { allocate } from "../src/allocate.js";
import { convert } from "../src/fx.js";
import { formatMoney } from "../src/format.js";
import { fromMinor, multiply } from "../src/money.js";
import { Rounding } from "../src/rounding.js";
import { checkMultiply, exactMultiply, factorLongArb } from "./oracle.js";
import type { Money } from "../src/money.js";
import { checkAllocation } from "./checks.js";
import { EUR, JPY, TWO_POW_53, USD, expectMoneyError } from "./helpers.js";
import type { Allocate } from "./mutants.js";
import {
  addIgnoresCurrency,
  allocateDropsRemainder,
  allocateLeftoverToFirst,
  allocateSignedFloor,
  allocateTiesToHighestIndex,
  convertDefaultsHalfUp,
  convertIgnoresExponents,
  convertRoundsRate,
  formatViaNumber,
  fromMinorEchoes,
  multiplyUncapped,
  realAdd,
} from "./mutants.js";

/** Fails (throws) when `check` passes. */
function expectCaught(check: () => void): void {
  expect(check).toThrow();
}

// A fixed set of allocation cases the checks must get right.
const allocationCases: readonly [
  Money,
  readonly (bigint | string | Decimal)[],
][] = [
  [fromMinor(100n, USD), [1n, 1n, 1n]],
  [fromMinor(-100n, USD), [1n, 1n, 1n]],
  [fromMinor(10n, USD), ["33", "36", "31"]],
  [fromMinor(2n, USD), [1n, 1n, 1n, 1n, 1n]],
  [fromMinor(-7n, JPY), ["0.3", "0.7"]],
  [fromMinor(TWO_POW_53 * 1000n + 8n, USD), [1n, 1n, 1n]],
];

/** Sum, one-unit closeness and sign checks, plus the tie-break expectations. */
function allocationChecks(fn: Allocate): void {
  for (const [m, ratios] of allocationCases)
    checkAllocation(m, ratios, fn(m, ratios));
  expect(fn(fromMinor(100n, USD), [1n, 1n, 1n]).map((p) => p.amount)).toEqual([
    34n,
    33n,
    33n,
  ]);
  expect(
    fn(fromMinor(10n, USD), ["33", "36", "31"]).map((p) => p.amount),
  ).toEqual([3n, 4n, 3n]);
  expect(fn(fromMinor(-100n, USD), [1n, 1n, 1n]).map((p) => p.amount)).toEqual([
    -34n,
    -33n,
    -33n,
  ]);
}

describe("allocate checks", () => {
  it("pass on the real allocate", () => {
    allocationChecks(allocate);
  });
  it.each([
    ["drops the remainder", allocateDropsRemainder],
    ["ties to the highest index", allocateTiesToHighestIndex],
    ["gives all leftover to the first part", allocateLeftoverToFirst],
    ["floors signed shares", allocateSignedFloor],
  ] as const)("catch a variant that %s", (_name, mutant) => {
    expectCaught(() => {
      allocationChecks(mutant);
    });
  });
});

describe("currency mismatch check", () => {
  const check = (fn: typeof realAdd) => {
    expectMoneyError(
      () => fn(fromMinor(1n, USD), fromMinor(1n, EUR)),
      "currency_mismatch",
    );
  };
  it("passes on the real add", () => {
    check(realAdd);
  });
  it("catches an add that ignores the currency", () => {
    expectCaught(() => {
      check(addIgnoresCurrency);
    });
  });
});

describe("convert checks", () => {
  const check = (
    fn: (m: Money, rate: string, target: typeof JPY) => { money: Money },
  ) => {
    expect(fn(fromMinor(1234n, USD), "150", JPY).money.amount).toBe(1851n);
    expect(fn(fromMinor(5n, USD), "0.5", EUR).money.amount).toBe(2n);
    expectMoneyError(
      () => fn(fromMinor(1n, USD), "1.0000000000001", EUR),
      "rate_precision",
    );
  };
  it("pass on the real convert (default rounding)", () => {
    check((m, rate, target) => convert(m, rate, target));
  });
  it.each([
    ["ignores the exponents", convertIgnoresExponents],
    ["defaults to HALF_UP", convertDefaultsHalfUp],
    ["rounds an over-precise rate", convertRoundsRate],
  ] as const)("catch a variant that %s", (_name, mutant) => {
    expectCaught(() => {
      check(mutant);
    });
  });
});

describe("format check above 2^53", () => {
  const check = (fn: (m: Money, locale: string) => string) => {
    expect(fn(fromMinor(TWO_POW_53 + 1n, USD), "en-US")).toBe(
      "$90,071,992,547,409.93",
    );
  };
  it("passes on the real formatMoney", () => {
    check(formatMoney);
  });
  it("catches formatting through a float", () => {
    expectCaught(() => {
      check(formatViaNumber);
    });
  });
});

describe("error-message check", () => {
  const check = (fn: typeof fromMinor) => {
    expectMoneyError(() => fn("12.5", USD), "invalid_amount", ["12.5"]);
  };
  it("passes on the real fromMinor", () => {
    check(fromMinor);
  });
  it("catches an error that echoes the input", () => {
    expectCaught(() => {
      check(fromMinorEchoes as typeof fromMinor);
    });
  });
});

describe("bounded factor checks (architect review of PR #35, item 4)", () => {
  const factor = `0.4${"9".repeat(69)}`;
  const tieCheck = (
    fn: (m: Money, factor: string, rounding: Rounding) => Money,
  ) => {
    expectMoneyError(
      () => fn(fromMinor(1n, USD), factor, Rounding.HALF_UP),
      "factor_precision",
    );
  };
  it("the tie case passes on the real multiply", () => {
    tieCheck(multiply);
  });
  it("the tie case catches a multiply without the cap", () => {
    expectCaught(() => {
      tieCheck(multiplyUncapped);
    });
  });
  it("the oracle's exact value catches the double rounding of an uncapped multiply on long near-tie factors", () => {
    expectCaught(() => {
      checkMultiply(multiplyUncapped, factorLongArb, 500, exactMultiply);
    });
  });
});
