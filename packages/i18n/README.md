# @bricx/i18n

Translations for BRICX IQ (P3-03, ADR 0046): ICU MessageFormat catalogs for `en`, `fr` and `ar` in six namespaces, a construction glossary, typed keys generated from `en`, BCP 47 locale resolution, `isRTL`, and the `i18n:check` catalog checker. Runs on the API, the worker and devices: the source imports only its own files, its catalogs, `i18next`, `i18next-icu` and `intl-messageformat`.

> **fr and ar text is machine-drafted.** Every French and Arabic message and glossary entry is a draft (`"review": "machine-drafted"` in `glossary.json`). A native speaker must review it before production and before the catalogs go into Tolgee (for architect review). Do not present it as final.

```ts
import { createTranslator } from "@bricx/i18n/translate";
import { resolveLocale, formattingLocale } from "@bricx/i18n/locale";
import { isRTL } from "@bricx/i18n/rtl";

const locale = resolveLocale([project.locale, user.locale, device.locale]); // "en" | "fr" | "ar"
const { t, direction } = createTranslator(locale); // direction: "ltr" | "rtl"
t("common:save"); // "Save"
t("common:welcome_user", { name: "Aminata" }); // arguments are typed from en
t("field:defects_open", { defects: 3 }); // plural: ar uses all six categories
isRTL("ar-EG"); // true
formattingLocale("ar-EG"); // "ar-EG-u-nu-latn"
```

## Layout

- `locales/<locale>/<namespace>.json`: the source of truth. Flat objects, `key → ICU message`. Namespaces: `common`, `construction`, `finance`, `field`, `errors`, `validation`. Keys match `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$` and are addressed as `namespace:key` (no nested JSON, `keySeparator: false`).
- `glossary.json`: construction terms with a definition for translators and the agreed text per locale. Each term names a catalog key (`construction:variation_order`) whose text must equal the glossary text in every locale. fr and ar entries carry a `review` status: `machine-drafted` or `native-reviewed`.
- `src/generated/keys.ts`: generated from the `en` catalogs (`pnpm --filter @bricx/i18n gen:keys`), committed, ignored by ESLint and Prettier. `i18n:check` fails when it is stale.
- `src/generated/rtl-data.ts`: the RTL tables `isRTL` falls back on without `Intl.Locale` (Hermes), generated from Node's CLDR data (`gen:rtl-data`, a few minutes). Tests re-derive them on every run.

## Entry points

`./locale`, `./rtl`, `./translate`, `./keys`, `./limits`, `./errors`, `./i18next-types`. No root barrel, no deep imports. `./limits` also exports `KEY_PATTERN`, the key regex `i18n:check` applies (P3-04).

- `resolveLocale(chain)`: the fallback chain `project → user → device → en`. Returns the first entry whose language subtag (case-insensitive, after BCP 47 canonicalisation, so `ara` and `arb` become `ar`) is `en`, `fr` or `ar`; malformed or unsupported entries are skipped; `en` when nothing matches. At most 8 entries, each at most 35 characters.
- `normalizeLocale(tag)`: canonical BCP 47 via `Intl.getCanonicalLocales`; `invalid_locale` or `locale_too_long` otherwise.
- `isRTL(tag)`: see "Right to left".
- `createTranslator(locale)`: a frozen `{ locale, direction, t }`. `t` throws a coded `I18nError` for an unknown key, a missing, extra or wrongly typed argument, or a message that fails to format; it never returns the raw template.
- `i18next-types`: augments i18next's `CustomTypeOptions` with the `en` resources, so `i18next.t` is typed too.

## Messages

