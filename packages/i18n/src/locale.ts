// Supported locales, namespaces and BCP 47 handling (P3-03, ADR 0046).
// Relies on Intl.getCanonicalLocales only, which Hermes documents as
// supported; P7 confirms it on device.
import { I18nError } from "./errors.ts";
import { LIMITS } from "./limits.ts";

/** Launch languages (ADR 0046; docs/adr/pending.md "Launch languages"). */
export const SUPPORTED_LOCALES = Object.freeze(["en", "fr", "ar"] as const);
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** The last link of every fallback chain. */
export const DEFAULT_LOCALE: SupportedLocale = "en";

/** Message namespaces: one JSON file per locale and namespace. */
export const NAMESPACES = Object.freeze([
  "common",
  "construction",
  "finance",
  "field",
  "errors",
  "validation",
] as const);
export type Namespace = (typeof NAMESPACES)[number];

export function isSupportedLocale(value: unknown): value is SupportedLocale {
  return (
    typeof value === "string" &&
    (SUPPORTED_LOCALES as readonly string[]).includes(value)
  );
}

/**
 * The canonical form of a BCP 47 tag (`en-gb` -> `en-GB`, `iw` -> `he`,
 * `ara` -> `ar`). Throws `invalid_locale` for a non-string, an empty or a
 * malformed tag, `locale_too_long` above LIMITS.localeTag (checked before
 * parsing), and `intl_unavailable` without Intl.getCanonicalLocales.
 */
export function normalizeLocale(tag: unknown): string {
  if (typeof tag !== "string" || tag === "") {
    throw new I18nError("invalid_locale");
  }
  if (tag.length > LIMITS.localeTag) throw new I18nError("locale_too_long");
  const intl: unknown = globalThis.Intl;
  const canonicalize: unknown =
    typeof intl === "object" && intl !== null
      ? Reflect.get(intl, "getCanonicalLocales")
      : undefined;
  if (typeof canonicalize !== "function") {
    throw new I18nError("intl_unavailable");
  }
  let canonical: unknown;
  try {
    const result: unknown = Reflect.apply(canonicalize, intl, [tag]);
    canonical = Array.isArray(result) ? result[0] : undefined;
  } catch {
    throw new I18nError("invalid_locale");
  }
  if (typeof canonical !== "string") throw new I18nError("invalid_locale");
  return canonical;
}

/** The lower-case language subtag of a tag, after canonicalisation. */
export function languageOf(tag: unknown): string {
  return normalizeLocale(tag).split("-")[0] ?? "";
}

/**
 * Fallback chain (D9): the first entry whose language is supported, else
 * "en". Callers pass `[project, user, device]`; unset entries may be null
 * or undefined. Malformed, oversized and non-string entries are skipped,
 * so a bad stored preference never blocks the UI. Throws `invalid_chain`
 * for a non-array and `chain_too_long` above LIMITS.chain, before looking
 * at any entry.
 */
export function resolveLocale(chain: readonly unknown[]): SupportedLocale {
  if (!Array.isArray(chain)) throw new I18nError("invalid_chain");
  if (chain.length > LIMITS.chain) throw new I18nError("chain_too_long");
  for (const entry of chain) {
    if (typeof entry !== "string" || entry.length > LIMITS.localeTag) continue;
    let language: string;
    try {
      language = languageOf(entry);
    } catch (error) {
      if (error instanceof I18nError && error.code === "intl_unavailable") {
        throw error;
      }
      continue;
    }
    if (isSupportedLocale(language)) return language;
  }
  return DEFAULT_LOCALE;
}

const SCRIPT = /^[A-Z][a-z]{3}$/u;
const REGION = /^(?:[A-Z]{2}|\d{3})$/u;

/**
 * The locale to hand to Intl formatters (D3): `language[-Script][-REGION]`
 * from the canonical tag, plus `-u-nu-latn`, so every locale, Arabic
 * included, formats with Latin digits on every engine. Variants and other
 * extensions are dropped. A per-user digit preference is a later setting.
 * Callers pass the same string to @bricx/money's formatMoney.
 */
export function formattingLocale(tag: unknown): string {
  const parts = normalizeLocale(tag).split("-");
  const kept = [parts[0] ?? ""];
  let i = 1;
  const script = parts[i];
  if (script !== undefined && SCRIPT.test(script)) {
    kept.push(script);
    i += 1;
  }
  const region = parts[i];
  if (region !== undefined && REGION.test(region)) kept.push(region);
  return `${kept.join("-")}-u-nu-latn`;
}
