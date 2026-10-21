// Issue codes, error codes and their i18n keys (P3-04 D9-D11, architect
// items 1 and 5). An issue carries a code from ISSUE_CODES and its key; an
// envelope carries a code from ERROR_CODES, its HTTP status and its key.
// Every key is a real message key (MessageKey from @bricx/i18n's generated
// map), so a missing key fails the build; MONEY_ERROR_KEYS is exhaustive
// over MoneyErrorCode, so a new money code without a key fails the build too.
// fr and ar text behind these keys is machine-drafted (ADR 0046, ADR 0047).
// P4-07 (ADR 0057, amends 0047): the error-code registry is namespaced
// (ERROR_CODE_PATTERN); the first eight codes keep their one-segment names.
// Only a code a test raises is registered (owner condition 4).
// P5-02 (ADR 0062, owner condition 4): `unauthenticated` (401) is every
// bearer-token failure, one code whatever the reason.
import type { MessageKey } from "@bricx/i18n/keys";
import { MONEY_ERROR_CODES } from "@bricx/money/errors";
import type { MoneyErrorCode } from "@bricx/money/errors";

/** Codes the validation schemas report; each has a validation:<code> key. */
export const VALIDATION_CODES = Object.freeze([
  "required",
  "invalid_value",
  "unknown_field",
  "too_large",
  "invalid_email",
  "invalid_phone",
  "invalid_country",
  "invalid_time_zone",
  "invalid_language_tag",
  "invalid_locale",
  "invalid_geo_point",
  "invalid_latitude",
  "invalid_longitude",
  "invalid_cursor",
  "invalid_page_size",
] as const);
export type ValidationCode = (typeof VALIDATION_CODES)[number];

export const VALIDATION_KEYS = Object.freeze({
  required: "validation:required",
  invalid_value: "validation:invalid_value",
  unknown_field: "validation:unknown_field",
  too_large: "validation:too_large",
  invalid_email: "validation:invalid_email",
  invalid_phone: "validation:invalid_phone",
  invalid_country: "validation:invalid_country",
  invalid_time_zone: "validation:invalid_time_zone",
  invalid_language_tag: "validation:invalid_language_tag",
  invalid_locale: "validation:invalid_locale",
  invalid_geo_point: "validation:invalid_geo_point",
  invalid_latitude: "validation:invalid_latitude",
  invalid_longitude: "validation:invalid_longitude",
  invalid_cursor: "validation:invalid_cursor",
  invalid_page_size: "validation:invalid_page_size",
} as const satisfies Record<ValidationCode, MessageKey>);

/** errors:money.<code> for every MoneyError code (architect item 1). */
export const MONEY_ERROR_KEYS = Object.freeze({
  invalid_amount: "errors:money.invalid_amount",
  amount_not_string: "errors:money.amount_not_string",
  out_of_range: "errors:money.out_of_range",
  too_many_fraction_digits: "errors:money.too_many_fraction_digits",
  invalid_currency: "errors:money.invalid_currency",
  historical_currency: "errors:money.historical_currency",
  no_minor_unit: "errors:money.no_minor_unit",
  currency_mismatch: "errors:money.currency_mismatch",
  not_money: "errors:money.not_money",
  invalid_rounding: "errors:money.invalid_rounding",
  invalid_factor: "errors:money.invalid_factor",
  factor_precision: "errors:money.factor_precision",
  invalid_rate: "errors:money.invalid_rate",
  rate_precision: "errors:money.rate_precision",
  invalid_ratio: "errors:money.invalid_ratio",
  negative_ratio: "errors:money.negative_ratio",
  ratios_sum_zero: "errors:money.ratios_sum_zero",
  no_ratios: "errors:money.no_ratios",
  invalid_locale: "errors:money.invalid_locale",
} as const satisfies Record<MoneyErrorCode, MessageKey>);

export type MoneyIssueCode = `money.${MoneyErrorCode}`;
export type IssueCode = ValidationCode | MoneyIssueCode;

const moneyIssue = (code: MoneyErrorCode): MoneyIssueCode => `money.${code}`;

