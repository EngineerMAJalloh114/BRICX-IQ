// MoneySchema (P3-02 step 5; his change 3): JSON carries the amount as a
// string of MINOR units: integer, optional leading "-", no "+", no
// whitespace, no leading zeros, no "-0", no exponent, no decimal point,
// inside signed 64 bits; the currency is an ISO 4217 code with a non-null
// exponent. Issue messages are codes and never contain the input.
import { describe, expect, it } from "vitest";
import { MAX_AMOUNT, MIN_AMOUNT, fromMinor, isMoney } from "../src/money.js";
import { MoneyJsonSchema, MoneySchema } from "../src/schema.js";
import { USD } from "./helpers.js";

function expectIssue(
  input: unknown,
  message: string,
  echo: readonly string[] = [],
): void {
  const result = MoneySchema.safeParse(input);
  expect(result.success).toBe(false);
  const issues = result.error?.issues ?? [];
  expect(issues.map((i) => i.message)).toContain(message);
  const dump = JSON.stringify(issues);
  for (const e of echo)
    if (e.trim().length > 0) expect(dump).not.toContain(e.trim());
  expect(issues.every((i) => !("input" in i))).toBe(true);
}

describe("MoneySchema decodes JSON to Money", () => {
  it("accepts canonical minor-unit strings", () => {
    const m = MoneySchema.parse({ amount: "-1234", currency: "USD" });
    expect(isMoney(m)).toBe(true);
    expect(m).toEqual({ amount: -1234n, currency: "USD" });
    expect(MoneySchema.parse({ amount: "0", currency: "JPY" }).amount).toBe(0n);
  });

  it("accepts both ends of the signed 64-bit range", () => {
    expect(
      MoneySchema.parse({ amount: MAX_AMOUNT.toString(), currency: "USD" })
        .amount,
    ).toBe(MAX_AMOUNT);
    expect(
      MoneySchema.parse({ amount: MIN_AMOUNT.toString(), currency: "USD" })
        .amount,
    ).toBe(MIN_AMOUNT);
  });

  it("encodes Money back to JSON with a string amount; the round trip preserves the value", () => {
    const m = fromMinor(MAX_AMOUNT, USD);
    const json = MoneySchema.encode(m);
    expect(json).toEqual({ amount: "9223372036854775807", currency: "USD" });
    const text = JSON.stringify(json);
    expect(MoneySchema.parse(JSON.parse(text))).toEqual(m);
  });

  it("MoneyJsonSchema validates the wire shape without decoding", () => {
    expect(MoneyJsonSchema.parse({ amount: "5", currency: "USD" })).toEqual({
      amount: "5",
      currency: "USD",
    });
  });
});

describe("rejections (one test each)", () => {
  it("a JSON number amount (float)", () => {
    expectIssue({ amount: 12.5, currency: "USD" }, "amount_not_string", [
      "12.5",
    ]);
  });
  it("a JSON number amount (integer)", () => {
    expectIssue({ amount: 1250, currency: "USD" }, "amount_not_string", [
      "1250",
    ]);
  });
  it("a bigint amount (not JSON)", () => {
    expectIssue({ amount: 1250n, currency: "USD" }, "amount_not_string");
  });
  it("a decimal point", () => {
    expectIssue({ amount: "12.50", currency: "USD" }, "invalid_amount", [
      "12.50",
    ]);
  });
  it("exponent notation", () => {
    expectIssue({ amount: "1e3", currency: "USD" }, "invalid_amount", ["1e3"]);
    expectIssue({ amount: "1E3", currency: "USD" }, "invalid_amount", ["1E3"]);
  });
  it("a leading zero", () => {
    expectIssue({ amount: "0123", currency: "USD" }, "invalid_amount", [
      "0123",
    ]);
    expectIssue({ amount: "-01", currency: "USD" }, "invalid_amount", ["-01"]);
  });
  it('"-0"', () => {
    expectIssue({ amount: "-0", currency: "USD" }, "invalid_amount");
  });
  it('a "+" sign', () => {
    expectIssue({ amount: "+5", currency: "USD" }, "invalid_amount", ["+5"]);
  });
  it("whitespace", () => {
    expectIssue({ amount: " 5", currency: "USD" }, "invalid_amount");
    expectIssue({ amount: "5 ", currency: "USD" }, "invalid_amount");
    expectIssue({ amount: "5\n", currency: "USD" }, "invalid_amount");
    expectIssue({ amount: "- 5", currency: "USD" }, "invalid_amount");
  });
  it("empty, a bare sign, hex and separators", () => {
    expectIssue({ amount: "", currency: "USD" }, "invalid_amount");
    expectIssue({ amount: "-", currency: "USD" }, "invalid_amount");
    expectIssue({ amount: "0x10", currency: "USD" }, "invalid_amount", [
      "0x10",
    ]);
    expectIssue({ amount: "1_000", currency: "USD" }, "invalid_amount", [
      "1_000",
    ]);
    expectIssue({ amount: "1,000", currency: "USD" }, "invalid_amount", [
      "1,000",
    ]);
  });
  it("above signed 64-bit", () => {
    expectIssue(
      { amount: "9223372036854775808", currency: "USD" },
      "out_of_range",
      ["9223372036854775808"],
    );
  });
  it("below signed 64-bit", () => {
    expectIssue(
      { amount: "-9223372036854775809", currency: "USD" },
      "out_of_range",
      ["9223372036854775809"],
    );
  });
  it("a very long digit string", () => {
    expectIssue({ amount: "9".repeat(400), currency: "USD" }, "out_of_range");
  });
  it("a lowercase or unknown currency", () => {
    expectIssue({ amount: "1", currency: "usd" }, "invalid_currency", ["usd"]);
    expectIssue({ amount: "1", currency: "ZZZ" }, "invalid_currency", ["ZZZ"]);
    expectIssue({ amount: "1", currency: 840 }, "invalid_currency", ["840"]);
  });
  it("a historical currency (SLL)", () => {
    expectIssue({ amount: "1", currency: "SLL" }, "historical_currency", [
      "SLL",
    ]);
  });
  it("a currency whose exponent is null (XAU)", () => {
    expectIssue({ amount: "1", currency: "XAU" }, "no_minor_unit", ["XAU"]);
  });
  it("a missing field, an extra field, or not an object", () => {
    expectIssue({ amount: "1" }, "invalid_currency");
    expectIssue({ currency: "USD" }, "amount_not_string");
    expectIssue({ amount: "1", currency: "USD", rate: "2" }, "unknown_key");
    expectIssue("1 USD", "not_an_object", ["1 USD"]);
  });
});
