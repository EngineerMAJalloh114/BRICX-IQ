// I18nError carries a code and a fixed message chosen by the code. It never
// includes the input (locale tags, keys, argument values, message text) and
// never sets `cause`, which could carry it (P3 rule 8).

const messages = {
  invalid_locale: "not a well-formed BCP 47 language tag",
  locale_too_long: "the language tag is longer than the limit",
  unsupported_locale: "not one of the supported locales (en, fr, ar)",
  invalid_chain: "the locale fallback chain must be an array",
  chain_too_long: "the locale fallback chain has more entries than the limit",
  intl_unavailable: "Intl.getCanonicalLocales is not available in this runtime",
  invalid_key: "a message key must be a string",
  key_too_long: "the message key is longer than the limit",
  unknown_key: "not a known message key (namespace:key)",
  invalid_arguments: "message arguments must be a plain object",
  too_many_arguments: "more message arguments than the limit",
  missing_argument: "a message argument is missing",
  unexpected_argument: "an argument the message does not use",
  invalid_argument: "a message argument has the wrong type",
  argument_too_long: "a string argument is longer than the limit",
  format_failed: "the message could not be formatted",
} as const;

export type I18nErrorCode = keyof typeof messages;

/** Every code, for exhaustive tests and documentation. */
export const I18N_ERROR_CODES: readonly I18nErrorCode[] = Object.freeze(
  Object.keys(messages) as I18nErrorCode[],
);

export class I18nError extends Error {
  readonly code: I18nErrorCode;

  constructor(code: I18nErrorCode) {
    super(`${code}: ${messages[code]}`);
    this.name = "I18nError";
    this.code = code;
  }
}
