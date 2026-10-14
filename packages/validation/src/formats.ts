// The format of every bounded string: its length cap and the check that
// runs only within the cap. Internal (not in the exports map); bounds.test.ts
// spies on each `check` to prove an over-long input never reaches it.
import { normalizeLocale } from "@bricx/i18n/locale";
import { isCurrencyCode } from "@bricx/money/currency";
import { z } from "zod";
import countries from "../data/countries.json";
import timeZones from "../data/time-zones.json";
import type { Format } from "./bounded.ts";
import { LIMITS } from "./limits.ts";

// zod's default email pattern (ASCII only; no quoted local parts, no IP
// literals, a top-level domain of at least two letters).
const EMAIL = z.regexes.email;
// "+", a first digit 1-9, then 6 to 14 more digits (ruling 1).
const E164 = /^\+[1-9][0-9]{6,14}$/;
const CURSOR = /^[A-Za-z0-9_-]+$/;
const PAGE_LIMIT = /^[1-9][0-9]{0,2}$/;
const TRACE_ID = /^[0-9a-f]{32}$/;

export const COUNTRY_SET: ReadonlySet<string> = new Set(countries.codes);

/** Every zone and link name, mapped to its canonical zone. */
export const ZONE_OF: ReadonlyMap<string, string> = new Map<string, string>([
  ...timeZones.zones.map((z): [string, string] => [z, z]),
  ...Object.entries(timeZones.links),
]);

/**
 * Whether @bricx/i18n's normalizeLocale accepts `value`. Every I18nError it
 * throws (invalid_locale, locale_too_long, intl_unavailable) is caught here
 * and the schema reports validation:invalid_language_tag; the error and its
 * message never leave this function (ruling 4).
 */
export function isLanguageTag(value: string): boolean {
  try {
    normalizeLocale(value);
    return true;
  } catch {
    return false;
  }
}

export const FORMATS = {
  email: {
    max: LIMITS.email,
    check(value: string): boolean {
      const at = value.lastIndexOf("@");
      return at > 0 && at <= LIMITS.emailLocal && EMAIL.test(value);
    },
  },
  phone: {
    max: LIMITS.phone,
    check: (value: string): boolean => E164.test(value),
  },
  country: {
    max: LIMITS.country,
    check: (value: string): boolean => COUNTRY_SET.has(value),
  },
  currency: {
    max: LIMITS.currency,
    check: (value: string): boolean => isCurrencyCode(value),
  },
  timeZone: {
    max: LIMITS.timeZone,
    check: (value: string): boolean => ZONE_OF.has(value),
  },
  languageTag: {
    max: LIMITS.languageTag,
    check: (value: string): boolean => isLanguageTag(value),
  },
  cursor: {
    max: LIMITS.cursor,
    check: (value: string): boolean => CURSOR.test(value),
  },
  pageLimit: {
    max: LIMITS.pageLimit,
    check: (value: string): boolean => PAGE_LIMIT.test(value),
  },
  traceId: {
    max: LIMITS.traceId,
    check: (value: string): boolean =>
      TRACE_ID.test(value) && value !== "0".repeat(32),
  },
} satisfies Record<string, Format>;