/** Every issue code: the validation codes, then money.<code>. */
export const ISSUE_CODES: readonly IssueCode[] = Object.freeze([
  ...VALIDATION_CODES,
  ...MONEY_ERROR_CODES.map(moneyIssue),
]);

const ISSUE_KEYS: ReadonlyMap<string, MessageKey> = new Map<string, MessageKey>(
  [
    ...VALIDATION_CODES.map((c): [string, MessageKey] => [
      c,
      VALIDATION_KEYS[c],
    ]),
    ...MONEY_ERROR_CODES.map((c): [string, MessageKey] => [
      moneyIssue(c),
      MONEY_ERROR_KEYS[c],
    ]),
  ],
);

export const isIssueCode = (value: unknown): value is IssueCode =>
  typeof value === "string" && ISSUE_KEYS.has(value);

/** The i18n key for an issue code. */
export function issueKey(code: IssueCode): MessageKey {
  return ISSUE_KEYS.get(code) ?? VALIDATION_KEYS.invalid_value;
}

/**
 * The shape of an envelope code: one to four dotted segments of
 * [a-z][a-z0-9_]* (request.malformed, idempotency.key_reused).
 */
export const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){0,3}$/;

/** Codes an error envelope carries; each has an errors:<code> key. */
export const ERROR_CODES = Object.freeze([
  "validation_failed",
  "session_expired",
  "forbidden",
  "not_found",
  "conflict_financial",
  "rate_limited",
  "generic",
  "server_unavailable",
  // request.*: the request itself could not be taken (P4-07).
  "request.malformed",
  "request.body_too_large",
  "request.unsupported_media_type",
  "request.conflict",
  // idempotency.*: the Idempotency-Key header and the stored answer (P4-07).
  "idempotency.key_missing",
  "idempotency.key_invalid",
  "idempotency.key_reused",
  "idempotency.response_too_large",
  // P5-02: a missing, malformed, unverifiable or expired bearer token.
  "unauthenticated",
] as const);
export type ErrorCode = (typeof ERROR_CODES)[number];

const ERROR_SET: ReadonlySet<string> = new Set(ERROR_CODES);

/** Whether `value` is a registered envelope code (never a prototype name). */
export const isErrorCode = (value: unknown): value is ErrorCode =>
  typeof value === "string" && ERROR_SET.has(value);

/** The HTTP status for each envelope code. */
export const ERROR_STATUS = Object.freeze({
  validation_failed: 422,
  session_expired: 401,
  forbidden: 403,
  not_found: 404,
  conflict_financial: 409,
  rate_limited: 429,
  generic: 500,
  server_unavailable: 503,
  "request.malformed": 400,
  "request.body_too_large": 413,
  "request.unsupported_media_type": 415,
  "request.conflict": 409,
  "idempotency.key_missing": 400,
  "idempotency.key_invalid": 400,
  "idempotency.key_reused": 422,
  "idempotency.response_too_large": 500,
  unauthenticated: 401,
} as const satisfies Record<ErrorCode, number>);

/**
 * The i18n key for each envelope code. Only errors:validation_failed takes
 * an argument: `fields`, the number of issues.
 */
export const ERROR_KEYS = Object.freeze({
  validation_failed: "errors:validation_failed",
  session_expired: "errors:session_expired",
  forbidden: "errors:forbidden",
  not_found: "errors:not_found",
  conflict_financial: "errors:conflict_financial",
  rate_limited: "errors:rate_limited",
  generic: "errors:generic",
  server_unavailable: "errors:server_unavailable",
  "request.malformed": "errors:request.malformed",
  "request.body_too_large": "errors:request.body_too_large",
  "request.unsupported_media_type": "errors:request.unsupported_media_type",
  "request.conflict": "errors:request.conflict",
  "idempotency.key_missing": "errors:idempotency.key_missing",
  "idempotency.key_invalid": "errors:idempotency.key_invalid",
  "idempotency.key_reused": "errors:idempotency.key_reused",
  "idempotency.response_too_large": "errors:idempotency.response_too_large",
  unauthenticated: "errors:unauthenticated",
} as const satisfies Record<ErrorCode, MessageKey>);
