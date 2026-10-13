// MoneyError carries a code and a fixed message chosen by the code. It never
// holds or prints the input (P3 rule 9), and has no `cause`.
export type MoneyErrorCode =
  | "invalid_amount"
  | "amount_not_string"
  | "out_of_range"
  | "too_many_fraction_digits"
  | "invalid_currency"
  | "historical_currency"
  | "no_minor_unit"
  | "currency_mismatch"
  | "not_money"
  | "invalid_rounding"
  | "invalid_factor"
  | "invalid_rate"
  | "rate_precision"
  | "invalid_ratio"
  | "negative_ratio"
  | "ratios_sum_zero"
  | "no_ratios"
  | "invalid_locale";

const messages: Readonly<Record<MoneyErrorCode, string>> = {
  invalid_amount:
    "not a minor unit amount: a bigint, or a string of digits with an optional leading minus sign, no leading zeros and no negative zero",
  amount_not_string: "the JSON amount must be a string of minor units",
  out_of_range: "the amount is outside the signed 64 bit range",
  too_many_fraction_digits:
    "more fraction digits than the currency's exponent; nothing is rounded",
  invalid_currency:
    "not a known ISO 4217 alphabetic code (three uppercase letters)",
  historical_currency: "a withdrawn ISO 4217 code; it cannot form Money",
  no_minor_unit:
    "an ISO 4217 code without a minor unit (N.A.); it cannot form Money",
  currency_mismatch: "the two amounts are in different currencies",
  not_money: "not a Money value made by @bricx/money",
  invalid_rounding: "not a Rounding mode",
  invalid_factor:
    "not a factor: a Decimal or a plain decimal string (no exponent)",
  invalid_rate:
    "not a rate: a positive, finite Decimal or a plain decimal string (no sign, no exponent)",
  rate_precision:
    "the rate does not fit NUMERIC(24,12): at most 12 integer and 12 fraction digits; nothing is rounded",
  invalid_ratio:
    "not a ratio: a bigint, a finite Decimal or a plain decimal string, at most 64 digits",
  negative_ratio: "an allocation ratio is negative",
  ratios_sum_zero: "the allocation ratios sum to zero",
  no_ratios: "no allocation ratios were given",
  invalid_locale: "not a locale Intl.NumberFormat accepts",
};

export class MoneyError extends Error {
  readonly code: MoneyErrorCode;

  constructor(code: MoneyErrorCode) {
    super(`${code}: ${messages[code]}`);
    this.code = code;
  }

  override get name(): string {
    return "MoneyError";
  }
}
