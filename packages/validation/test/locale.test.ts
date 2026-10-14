// LanguageTagSchema and SupportedLocaleSchema (P3-04 D4, ruling 4): reuse
// @bricx/i18n's normalizeLocale; any error it throws is caught and mapped to
// an issue code; no i18n error text reaches the issue or the envelope.
import { describe, expect, it } from "vitest";
import { LanguageTagSchema, SupportedLocaleSchema } from "../src/locale.ts";
import { expectRejectedWithoutEcho, messageOf, parsed } from "./helpers.ts";

const BAD_TAG = "validation:invalid_language_tag";
const UNSUPPORTED = "validation:invalid_locale";

describe("LanguageTagSchema", () => {
  it.each([
    ["en", "en"],
    ["EN-gb", "en-GB"],
    ["fr-FR", "fr-FR"],
    ["ar-EG", "ar-EG"],
    ["zh-hant-tw", "zh-Hant-TW"],
    ["iw", "he"],
    ["sr-Latn-RS", "sr-Latn-RS"],
  ])("accepts %s as %s", (input, output) => {
    expect(parsed(LanguageTagSchema, input)).toBe(output);
  });

  it.each([
    ["empty", ""],
    ["underscore", "en_GB"],
    ["space", "en GB"],
    ["leading space", " en"],
    ["digits", "12"],
    ["too long subtag", "abcdefghi"],
    [
      "36 characters",
      `en-${"a".repeat(8)}-${"b".repeat(8)}-${"c".repeat(8)}-dddddd`,
    ],
  ])("rejects %s", (_label, input) => {
    expect(expectRejectedWithoutEcho(LanguageTagSchema, input)).toEqual([
      BAD_TAG,
    ]);
  });

  it("rejects a non-string", () => {
    expect(messageOf(LanguageTagSchema, 42)).toBe(BAD_TAG);
  });

  it("no i18n error text reaches the issue", () => {
    const result = LanguageTagSchema.safeParse("en_GB");
    expect(result.success).toBe(false);
    const json = JSON.stringify(result.error);
    expect(json).not.toMatch(/BCP 47|well-formed|I18nError|invalid_locale:/);
  });
});

describe("SupportedLocaleSchema", () => {
  it.each([
    ["en", "en"],
    ["EN", "en"],
    ["fr", "fr"],
    ["ar", "ar"],
  ])("accepts %s as %s", (input, output) => {
    expect(parsed(SupportedLocaleSchema, input)).toBe(output);
  });

  it.each([
    ["a supported language with a region", "en-GB"],
    ["unsupported", "de"],
    ["unsupported", "es-419"],
  ])("rejects %s (%s) as unsupported", (_label, input) => {
    expect(expectRejectedWithoutEcho(SupportedLocaleSchema, input)).toEqual([
      UNSUPPORTED,
    ]);
  });

  it("rejects a malformed tag as malformed, not unsupported", () => {
    expect(expectRejectedWithoutEcho(SupportedLocaleSchema, "en_GB")).toEqual([
      BAD_TAG,
    ]);
  });
});
