// Issue codes and i18n keys (P3-04 D10, D11, architect item 1, rulings 5 and
// 7). Every validation code, every error-envelope code and every MoneyError
// code has an i18n key in en, fr and ar. The drift test fails when
// @bricx/money adds a code without an errors:money.<code> key. fr and ar text
// is machine-drafted (ADR 0046, ADR 0047): these tests check presence only
// and never mark anything reviewed.
import { MONEY_ERROR_CODES } from "@bricx/money/errors";
import { MESSAGE_ARGS } from "@bricx/i18n/keys";
import { KEY_PATTERN } from "@bricx/i18n/limits";
import { describe, expect, it } from "vitest";
import {
  ERROR_CODES,
  ERROR_CODE_PATTERN,
  ERROR_KEYS,
  ERROR_STATUS,
  ISSUE_CODES,
  MONEY_ERROR_KEYS,
  VALIDATION_CODES,
  VALIDATION_KEYS,
  isErrorCode,
  issueKey,
} from "../src/codes.ts";
import { keyProblems, loadCatalogs } from "./catalogs.ts";

const catalogs = loadCatalogs();

describe("MoneyError keys: errors:money.<code> (architect item 1)", () => {
  it("MONEY_ERROR_KEYS has exactly one key per MONEY_ERROR_CODES entry", () => {
    expect(Object.keys(MONEY_ERROR_KEYS).sort()).toEqual(
      [...MONEY_ERROR_CODES].sort(),
    );
    for (const code of MONEY_ERROR_CODES) {
      expect(MONEY_ERROR_KEYS[code]).toBe(`errors:money.${code}`);
    }
  });

  it("every money code fits the i18n key pattern as a key segment (ruling 7)", () => {
    // If a money code ever fails this, the test names it and fails: the fix
    // is to rename the code in @bricx/money (a reviewed change), never to
    // transform or skip it here.
    const bad = MONEY_ERROR_CODES.filter(
      (code) => !KEY_PATTERN.test(`money.${code}`),
    );
    expect(bad).toEqual([]);
  });

  it("every money key exists in en, fr and ar, and fr/ar are not copies of en", () => {
    expect(keyProblems(Object.values(MONEY_ERROR_KEYS), catalogs)).toEqual([]);
  });

  it("drift: a money code without a key is reported in every locale", () => {
    const keys = [...MONEY_ERROR_CODES, "fake_code"].map(
      (code) => `errors:money.${code}`,
    );
    expect(keyProblems(keys, catalogs)).toEqual([
      "en: errors:money.fake_code missing",
      "fr: errors:money.fake_code missing",
      "ar: errors:money.fake_code missing",
    ]);
  });

  it("drift: an fr or ar entry copied from en is reported", () => {
    const copied = {
      ...catalogs,
      fr: {
        ...catalogs.fr,
        errors: {
          ...catalogs.fr.errors,
          "money.invalid_amount":
            catalogs.en.errors?.["money.invalid_amount"] ?? "",
        },
      },
    };
    expect(keyProblems(Object.values(MONEY_ERROR_KEYS), copied)).toEqual([
      "fr: errors:money.invalid_amount is a copy of en",
    ]);
  });

  it("no money key takes ICU arguments (an issue carries none)", () => {
    for (const key of Object.values(MONEY_ERROR_KEYS)) {
      expect(MESSAGE_ARGS[key]).toEqual({});
    }
  });
});

describe("validation issue codes", () => {
  it("VALIDATION_KEYS maps every code to validation:<code>", () => {
    expect(Object.keys(VALIDATION_KEYS).sort()).toEqual(
      [...VALIDATION_CODES].sort(),
    );
    for (const code of VALIDATION_CODES) {
      expect(VALIDATION_KEYS[code]).toBe(`validation:${code}`);
    }
  });

  it("every validation key exists in en, fr and ar, takes no arguments", () => {
    expect(keyProblems(Object.values(VALIDATION_KEYS), catalogs)).toEqual([]);
    for (const key of Object.values(VALIDATION_KEYS)) {
      expect(MESSAGE_ARGS[key]).toEqual({});
    }
  });

  it("ISSUE_CODES are the validation codes then money.<code>", () => {
    expect([...ISSUE_CODES]).toEqual([
      ...VALIDATION_CODES,
      ...MONEY_ERROR_CODES.map((c) => `money.${c}`),
    ]);
    expect(issueKey("invalid_email")).toBe("validation:invalid_email");
    expect(issueKey("money.out_of_range")).toBe("errors:money.out_of_range");
  });

  it("the code lists are frozen", () => {
    expect(Object.isFrozen(VALIDATION_CODES)).toBe(true);
    expect(Object.isFrozen(ISSUE_CODES)).toBe(true);
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });
});

