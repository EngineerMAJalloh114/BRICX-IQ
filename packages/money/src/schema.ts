// MoneySchema (P3-02 step 5; his change 3): JSON carries the amount as a
// string of MINOR units: integer, optional leading "-", no "+", no
// whitespace, no leading zeros, no "-0", no exponent, no decimal point,
// inside signed 64 bits; the currency is an ISO 4217 code with a non-null
// exponent. decode = parse (JSON -> Money), encode (Money -> JSON). Issue
// messages are MoneyError codes and never include the input.
import { z } from "zod";
import { parseCurrencyCode } from "./currency.js";
import { MoneyError } from "./errors.js";
import { fromMinor, parseMinor, toMoneyJson } from "./money.js";
import type { Money, MoneyJson } from "./money.js";

const code = (fn: () => unknown): string | null => {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof MoneyError ? error.code : "invalid_amount";
  }
};

const AmountString = z
  .string({ error: () => "amount_not_string" })
  .check((ctx) => {
    const issue = code(() => fromMinor(ctx.value, "USD"));
    if (issue !== null)
      ctx.issues.push({ code: "custom", message: issue, input: undefined });
  });

const CurrencyString = z
  .string({ error: () => "invalid_currency" })
  .check((ctx) => {
    const issue = code(() => parseCurrencyCode(ctx.value));
    if (issue !== null)
      ctx.issues.push({ code: "custom", message: issue, input: undefined });
  });

/** The wire shape, validated but not decoded. */
export const MoneyJsonSchema = z.strictObject(
  { amount: AmountString, currency: CurrencyString },
  {
    error: (issue) =>
      issue.code === "unrecognized_keys" ? "unknown_key" : "not_an_object",
  },
);

/** JSON <-> Money codec: parse() gives Money, encode() gives the wire shape. */
export const MoneySchema = z.codec(MoneyJsonSchema, z.custom<Money>(), {
  decode: (json): Money => fromMinor(parseMinor(json.amount), json.currency),
  encode: (money): MoneyJson => toMoneyJson(money),
});
