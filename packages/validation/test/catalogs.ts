// Reads @bricx/i18n's catalogs from disk through the workspace link, for the
// drift tests. Tests only: src/ never reads files.
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export const LOCALES = ["en", "fr", "ar"] as const;
export type Locale = (typeof LOCALES)[number];
export type Catalogs = Readonly<
  Record<Locale, Readonly<Record<string, Readonly<Record<string, string>>>>>
>;

export const i18nDir = realpathSync(
  path.join(import.meta.dirname, "../node_modules/@bricx/i18n"),
);

function readNamespace(locale: Locale, ns: string): Record<string, string> {
  const file = path.join(i18nDir, "locales", locale, `${ns}.json`);
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  const out: Record<string, string> = {};
  if (typeof parsed === "object" && parsed !== null) {
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
  }
  return out;
}

export function loadCatalogs(): Catalogs {
  const load = (locale: Locale) => ({
    errors: readNamespace(locale, "errors"),
    validation: readNamespace(locale, "validation"),
  });
  return { en: load("en"), fr: load("fr"), ar: load("ar") };
}

/**
 * Drift problems for `keys` ("namespace:key"): a key missing in a locale, or
 * fr/ar text identical to en (a copy is not a translation). Presence only:
 * this never marks or reads a review status, and never skips fr or ar.
 */
export function keyProblems(
  keys: readonly string[],
  catalogs: Catalogs,
): string[] {
  const problems: string[] = [];
  for (const key of keys) {
    const [ns = "", name = ""] = key.split(":");
    for (const locale of LOCALES) {
      const text = catalogs[locale][ns]?.[name];
      if (text === undefined) {
        problems.push(`${locale}: ${key} missing`);
      } else if (locale !== "en" && text === catalogs.en[ns]?.[name]) {
        problems.push(`${locale}: ${key} is a copy of en`);
      }
    }
  }
  return problems;
}
