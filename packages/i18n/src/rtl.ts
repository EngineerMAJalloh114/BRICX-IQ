// isRTL (P3-03, ADR 0046 D10). Where the engine has Intl.Locale, the answer
// is the maximized locale's text info (getTextInfo(), or the older textInfo
// getter), else its script in RTL_SCRIPTS. Hermes has no Intl.Locale, so
// there the answer comes from the CLDR tables in generated/rtl-data.ts:
// an explicit script subtag decides first, then a language-REGION
// override, then the language's likely script. rtl.test.ts proves both
// paths agree with Node's CLDR.
import {
  RTL_LANGUAGES,
  RTL_REGION_OVERRIDES,
  RTL_SCRIPTS,
} from "./generated/rtl-data.ts";
import { normalizeLocale } from "./locale.ts";

const SCRIPT = /^[A-Z][a-z]{3}$/u;
const REGION = /^(?:[A-Z]{2}|\d{3})$/u;

/** "rtl", "ltr", or undefined when the locale exposes no text info. */
function textDirection(locale: object): unknown {
  const getTextInfo: unknown = Reflect.get(locale, "getTextInfo");
  const info: unknown =
    typeof getTextInfo === "function"
      ? Reflect.apply(getTextInfo, locale, [])
      : Reflect.get(locale, "textInfo");
  return typeof info === "object" && info !== null
    ? Reflect.get(info, "direction")
    : undefined;
}

/** The fallback for engines without Intl.Locale; `canonical` is canonical. */
function tableIsRTL(canonical: string): boolean {
  const parts = canonical.split("-");
  const language = parts[0] ?? "";
  const second = parts[1];
  if (second !== undefined && SCRIPT.test(second)) {
    return RTL_SCRIPTS.has(second);
  }
  if (second !== undefined && REGION.test(second)) {
    const override = RTL_REGION_OVERRIDES.get(`${language}-${second}`);
    if (override !== undefined) return override;
  }
  return RTL_LANGUAGES.has(language);
}

/**
 * True when text in `tag`'s locale runs right to left. Throws the
 * normalizeLocale codes: `invalid_locale` (malformed or not a string),
 * `locale_too_long` (checked before parsing), `intl_unavailable`.
 */
export function isRTL(tag: unknown): boolean {
  const canonical = normalizeLocale(tag);
  if (typeof Reflect.get(Intl, "Locale") !== "function") {
    return tableIsRTL(canonical);
  }
  const max = new Intl.Locale(canonical).maximize();
  const direction = textDirection(max);
  if (direction === "rtl" || direction === "ltr") return direction === "rtl";
  return max.script !== undefined && RTL_SCRIPTS.has(max.script);
}