- ICU MessageFormat only. i18next's `{{name}}` interpolation and `$t(...)` nesting are rejected by `i18n:check`.
- Argument kinds: simple `{name}` (string or number), `{n, number}`, `{n, plural, …}`, `{n, selectordinal, …}`, `{s, select, …}`. **No `date` or `time` arguments**: dates are formatted by the caller in the user's or project's time zone and passed as strings. No rich-text tags.
- Plural arms must be categories of the locale (from `Intl.PluralRules`) or `=N`; `other` is required; `ar` must give all six (`zero`, `one`, `two`, `few`, `many`, `other`), `en` and `fr` `one` and `other` (`fr` `many` is optional and falls back to `other`; `fr` `one` covers 0 and 1).
- `select` arms must be the same set in every locale. Argument names match `^[a-z][A-Za-z0-9]*$` and must not be an i18next option name (`count`, `context`, `lng`, …).
- Limits, checked before parsing: message 1000 characters, 64 braces, 4 nested arguments, 20 placeholders, key 128 characters; at run time 20 arguments per call, string arguments 1000 characters.
- **Money is formatted by `@bricx/money`**, never here: pass the formatted string as a simple argument.

## Digits: `formattingLocale(locale)`

Every number this package formats uses **Latin digits** (0–9) for every locale: messages are formatted with `formattingLocale(locale)`, which keeps the language, script and region and sets the numbering system to `latn` (`ar-EG` → `ar-EG-u-nu-latn`; other Unicode extensions are dropped). Separators and grouping still follow the locale (`1 000` in fr, `12,34,567` in hi-IN). A per-user digit preference (for example Arabic-Indic digits) is a later setting, not part of this package yet. Callers that format numbers themselves should use `formattingLocale` too.

## Right to left (the start/end rule)

- `isRTL(tag)` maximises the tag (likely script) and reads its text direction from `Intl.Locale` (`getTextInfo()`, or the older `textInfo` getter). Without `Intl.Locale` (Hermes) it uses the generated CLDR tables: an explicit script decides first, then a language-region override (`pa-PK`, `ku-IQ`, …), then the language. `ar` is RTL, `en` and `fr` are not; a malformed tag throws `invalid_locale`.
- **UI styles use logical sides only**: `start`/`end` (`marginStart`, `paddingEnd`, `textAlign: "start"`, `start: 0`), never `left`/`right`, so a layout mirrors itself in RTL. Icons that point in a reading direction (back, next, chevrons) are mirrored with `direction`; icons that do not (play, checkmarks, logos) are not. Numbers and Latin-script codes inside RTL text stay left to right.

## Errors

`I18nError` with a `code` (`invalid_locale`, `locale_too_long`, `unsupported_locale`, `invalid_chain`, `chain_too_long`, `intl_unavailable`, `invalid_key`, `key_too_long`, `unknown_key`, `invalid_arguments`, `too_many_arguments`, `missing_argument`, `unexpected_argument`, `invalid_argument`, `argument_too_long`, `format_failed`). Messages are fixed per code and never include the input (locale tags, keys, message text, argument values).

## Commands

- `pnpm i18n:check` (root; part of `pnpm verify`): fails on a missing or extra key, a placeholder mismatch (names, kinds, select or plural arms), an empty message, a message over the length cap, invalid ICU, a stale `src/generated/keys.ts`, an unexpected file, and glossary problems (missing text, missing review status, catalog mismatch). Output names the file, problem and key, never message text.
- `pnpm --filter @bricx/i18n gen:keys`: regenerate `src/generated/keys.ts` after changing an `en` message.
- `pnpm --filter @bricx/i18n gen:rtl-data`: regenerate the RTL tables after a Node (CLDR) upgrade.

## Engines

Relies on `Intl.getCanonicalLocales`, `Intl.PluralRules` (cardinal and ordinal) and `Intl.NumberFormat` with `-u-nu-latn`, and on `Intl.Locale` with `maximize()` and `getTextInfo()`/`textInfo` where present. All verified on Node 24; **Hermes must be confirmed at P7** (its Intl documentation lists no `Intl.Locale` and no `Intl.PluralRules`, so P7 needs a PluralRules polyfill, ADR 0046).
