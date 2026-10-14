// LanguageTagSchema and SupportedLocaleSchema (P3-04 D4, ruling 4). Both
// reuse @bricx/i18n's normalizeLocale (well-formed BCP 47, canonical form,
// 35-character cap, checked here first). An I18nError from it is caught and
// becomes an issue code; no i18n error text reaches the issue or the
// envelope. The output is the canonical tag ("EN-gb" -> "en-GB").
import { SUPPORTED_LOCALES, normalizeLocale } from "@bricx/i18n/locale";
import type { SupportedLocale } from "@bricx/i18n/locale";
import { z } from "zod";
import { boundedString, issueMessage } from "./bounded.ts";
import { FORMATS } from "./formats.ts";

export const LanguageTagSchema = boundedString(
  FORMATS.languageTag,
  issueMessage("invalid_language_tag"),
)
  .overwrite((tag) => normalizeLocale(tag))
  .brand<"LanguageTag">();

export type LanguageTag = z.output<typeof LanguageTagSchema>;

const SUPPORTED: ReadonlySet<string> = new Set(SUPPORTED_LOCALES);

/** en, fr or ar exactly (after canonicalisation); a region is not accepted. */
export const SupportedLocaleSchema = boundedString(
  FORMATS.languageTag,
  issueMessage("invalid_language_tag"),
)
  .overwrite((tag) => normalizeLocale(tag))
  .check((ctx) => {
    if (!SUPPORTED.has(ctx.value)) {
      ctx.issues.push({
        code: "custom",
        message: issueMessage("invalid_locale"),
        input: undefined,
        continue: false,
      });
    }
  })
  .pipe(z.enum(SUPPORTED_LOCALES));

export type { SupportedLocale };
