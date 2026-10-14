// ISO 4217 lookups (P3-02 step 1; his change 2): exponents and flags come
// from data/iso4217.json, which iso4217-data.test.ts proves is generated.
import { describe, expect, it } from "vitest";
import {
  ISO4217_SOURCE,
  currencyExponent,
  currencyInfo,
  isCurrencyCode,
  listCurrencies,
  parseCurrencyCode,
} from "../src/currency.js";
import type { CurrencyCode, CurrencyInfo } from "../src/currency.js";
import { expectMoneyError } from "./helpers.js";

describe("exponents and flags (his change 2)", () => {
  it.each([
    ["USD", 2, "840"],
    ["EUR", 2, "978"],
    ["GBP", 2, "826"],
    ["JPY", 0, "392"],
    ["BHD", 3, "048"],
    ["CLF", 4, "990"],
    ["SLE", 2, "925"],
  ])(
    "%s is current with exponent %i and numeric %s",
    (code, exponent, numeric) => {
      const parsed = parseCurrencyCode(code);
      expect(currencyExponent(parsed)).toBe(exponent);
      expect(currencyInfo(code)).toEqual(
        expect.objectContaining({
          code,
          exponent,
          numeric,
          historical: false,
          withdrawn: null,
        }),
      );
    },
  );

  it("SLE is the current Leone (exponent 2)", () => {
    expect(currencyInfo("SLE")).toEqual({
      code: "SLE",
      numeric: "925",
      name: "Leone",
      exponent: 2,
      historical: false,
      withdrawn: null,
    });
  });

  it("SLL is historical with its withdrawal date and no exponent, so it cannot form Money", () => {
    expect(currencyInfo("SLL")).toEqual({
      code: "SLL",
      numeric: "694",
      name: "Leone",
      exponent: null,
      historical: true,
      withdrawn: "2023-12",
    });
    expectMoneyError(() => parseCurrencyCode("SLL"), "historical_currency", [
      "SLL",
    ]);
    expect(isCurrencyCode("SLL")).toBe(false);
  });

  it("a code whose minor unit is N.A. (XAU) is listed but cannot form Money", () => {
    expect(currencyInfo("XAU")).toEqual(
      expect.objectContaining({ exponent: null, historical: false }),
    );
    expectMoneyError(() => parseCurrencyCode("XAU"), "no_minor_unit", ["XAU"]);
  });
});

describe("parseCurrencyCode is strict", () => {
  it.each(["usd", "US", "USDD", " USD", "USD ", "", "ZZZ", "U$D"])(
    "rejects %j with invalid_currency and never echoes it",
    (input) => {
      expectMoneyError(() => parseCurrencyCode(input), "invalid_currency", [
        input.trim(),
      ]);
      expect(isCurrencyCode(input)).toBe(false);
    },
  );

  it.each([840, null, undefined, {}, ["USD"]])(
    "rejects non-strings (%j)",
    (input) => {
      expectMoneyError(() => parseCurrencyCode(input), "invalid_currency");
    },
  );

  it("accepts a known code and returns the same string", () => {
    expect(parseCurrencyCode("USD")).toBe("USD");
    expect(isCurrencyCode("USD")).toBe(true);
  });

  it("currencyInfo is undefined for an unknown code", () => {
    expect(currencyInfo("ZZZ")).toBeUndefined();
  });

  it("currencyExponent throws invalid_currency for an unknown or unusable branded code", () => {
    // A branded code can only come from parseCurrencyCode; the cast forges
    // one so the defensive guard is exercised and never echoes the code.
    expectMoneyError(
      () => currencyExponent("ZZZ" as CurrencyCode),
      "invalid_currency",
      ["ZZZ"],
    );
    expectMoneyError(
      () => currencyExponent("XAU" as CurrencyCode),
      "invalid_currency",
      ["XAU"],
    );
  });
});

describe("listCurrencies", () => {
  it("lists only current codes with an exponent, sorted, without duplicates", () => {
    const list: readonly CurrencyInfo[] = listCurrencies();
    const codes = list.map((c) => c.code);
    expect(codes).toEqual([...codes].sort());
    expect(new Set(codes).size).toBe(codes.length);
    expect(list.every((c) => c.exponent !== null && !c.historical)).toBe(true);
    expect(codes).toContain("SLE");
    expect(codes).not.toContain("SLL");
    expect(codes).not.toContain("XAU");
  });

  it("returns frozen entries", () => {
    const [first] = listCurrencies();
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(listCurrencies())).toBe(true);
  });
});

describe("ISO4217_SOURCE", () => {
  it("records the dataset, pinned commit, upstream SIX lists, licence and retrieval date", () => {
    expect(ISO4217_SOURCE).toEqual(
      expect.objectContaining({
        commit: "ab9b0ae88e8bffd4ac1c468ce9c784738d3376ba",
        commitDate: "2026-02-01T02:10:25Z",
        licence: "ODC-PDDL-1.0",
        retrievedAt: "2026-10-13",
      }),
    );
    expect(ISO4217_SOURCE.url).toContain(
      "ab9b0ae88e8bffd4ac1c468ce9c784738d3376ba",
    );
    expect(ISO4217_SOURCE.upstream.join(" ")).toContain("list-one.xml");
    expect(ISO4217_SOURCE.upstream.join(" ")).toContain("list-three.xml");
  });
});
