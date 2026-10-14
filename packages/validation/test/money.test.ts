// ./money (P3-04 D6, architect item 2): the same MoneySchema object as
// @bricx/money, never redefined.
import * as moneySchema from "@bricx/money/schema";
import { describe, expect, it } from "vitest";
import { MoneyJsonSchema, MoneySchema } from "../src/money.ts";

describe("./money re-exports @bricx/money's schema", () => {
  it("MoneySchema is the identical object", () => {
    expect(MoneySchema).toBe(moneySchema.MoneySchema);
  });

  it("MoneyJsonSchema is the identical object", () => {
    expect(MoneyJsonSchema).toBe(moneySchema.MoneyJsonSchema);
  });

  it("parses a JSON amount of minor units and rejects a float", () => {
    expect(MoneySchema.parse({ amount: "12345", currency: "SLE" }).amount).toBe(
      12345n,
    );
    expect(
      MoneySchema.safeParse({ amount: 1.5, currency: "USD" }).success,
    ).toBe(false);
  });
});
