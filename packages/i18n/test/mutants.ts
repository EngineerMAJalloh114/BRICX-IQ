// Deliberately broken variants for the sabotage tests (P3 rule 1). Each is
// the real behaviour with one defect; sabotage.test.ts runs the real checks
// against every one and requires them to fail.
import { checkTree } from "../scripts/i18n-check-lib.mjs";
import { messageSignature } from "../src/icu.ts";
import { normalizeLocale, resolveLocale } from "../src/locale.ts";
import { isRTL } from "../src/rtl.ts";
import { RTL_LANGUAGES } from "../src/generated/rtl-data.ts";

const SUPPORTED = ["en", "fr", "ar"];

/** Compares the language subtag without lower-casing it. */
export const resolveCaseSensitive = (chain: readonly unknown[]): string => {
  for (const entry of chain) {
    if (typeof entry !== "string" || entry.length > 35) continue;
    try {
      normalizeLocale(entry);
    } catch {
      continue;
    }
    const language = entry.split("-")[0] ?? "";
    if (SUPPORTED.includes(language)) return language;
  }
  return "en";
};

/** Takes the language from any string, malformed or not. */
export const resolveNoValidation = (chain: readonly unknown[]): string => {
  for (const entry of chain) {
    if (typeof entry !== "string") continue;
    const language = entry.split(/[-_]/u)[0]?.toLowerCase() ?? "";
    if (SUPPORTED.includes(language)) return language;
  }
  return "en";
};

/** Returns the last supported entry instead of the first. */
export const resolveLastMatch = (chain: readonly unknown[]): string =>
  resolveLocale([...chain].reverse());

/** Decides by the language alone, ignoring an explicit script and the region overrides. */
export const isRTLLanguageOnly = (tag: unknown): boolean => {
  const language = normalizeLocale(tag).split("-")[0] ?? "";
  return RTL_LANGUAGES.has(language);
};

/** Always LTR unless the tag is exactly "ar". */
export const isRTLOnlyAr = (tag: unknown): boolean => {
  isRTL(tag);
  return tag === "ar";
};

type Signature = typeof messageSignature;

/** Drops the arms of every select and plural. */
export const signatureWithoutArms: Signature = (message, locale) => {
  const result = messageSignature(message, locale);
  return result.ok
    ? { ok: true, signature: { args: result.signature.args, arms: {} } }
    : result;
};

/** Reports a select argument as a plain string argument. */
export const signatureSelectAsString: Signature = (message, locale) => {
  const result = messageSignature(message, locale);
  if (!result.ok) return result;
  const args = Object.fromEntries(
    Object.entries(result.signature.args).map(([name, kind]) => [
      name,
      kind === "select" ? "string" : kind,
    ]),
  );
  return { ok: true, signature: { args, arms: result.signature.arms } };
};

/** Forgets the Latin numbering system. */
export const formattingWithoutLatn = (tag: unknown): string =>
  normalizeLocale(tag);

/** A checker that no longer detects `code`. */
export const checkTreeIgnoring =
  (code: string) =>
  async (root: string): Promise<{ lines: readonly string[] }> => {
    const result = await checkTree(root);
    return {
      lines: result.lines.filter((line) => !line.includes(`: ${code}`)),
    };
  };
