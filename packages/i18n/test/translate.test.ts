// createTranslator: i18next + i18next-icu over the bundled catalogs, typed
// keys and arguments, checked at run time too (D6), errors with codes only.
import { afterEach, describe, expect, it, vi } from "vitest";
import { LIMITS } from "../src/limits.ts";
import { createTranslator } from "../src/translate.ts";
import type { SupportedLocale } from "../src/locale.ts";
import {
  ARABIC_INDIC_DIGIT,
  SENTINEL,
  expectI18nError,
  intlWithout,
  timed,
} from "./helpers.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Untyped view of `t`, for the run-time checks the types already forbid. */
type LooseT = (key: unknown, args?: unknown) => string;
const loose = (locale: SupportedLocale): LooseT => {
  const translator = createTranslator(locale);
  return translator.t as unknown as LooseT;
};

describe("createTranslator", () => {
  it.each([
    ["en", "Save", "ltr"],
    ["fr", "Enregistrer", "ltr"],
    ["ar", "حفظ", "rtl"],
  ] as const)(
    "%s: t('common:save') = %s, direction %s",
    (locale, text, direction) => {
      const translator = createTranslator(locale);
      expect(translator.locale).toBe(locale);
      expect(translator.direction).toBe(direction);
      expect(translator.t("common:save")).toBe(text);
    },
  );

  it("is frozen", () => {
    const translator = createTranslator("en");
    expect(Object.isFrozen(translator)).toBe(true);
  });

  it("rejects an unsupported or malformed locale without echoing it", () => {
    const create = createTranslator as unknown as (locale: unknown) => unknown;
    expectI18nError(() => create("de"), "unsupported_locale");
    expectI18nError(() => create("EN"), "unsupported_locale");
    expectI18nError(() => create(SENTINEL), "unsupported_locale");
    expectI18nError(() => create(undefined), "unsupported_locale");
  });

  it("formats simple, select and number arguments", () => {
    const en = createTranslator("en");
    expect(en.t("common:welcome_user", { name: "Aminata" })).toBe(
      "Welcome, Aminata",
    );
    expect(en.t("common:welcome_user", { name: 7 })).toBe("Welcome, 7");
    expect(en.t("construction:site_status", { status: "on_hold" })).toBe(
      "On hold",
    );
    expect(en.t("construction:site_status", { status: "demolished" })).toBe(
      "Unknown status",
    );
    expect(en.t("validation:too_long", { max: 1200 })).toBe(
      "Use at most 1,200 characters.",
    );
    expect(en.t("finance:retention_held", { amount: "Le 1,250.00" })).toBe(
      "Retention held: Le 1,250.00",
    );
  });

  it("ar numbers use Latin digits (D3)", () => {
    const ar = createTranslator("ar");
    const out = ar.t("validation:out_of_range", { min: 1000, max: 250000 });
    expect(out).toContain("1,000");
    expect(out).toContain("250,000");
    expect(out).not.toMatch(ARABIC_INDIC_DIGIT);
  });

  it("argument values are inserted as text, never re-interpolated", () => {
    const en = createTranslator("en");
    for (const value of [
      "{{name}}",
      "$t(common:save)",
      "{name}",
      "{x, plural, other {#}}",
      "<b>x</b>",
    ]) {
      expect(en.t("common:welcome_user", { name: value })).toBe(
        `Welcome, ${value}`,
      );
    }
  });
});

