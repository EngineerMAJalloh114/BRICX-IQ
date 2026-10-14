// I18nError (P3 rule 8): a stable code and a fixed message per code; never
// the input, never a cause that could carry it.
import { describe, expect, it } from "vitest";
import { I18N_ERROR_CODES, I18nError } from "../src/errors.ts";

describe("I18nError", () => {
  it("has the documented codes", () => {
    expect([...I18N_ERROR_CODES].sort()).toEqual(
      [
        "argument_too_long",
        "chain_too_long",
        "format_failed",
        "intl_unavailable",
        "invalid_argument",
        "invalid_arguments",
        "invalid_chain",
        "invalid_key",
        "invalid_locale",
        "key_too_long",
        "locale_too_long",
        "missing_argument",
        "too_many_arguments",
        "unexpected_argument",
        "unknown_key",
        "unsupported_locale",
      ].sort(),
    );
  });

  it.each([...I18N_ERROR_CODES])(
    "%s: fixed message, name, no cause",
    (code) => {
      const error = new I18nError(code);
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe("I18nError");
      expect(error.code).toBe(code);
      expect(error.message.startsWith(`${code}: `)).toBe(true);
      expect(error.message.length).toBeGreaterThan(code.length + 10);
      expect(error.cause).toBeUndefined();
      expect(new I18nError(code).message).toBe(error.message);
    },
  );
});
