// BCP 47 normalisation, supported locales and the Latin-digit formatting
// locale (P3-03, ADR 0046 D3).
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/limits.ts";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  formattingLocale,
  isSupportedLocale,
  languageOf,
  normalizeLocale,
} from "../src/locale.ts";
import {
  ARABIC_INDIC_DIGIT,
  SENTINEL,
  expectI18nError,
  timed,
} from "./helpers.ts";

describe("supported locales", () => {
  it("are en, fr and ar, with en the default", () => {
    expect(SUPPORTED_LOCALES).toEqual(["en", "fr", "ar"]);
    expect(DEFAULT_LOCALE).toBe("en");
    expect(Object.isFrozen(SUPPORTED_LOCALES)).toBe(true);
  });

  it.each([
    ["en", true],
    ["fr", true],
    ["ar", true],
    ["EN", false],
    ["en-GB", false],
    ["de", false],
    ["", false],
    [undefined, false],
    [1, false],
  ])("isSupportedLocale(%j) is %j", (value, expected) => {
    expect(isSupportedLocale(value)).toBe(expected);
  });
});

describe("normalizeLocale", () => {
  it.each([
    ["en", "en"],
    ["EN", "en"],
    ["en-gb", "en-GB"],
    ["FR-ca", "fr-CA"],
    ["ar-eg", "ar-EG"],
    ["ar-latn", "ar-Latn"],
    ["zh-hant-tw", "zh-Hant-TW"],
    ["iw", "he"],
    ["ara", "ar"],
    ["fre", "fr"],
    ["en-u-nu-latn", "en-u-nu-latn"],
    ["es-419", "es-419"],
  ])("%s -> %s", (input, expected) => {
    expect(normalizeLocale(input)).toBe(expected);
  });

  it.each([
    ["en_US"],
    ["e"],
    ["123"],
    ["en--US"],
    ["-en"],
    ["en-"],
    ["abcdefghi"],
    ["en-US-u"],
    ["ar-ÉG"],
    [" en"],
  ])("rejects the malformed tag %j with invalid_locale", (tag) => {
    expectI18nError(() => normalizeLocale(tag), "invalid_locale");
  });

  it("rejects an empty tag and a non-string", () => {
    expectI18nError(() => normalizeLocale(""), "invalid_locale");
    expectI18nError(() => normalizeLocale(undefined), "invalid_locale");
    expectI18nError(() => normalizeLocale(42), "invalid_locale");
    expectI18nError(() => normalizeLocale(["en"]), "invalid_locale");
  });

  it(`accepts exactly ${String(LIMITS.localeTag)} characters and rejects one more`, () => {
    const longest = "en-Latn-GB-x-abcdefgh-abcdefgh-abcd";
    expect(longest.length).toBe(LIMITS.localeTag);
    expect(normalizeLocale(longest)).toBe(longest);
    expectI18nError(() => normalizeLocale(longest + "a"), "locale_too_long");
  });

  it("rejects a 1 MB tag quickly, before any parsing", () => {
    const huge = "en-" + "a".repeat(1_000_000);
    expect(
      timed(() =>
        expectI18nError(() => normalizeLocale(huge), "locale_too_long"),
      ),
    ).toBeLessThan(50);
  });

  it("never echoes the tag in its error message", () => {
    expectI18nError(() => normalizeLocale(`${SENTINEL}_x`), "invalid_locale");
    expectI18nError(
      () => normalizeLocale(SENTINEL.repeat(10)),
      "locale_too_long",
    );
  });
});

describe("languageOf", () => {
  it.each([
    ["AR-eg", "ar"],
    ["fr-CA", "fr"],
    ["iw-IL", "he"],
    ["zh-Hant-TW", "zh"],
  ])("%s -> %s", (input, expected) => {
    expect(languageOf(input)).toBe(expected);
  });

  it("throws on a malformed tag", () => {
    expectI18nError(() => languageOf("en_US"), "invalid_locale");
  });
});

describe("formattingLocale (Latin digits everywhere, D3)", () => {
  it.each([
    ["en", "en-u-nu-latn"],
    ["fr", "fr-u-nu-latn"],
    ["ar", "ar-u-nu-latn"],
    ["ar-EG", "ar-EG-u-nu-latn"],
    ["ar-sa", "ar-SA-u-nu-latn"],
    ["fr-CA-u-nu-arab", "fr-CA-u-nu-latn"],
    ["en-Latn-US-x-private", "en-Latn-US-u-nu-latn"],
    ["ar-EG-u-ca-islamic-nu-arab", "ar-EG-u-nu-latn"],
    ["sl-rozaj", "sl-u-nu-latn"],
    ["es-419", "es-419-u-nu-latn"],
  ])("%s -> %s", (input, expected) => {
    expect(formattingLocale(input)).toBe(expected);
  });

  it.each(["en", "fr", "ar", "ar-EG", "ar-SA", "fa-IR", "hi-IN", "bn-BD"])(
    "Intl.NumberFormat(formattingLocale(%s)) uses Latin digits",
    (tag) => {
      const nf = new Intl.NumberFormat(formattingLocale(tag));
      expect(nf.resolvedOptions().numberingSystem).toBe("latn");
      const text = nf.format(1234567.89);
      expect(text).not.toMatch(ARABIC_INDIC_DIGIT);
      // Grouping differs by locale (hi-IN: 12,34,567.89); the digits do not.
      expect(text.replace(/\D/gu, "")).toBe("123456789");
    },
  );

  it("documents why: without it, Node 24 (CLDR 48) gives ar-EG Arabic-Indic digits", () => {
    expect(
      new Intl.NumberFormat("ar-EG").resolvedOptions().numberingSystem,
    ).toBe("arab");
    expect(new Intl.NumberFormat("ar-EG").format(12)).toMatch(
      ARABIC_INDIC_DIGIT,
    );
  });

  it("throws on a malformed or oversized tag", () => {
    expectI18nError(() => formattingLocale("en_US"), "invalid_locale");
    expectI18nError(() => formattingLocale("a".repeat(36)), "locale_too_long");
  });
});
