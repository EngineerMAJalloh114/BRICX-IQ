/**
 * All user-facing text lives in locales/<lang>.json. The files use
 * i18next-style nested keys and {{placeholders}} so any UI layer can load
 * them directly; t() below is a dependency-free fallback for the API and tests.
 */
import en from "../locales/en.json";
import fr from "../locales/fr.json";

export type Messages = { [key: string]: string | Messages };

export const DEFAULT_LOCALE = "en";

export const LOCALES: Readonly<Record<string, Messages>> = { en, fr };

/** Right-to-left languages, for layout direction. */
const RTL = new Set(["ar", "fa", "he", "ur"]);

export function isRtl(locale: string): boolean {
  return RTL.has(locale.split("-")[0].toLowerCase());
}

function lookup(messages: Messages | undefined, key: string): string | undefined {
  let node: string | Messages | undefined = messages;
  for (const part of key.split(".")) {
    if (node === undefined || typeof node === "string") return undefined;
    node = node[part];
  }
  return typeof node === "string" ? node : undefined;
}

/** Resolve "fr-CA" -> "fr" -> "en". */
export function resolveLocale(locale: string): string {
  if (LOCALES[locale]) return locale;
  const lang = locale.split("-")[0].toLowerCase();
  return LOCALES[lang] ? lang : DEFAULT_LOCALE;
}

export function t(
  locale: string,
  key: string,
  params: Record<string, string | number> = {},
): string {
  const text =
    lookup(LOCALES[resolveLocale(locale)], key) ?? lookup(LOCALES[DEFAULT_LOCALE], key);
  if (text === undefined) throw new Error(`Missing translation key: ${key}`);
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, name: string) =>
    name in params ? String(params[name]) : match,
  );
}

/** Every leaf key in a messages tree, dotted. */
export function flattenKeys(messages: Messages, prefix = ""): string[] {
  return Object.entries(messages).flatMap(([k, v]) =>
    typeof v === "string" ? [prefix + k] : flattenKeys(v, `${prefix}${k}.`),
  );
}