describe("run-time key and argument checks", () => {
  const t = loose("en");

  it("unknown and malformed keys", () => {
    expectI18nError(() => t(`common:${SENTINEL}`), "unknown_key");
    expectI18nError(() => t("save"), "unknown_key");
    expectI18nError(() => t("common:"), "unknown_key");
    expectI18nError(() => t("toString"), "unknown_key");
    expectI18nError(() => t("__proto__"), "unknown_key");
    expectI18nError(() => t(42), "invalid_key");
    expectI18nError(() => t(undefined), "invalid_key");
  });

  it(`a key over ${String(LIMITS.key)} characters is rejected quickly`, () => {
    expectI18nError(
      () => t("common:" + "a".repeat(LIMITS.key)),
      "key_too_long",
    );
    const huge = "common:" + "a".repeat(1_000_000);
    expect(
      timed(() => expectI18nError(() => t(huge), "key_too_long")),
    ).toBeLessThan(50);
  });

  it("missing, unexpected and mistyped arguments", () => {
    expectI18nError(() => t("common:welcome_user"), "missing_argument");
    expectI18nError(() => t("common:welcome_user", {}), "missing_argument");
    expectI18nError(
      () => t("common:welcome_user", { name: undefined }),
      "missing_argument",
    );
    expectI18nError(
      () => t("common:welcome_user", { name: "A", [SENTINEL]: 1 }),
      "unexpected_argument",
    );
    expectI18nError(
      () => t("common:save", { name: "A" }),
      "unexpected_argument",
    );
    expectI18nError(
      () => t("field:defects_open", { defects: "3" }),
      "invalid_argument",
    );
    expectI18nError(
      () => t("field:defects_open", { defects: Number.NaN }),
      "invalid_argument",
    );
    expectI18nError(
      () => t("field:defects_open", { defects: Number.POSITIVE_INFINITY }),
      "invalid_argument",
    );
    expectI18nError(
      () => t("field:defects_open", { defects: 3n }),
      "invalid_argument",
    );
    expectI18nError(
      () => t("construction:site_status", { status: 1 }),
      "invalid_argument",
    );
    expectI18nError(
      () => t("common:welcome_user", { name: { toString: () => SENTINEL } }),
      "invalid_argument",
    );
    expectI18nError(
      () => t("common:welcome_user", { name: null }),
      "invalid_argument",
    );
  });

  it("arguments must be a plain object", () => {
    expectI18nError(
      () => t("common:welcome_user", "Aminata"),
      "invalid_arguments",
    );
    expectI18nError(
      () => t("common:welcome_user", ["Aminata"]),
      "invalid_arguments",
    );
    expectI18nError(() => t("common:welcome_user", null), "invalid_arguments");
    expectI18nError(
      () => t("common:welcome_user", new Map([["name", "A"]])),
      "invalid_arguments",
    );
  });

  it(`more than ${String(LIMITS.args)} arguments are rejected quickly`, () => {
    const many = Object.fromEntries(
      Array.from({ length: LIMITS.args + 1 }, (_, i) => [`a${String(i)}`, 1]),
    );
    expectI18nError(() => t("common:welcome_user", many), "too_many_arguments");
    // Rejected before any value is read: a proxy counts reads. (A
    // wall-clock budget failed on a slow CI runner, so the proof is a
    // count, not a time.)
    const huge = Object.fromEntries(
      Array.from({ length: 200_000 }, (_, i) => [`a${String(i)}`, 1]),
    );
    let reads = 0;
    const counted = new Proxy(huge, {
      get(target, key, receiver) {
        reads += 1;
        return Reflect.get(target, key, receiver) as unknown;
      },
    });
    expectI18nError(
      () => t("common:welcome_user", counted),
      "too_many_arguments",
    );
    expect(reads).toBe(0);
  });

  it(`a string argument over ${String(LIMITS.argString)} characters is rejected`, () => {
    expect(
      t("common:welcome_user", { name: "a".repeat(LIMITS.argString) }),
    ).toHaveLength(9 + LIMITS.argString);
    expectI18nError(
      () =>
        t("common:welcome_user", {
          name: SENTINEL + "a".repeat(LIMITS.argString),
        }),
      "argument_too_long",
    );
  });
});

describe("format failures carry a code only", () => {
  it("no Intl.PluralRules (Hermes without a polyfill): plural messages throw format_failed; others still work", () => {
    vi.stubGlobal("Intl", intlWithout("PluralRules"));
    const ar = createTranslator("ar");
    expect(ar.t("common:save")).toBe("حفظ");
    const error = expectI18nError(
      () => ar.t("field:defects_open", { defects: 3 }),
      "format_failed",
    );
    expect(error.message).not.toContain("عيوب");
    expect(error.message).not.toContain("defects");
  });
});
