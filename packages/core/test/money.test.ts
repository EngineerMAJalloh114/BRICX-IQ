import { describe, expect, it } from "vitest";
import {
  add,
  allocate,
  divRoundHalfEven,
  formatMoney,
  money,
  multiply,
  parseMoney,
  subtract,
  sum,
  toDecimalString,
} from "../src/money";

describe("money", () => {
  it("stores integer minor units", () => {
    expect(parseMoney("1234.56", "USD").amountMinor).toBe(123456n);
    expect(parseMoney("500", "JPY").amountMinor).toBe(500n);
    expect(parseMoney("1.234", "KWD").amountMinor).toBe(1234n);
    expect(parseMoney("-0.5", "EUR").amountMinor).toBe(-50n);
  });

  it("rejects floats and too many decimals", () => {
    expect(() => money(1.5, "USD")).toThrow();
    expect(() => parseMoney("1.234", "USD")).toThrow();
    expect(() => parseMoney("1.5", "JPY")).toThrow();
    expect(() => money(1, "usd")).toThrow();
  });

  it("round-trips to decimal strings", () => {
    expect(toDecimalString(money(5, "USD"))).toBe("0.05");
    expect(toDecimalString(money(-123456, "USD"))).toBe("-1234.56");
    expect(toDecimalString(money(7, "JPY"))).toBe("7");
    expect(toDecimalString(money(1, "KWD"))).toBe("0.001");
  });

  it("adds exactly where floats would drift", () => {
    const tenCents = parseMoney("0.10", "USD");
    const total = sum(Array(10).fill(tenCents), "USD");
    expect(toDecimalString(total)).toBe("1.00");
    expect(subtract(add(tenCents, tenCents), tenCents)).toEqual(tenCents);
  });

  it("refuses to mix currencies", () => {
    expect(() => add(money(1, "USD"), money(1, "EUR"))).toThrow(/Currency mismatch/);
  });

  it("handles amounts beyond Number.MAX_SAFE_INTEGER", () => {
    const big = parseMoney("99999999999999999.99", "USD");
    expect(toDecimalString(add(big, money(1, "USD")))).toBe("100000000000000000.00");
  });

  it("rounds half to even", () => {
    expect(divRoundHalfEven(5n, 2n)).toBe(2n);
    expect(divRoundHalfEven(7n, 2n)).toBe(4n);
    expect(divRoundHalfEven(-5n, 2n)).toBe(-2n);
    expect(divRoundHalfEven(-7n, 2n)).toBe(-4n);
    expect(divRoundHalfEven(10n, 3n)).toBe(3n);
    expect(divRoundHalfEven(11n, -3n)).toBe(-4n);
  });

  it("multiplies by decimal factors", () => {
    // 15% VAT on 19.99 = 2.9985 -> 3.00
    expect(toDecimalString(multiply(parseMoney("19.99", "USD"), "0.15"))).toBe("3.00");
    expect(toDecimalString(multiply(parseMoney("100.00", "USD"), "1.075"))).toBe("107.50");
  });

  it("allocates without losing a minor unit", () => {
    const parts = allocate(parseMoney("100.00", "USD"), [1, 1, 1]);
    expect(parts.map(toDecimalString)).toEqual(["33.34", "33.33", "33.33"]);
    expect(sum(parts, "USD").amountMinor).toBe(10000n);

    const neg = allocate(money(-10, "USD"), [1, 2]);
    expect(neg.map((m) => m.amountMinor)).toEqual([-4n, -6n]);

    const skipZero = allocate(money(5, "USD"), [0, 1, 1]);
    expect(skipZero.map((m) => m.amountMinor)).toEqual([0n, 3n, 2n]);
  });

  it("formats for a locale", () => {
    expect(formatMoney(parseMoney("1234.5", "USD"), "en-US")).toBe("$1,234.50");
    expect(formatMoney(parseMoney("1234.5", "EUR"), "fr-FR")).toMatch(/1\s234,50\s€/);
    expect(formatMoney(parseMoney("1234", "JPY"), "ja-JP")).toMatch(/1,234/);
  });
});
