// format (P3-02 step 4; his change 6): Intl.NumberFormat with fraction
// digits from the exponent, fed an exact decimal string so no float is
// involved and amounts above 2^53 print exactly.
import { describe, expect, it } from "vitest";
import { formatMoney } from "../src/format.js";
import { MAX_AMOUNT, MIN_AMOUNT, fromMinor } from "../src/money.js";
import {
  BHD,
  CLF,
  JPY,
  SLE,
  TWO_POW_53,
  USD,
  expectMoneyError,
} from "./helpers.js";

// Intl inserts U+00A0 / U+202F between parts in some locales.
const plain = (s: string) => s.replace(/[\u00a0\u202f]/g, " ");

describe("formatMoney", () => {
  it("JPY has no fraction digits (exponent 0)", () => {
    expect(formatMoney(fromMinor(1234n, JPY), "en-US")).toBe("¥1,234");
    expect(formatMoney(fromMinor(1234n, JPY), "ja-JP")).toBe("￥1,234");
  });

  it("BHD has three fraction digits (exponent 3)", () => {
    expect(plain(formatMoney(fromMinor(1234n, BHD), "en-US"))).toBe(
      "BHD 1.234",
    );
    expect(plain(formatMoney(fromMinor(1n, BHD), "en-US"))).toBe("BHD 0.001");
  });

  it("SLE has two fraction digits (exponent 2)", () => {
    expect(plain(formatMoney(fromMinor(1234n, SLE), "en-US"))).toBe(
      "SLE 12.34",
    );
    expect(plain(formatMoney(fromMinor(5n, SLE), "en-US"))).toBe("SLE 0.05");
  });

  it("CLF has four (exponent 4)", () => {
    expect(plain(formatMoney(fromMinor(12345n, CLF), "en-US"))).toBe(
      "CLF 1.2345",
    );
  });

  it("USD in en-US and fr-FR, negative amounts", () => {
    expect(formatMoney(fromMinor(123456n, USD), "en-US")).toBe("$1,234.56");
    expect(plain(formatMoney(fromMinor(123456n, USD), "fr-FR"))).toBe(
      "1 234,56 $US",
    );
    expect(formatMoney(fromMinor(-5n, USD), "en-US")).toBe("-$0.05");
  });

  it("formats an amount above 2^53 exactly (his change 6)", () => {
    expect(formatMoney(fromMinor(TWO_POW_53 + 1n, USD), "en-US")).toBe(
      "$90,071,992,547,409.93",
    );
    expect(formatMoney(fromMinor(MAX_AMOUNT, USD), "en-US")).toBe(
      "$92,233,720,368,547,758.07",
    );
    expect(formatMoney(fromMinor(MIN_AMOUNT, JPY), "en-US")).toBe(
      "-¥9,223,372,036,854,775,808",
    );
    expect(plain(formatMoney(fromMinor(TWO_POW_53 + 1n, BHD), "en-US"))).toBe(
      "BHD 9,007,199,254,740.993",
    );
  });

  it("currencyDisplay can be set", () => {
    expect(
      plain(
        formatMoney(fromMinor(100n, USD), "en-US", { currencyDisplay: "code" }),
      ),
    ).toBe("USD 1.00");
  });

  it("an invalid locale throws invalid_locale without echoing it", () => {
    expectMoneyError(
      () => formatMoney(fromMinor(1n, USD), "not a locale!"),
      "invalid_locale",
      ["not a locale!"],
    );
  });
});