describe("error envelope codes", () => {
  it("every code maps to errors:<code> with an HTTP status", () => {
    expect(Object.keys(ERROR_KEYS).sort()).toEqual([...ERROR_CODES].sort());
    for (const code of ERROR_CODES) {
      expect(ERROR_KEYS[code]).toBe(`errors:${code}`);
      expect(ERROR_STATUS[code]).toBeGreaterThanOrEqual(400);
      expect(ERROR_STATUS[code]).toBeLessThan(600);
    }
    expect(keyProblems(Object.values(ERROR_KEYS), catalogs)).toEqual([]);
  });

  it("the statuses are fixed", () => {
    expect(ERROR_STATUS).toEqual({
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
    });
  });

  it("only validation_failed takes an argument: fields, the issue count", () => {
    for (const code of ERROR_CODES) {
      expect(MESSAGE_ARGS[ERROR_KEYS[code]]).toEqual(
        code === "validation_failed" ? { fields: "number" } : {},
      );
    }
  });
});

// P4-07 (ADR 0057, amends 0047; P4 phase plan D10): the registry is
// namespaced. A code is one to four dotted segments of [a-z][a-z0-9_]*;
// the first eight codes keep their one-segment names. Only codes a test
// raises are registered (owner condition 4).
describe("the namespaced error-code registry (P4-07)", () => {
  it("every code matches ERROR_CODE_PATTERN and the i18n key pattern", () => {
    expect(ERROR_CODE_PATTERN.source).toBe(
      "^[a-z][a-z0-9_]*(?:\\.[a-z][a-z0-9_]*){0,3}$",
    );
    for (const code of ERROR_CODES) {
      expect(ERROR_CODE_PATTERN.test(code)).toBe(true);
      expect(KEY_PATTERN.test(code)).toBe(true);
    }
    for (const bad of [
      "",
      "Request.malformed",
      "request..malformed",
      ".request",
      "request.",
      "a.b.c.d.e",
      "request-malformed",
      "1request",
    ]) {
      expect(ERROR_CODE_PATTERN.test(bad)).toBe(false);
    }
  });

  it("holds the eight P3-04 codes, then the request.* and idempotency.* codes, then unauthenticated (P5-02), in this order", () => {
    expect([...ERROR_CODES]).toEqual([
      "validation_failed",
      "session_expired",
      "forbidden",
      "not_found",
      "conflict_financial",
      "rate_limited",
      "generic",
      "server_unavailable",
      "request.malformed",
      "request.body_too_large",
      "request.unsupported_media_type",
      "request.conflict",
      "idempotency.key_missing",
      "idempotency.key_invalid",
      "idempotency.key_reused",
      "idempotency.response_too_large",
      "unauthenticated",
    ]);
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it("isErrorCode accepts registered codes only, never a prototype name", () => {
    expect(isErrorCode("request.conflict")).toBe(true);
    expect(isErrorCode("generic")).toBe(true);
    expect(isErrorCode("request.method_not_allowed")).toBe(false);
    expect(isErrorCode("constructor")).toBe(false);
    expect(isErrorCode("__proto__")).toBe(false);
    expect(isErrorCode(42)).toBe(false);
    expect(isErrorCode(undefined)).toBe(false);
  });

  it("every namespaced key exists in en, fr and ar, is not a copy, takes no argument", () => {
    const namespaced = ERROR_CODES.filter((code) => code.includes("."));
    expect(namespaced.length).toBe(8);
    expect(
      keyProblems(
        namespaced.map((code) => ERROR_KEYS[code]),
        catalogs,
      ),
    ).toEqual([]);
    for (const code of namespaced) {
      expect(MESSAGE_ARGS[ERROR_KEYS[code]]).toEqual({});
    }
  });

  it("drift: a registered code without a key is reported in every locale", () => {
    expect(keyProblems(["errors:request.not_a_code"], catalogs)).toEqual([
      "en: errors:request.not_a_code missing",
      "fr: errors:request.not_a_code missing",
      "ar: errors:request.not_a_code missing",
    ]);
  });
});
