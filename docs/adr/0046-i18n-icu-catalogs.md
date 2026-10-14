# 0046. `@bricx/i18n`: i18next with ICU catalogs, typed keys and a catalog checker

- Status: Accepted
- Date: 2026-10-14
- Deciders: Mohamed Abass Jalloh
- Source: P3-03 (plan approved 2026-10-14 01:42Z: all recommended options D1–D17, with changes 1–7); the P3-03 rulings and the P3 standing rules (2026-10-14 01:34Z); STACK.md (i18next + ICU, C9); ADR 0023 (dependency policy); ADR 0041 and ADR 0045 (the lint pattern this ADR extends). Resolves the "Launch languages" pending decision for P3-03.

## Context

The ROADMAP P3-03 entry asks for six key namespaces, a `glossary.json` with definitions for translators, typed keys through i18next's `CustomTypeOptions`, ICU enabled, `isRTL(locale)`, BCP 47 normalisation and the fallback chain `project → user → device → en`; done when a missing key fails `pnpm i18n:check`. The rulings add: JSON per locale and namespace as the source of truth; a glossary of at least 30 terms checked in all three locales; a generated key union with type tests for unknown keys and missing ICU arguments; Arabic plurals tested in all six categories and en/fr in two; `isRTL` through `Intl.Locale` with a documented fallback; a table-plus-oracle test of `resolveLocale`; a decision on Arabic digits; an `i18n:check` that fails on missing and extra keys, placeholder mismatches, empty messages and over-long messages, each with a fixture, wired into CI and guarded; a proposal (not an implementation) for a lint rule for CLAUDE.md rule 8; the RTL start/end rule in the README.

Evidence (Node 24.21.0, ICU 78.3, CLDR 48.0; npm registry, 2026-10-14):

- Publish times (registry `time`), all at least 7 days before the install (finished 2026-10-14T01:45Z) with `--config.minimumReleaseAge=10080`: `i18next` 26.4.2 2026-09-03T19:31:13.307Z (26.4.3 of 2026-10-10 and 26.4.4 of 2026-10-12 were under 7 days); `i18next-icu` 2.5.0 2026-10-06T06:14:48.818Z; `intl-messageformat` 12.1.3 2026-10-05T17:21:01.747Z; its dependencies `@formatjs/icu-messageformat-parser` 3.5.21 2026-10-05T17:11:46.147Z, `@formatjs/icu-skeleton-parser` 2.1.12 2026-09-15T11:58:44.034Z, `@formatjs/fast-memoize` 3.1.7 2026-07-11T03:58:32.132Z. No install scripts in any of the six. Licences: i18next MIT, i18next-icu MIT, intl-messageformat BSD-3-Clause, @formatjs/* MIT. i18next has no dependencies (an optional `typescript` peer); i18next-icu's only peer is `intl-messageformat >=10.3.3 <13`.
- Integrity (pnpm-lock.yaml): i18next `sha512-RX+R0VLg13IbvRuJSxnqykUFS9vQZTl8wYpWPCIUDWVrSGjsQywB5Y+pjzrkboxGAuYfJZVH1InFTdgBdxq6ug==`; i18next-icu `sha512-/du0wHUfcJhP3gzHw4ZHp9n0XA6xpDD029ZVNy9e2ohWEZHJUnW8X/ZAC0ltE72hceRa+XcAz72NU2UVF+Guuw==`; intl-messageformat `sha512-JXi5wk8R/oSECKyxSIZ00VS8KG6MZkHM0qU4NS7RrvIWWXkiv3wVqGlCvEvyXiDvKlt2yqwZMiZGIv+I8rrnZQ==`; @formatjs/icu-messageformat-parser `sha512-Vnl7IOSyMRaP4Pjv48etkT2nlcIwzh4QWIa3hewzGlZZPBbft+TbMir4MijpDViOLN/1hvkGC10oYMuilsG+fw==`; @formatjs/icu-skeleton-parser `sha512-ca7tZMLpfHX3sUD7hP6gE/qr6Iq89EDd3ZLeRhbsB7r0UD55DGJq+tmFLzrGrnx5StahUevQmQQVtbDRHsfDHA==`; @formatjs/fast-memoize `sha512-zXfhLpvA6T7+efdt9JLbBwZ00tT7NsBMDVnDu8rpHeNNv8KfRZAMo2gkG0k9lK/Nzc//3kJ9pImsfuJxk3KhUA==`.
- Size (esbuild, `--bundle --minify --platform=neutral`; figures in the PR body): i18next 43,438 B minified / 13,881 B gzipped; i18next-icu with intl-messageformat 38,671 / 11,723; intl-messageformat alone 33,480 / 9,767; all three 82,218 / 25,468.
- CLDR 48 French cardinal categories are `one`, `many`, `other` (the ruling said two; `many` covers 1,000,000 and up and falls back to `other` here). Plain `ar` formats with Latin digits on Node; `ar-EG` and `ar-SA` default to Arabic-Indic digits.
- i18next-icu by default returns the raw template when formatting fails (for example a missing argument), and intl-messageformat's errors embed the message text. Both are contained (D6).
- Hermes' Intl documentation lists no `Intl.Locale`, no `Intl.PluralRules` and no `Intl.ListFormat`. intl-messageformat tolerates a missing `Intl.Locale` but throws without `Intl.PluralRules`.

## Decision

### Libraries (D1, D2)

`i18next` 26.4.2, `i18next-icu` 2.5.0 and `intl-messageformat` 12.1.3, exact, runtime dependencies of `packages/i18n` only; `fast-check` 4.10.2 as a dev dependency (already allowed, ADR 0045). i18next is used through `createInstance()` with `initAsync: false`, so the module has no global instance and no I/O. The ICU plugin formats with `formattingLocale(locale)` (`parseLngForICU`) and its `parseErrorHandler` throws a coded error instead of returning the template.

### Catalogs (D7) and namespaces

`locales/<locale>/<namespace>.json`, flat objects (`keySeparator: false`, keys `^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$`, addressed `namespace:key`), namespaces `common`, `construction`, `finance`, `field`, `errors`, `validation`, locales `en`, `fr`, `ar`. `en` is the source of truth. The catalogs are bundled as JSON imports (`src/catalog.ts`); nothing is fetched. 80 keys per locale at this commit.

### Message rules (D4, D5)

- ICU only; i18next's `{{name}}` interpolation and `$t()` nesting are rejected (`i18next_syntax`).
- **No `date` or `time` arguments (D4)**: the caller formats dates in the user's or project's time zone (CLAUDE.md rule 7) and passes a string. No rich-text tags.
- Plural arms: each arm is a category of the locale (from `Intl.PluralRules`, cardinal or ordinal) or `=N`; `other` is required; `ar` must give all six categories, `en` and `fr` `one` and `other` (`fr` `many` optional). Ordinals need only `other`.
- `select` arms must be identical in every locale; argument names and kinds (string, number, select; plural and selectordinal count as number) must match `en`.
- Argument names match `^[a-z][A-Za-z0-9]*$` and must not be an option i18next reads from `t()`'s options (`count`, `context`, `ordinal`, `lng`, `lngs`, `ns`, `defaultValue`, `replace`, `returnObjects`, `returnDetails`, `joinArrays`, `postProcess`, `interpolation`, `skipInterpolation`, `keyPrefix`, `fallbackLng`, `nsSeparator`, `keySeparator`), because those would change how i18next resolves the key.

### Bounds (D8, P3 rule 9)

Checked before any parsing (`src/limits.ts`, `LIMITS`): locale tag 35 characters, chain 8 entries, key 128 characters, message 1000 characters, 64 braces per message, 4 nested arguments, 20 placeholders per message; at run time 20 arguments per call and 1000 characters per string argument; catalog files 256 KiB before `JSON.parse`. Oversized inputs are rejected in linear time (tests time a 1,000,000-character tag, message and key under 50 ms).

- **Deviation for architect review:** the approved plan said "brace depth ≤ 4". The limit is implemented as **4 nested arguments**, which is a brace depth of 8 (each nested `select` or `plural` arm adds two levels: the argument's brace and the arm's brace), so `{a, select, x {{b, select, …}}}` counts as two arguments, not four braces. With a brace-depth limit of 4, a message with two nested selects would already fail. Tests: 4 nested selects pass, 5 fail with `nesting_too_deep`.

### Typed keys (D6, change 4)

`src/generated/keys.ts` is generated from the `en` catalogs by `src/keys-gen.ts` (`pnpm --filter @bricx/i18n gen:keys`), **committed**, and ignored by ESLint and Prettier; `i18n:check` fails when it is stale (fixture `stale-generated`). It exports `MESSAGE_ARGS` (each key with its argument kinds) and the `MessageKey` union. `createTranslator(locale).t(key, ...args)` takes no second argument for a message without placeholders and exactly its arguments otherwise (number for number/plural/selectordinal, string for select, string or number for simple). `src/i18next-types.ts` augments i18next's `CustomTypeOptions` with the `en` resources, so `i18next.t` is typed too. Type tests (`test/types.test-d.ts`) prove an unknown key, a missing namespace, a missing argument object, a missing argument, a wrong kind and an extra argument are compile errors; `test/types-sabotage.test.ts` loosens the types five ways and requires each matching `@ts-expect-error` to become unused (TS2578). `t` also validates at run time and throws coded errors (unknown key, argument problems, `format_failed`).

### Locales (D9) and digits (D3, change 3)

- `normalizeLocale` canonicalises with `Intl.getCanonicalLocales` (aliases such as `iw` → `he`, `ara` → `ar`).
- `resolveLocale(chain)` returns the first entry whose canonical language subtag is supported (case-insensitive), skipping malformed, over-long and non-string entries; `en` when nothing matches. Tested with a 22-row table and a fast-check oracle (a plain reference implementation in the test).
- **Digits: Latin for every locale.** Contract of `formattingLocale(locale)`: it returns `language[-Script][-REGION]-u-nu-latn` from the canonical tag (variants and other extensions dropped), and every number this package formats goes through it, so `ar`, `ar-EG`, `ar-SA`, `fa-IR`, `hi-IN` and `bn-BD` all format with 0–9 while separators and grouping follow the locale. A per-user digit preference (Arabic-Indic or other native digits) is a later setting. Callers that format numbers themselves, `@bricx/money`'s `formatMoney` included, pass `formattingLocale(locale)`.
- **Money is formatted by `@bricx/money`, never here**: messages take the formatted string as a simple argument.

### Right to left (D10)

`isRTL(tag)` canonicalises the tag (malformed → `invalid_locale`), maximises it and reads `getTextInfo().direction` (or the older `textInfo` getter) from `Intl.Locale`, else checks the likely script against the RTL script table. **Fallback without `Intl.Locale` (Hermes):** `src/generated/rtl-data.ts`, generated from Node's CLDR data by `scripts/gen-rtl-data.mjs`: 37 RTL scripts, 256 languages whose likely script is RTL, and 20 language-region pairs whose likely script flips the language's direction (`az-IQ`, `az-IR`, `ha-CM`, `ha-SD`, `kk-AF`, `kk-CN`, `kk-IR`, `kk-MN`, `ku-IQ`, `ku-IR`, `ku-LB`, `ky-CN`, `ms-CC`, `pa-PK`, `tg-PK`, `uz-AF` RTL; `mey-SN`, `sd-IN`, `ug-KZ`, `ug-MN` LTR). An explicit script decides first, then the region override, then the language. Tests re-derive the script and language tables from Node on every run and check the fallback against Node on every table entry and override. The README states the start/end rule for styles.

### Glossary (D13, change 2)

`glossary.json` holds 35 terms (20 construction, 10 finance, 5 field), each with a definition for translators and the text per locale; each term names a catalog key whose text must equal the glossary text in all three locales. **Every fr and ar entry carries `"review": "machine-drafted"`** (the allowed statuses are `machine-drafted` and `native-reviewed`); `i18n:check` and a unit test fail when a term has no valid review status. **All fr and ar text in this package is machine-drafted and needs a native-speaker review before production or before it is imported into Tolgee (for architect review).** It is not final.

### `i18n:check` (D12, change 5)

`packages/i18n/scripts/i18n-check.mjs` (loader `i18n-check-lib.mjs`, logic in `src/check.ts`) fails, one line per problem naming file, code and key and never message text, on: a missing or extra key, a placeholder mismatch (names, kinds), different select arms, invalid plural arms, an empty message, a message over 1000 characters, a key over 128 characters or malformed, too many placeholders, nesting too deep, invalid ICU, a date/time argument, a tag, a reserved or malformed argument name, i18next syntax, a non-string message, a non-object catalog, invalid JSON, a file over 256 KiB, an unexpected file or locale directory, a missing file, a stale `src/generated/keys.ts`, and glossary problems (invalid, missing definition, unknown key, missing text, missing review status, mismatch with the catalog). Each has a fixture in `test/fixtures/check/` (37 cases). Exit codes: 0 clean, 1 problems, 2 usage.

Wiring: root `"i18n:check": "turbo run i18n:check"`; the root `verify` turbo run lists the `i18n:check` task; the package script `node scripts/i18n-check.mjs`; a cached turbo task; CI is unchanged because its verify job already runs `pnpm verify`. `check:workspace` (`i18nCheckProblems` in `scripts/guards.mjs`) fails if `i18n:check` is missing from the root verify list, the root script, the package script, the turbo tasks, or if CI's verify job stops running `pnpm verify` or gains `continue-on-error`; 14 fixtures, and sabotage of each of the four links on the real files fails it (PR body).

### Dependency direction and client safety (P3 rules 3, 4, 5)

- Boundaries element `i18n` (`packages/i18n/src/**`, anchored): its source may import its own files, its `locales/`, `i18next`, `i18next-icu` and `intl-messageformat`, and nothing else (no other workspace package, `@bricx/ids` and `@bricx/money` included, no Node built-in). `ids`, `money` and `domain` may not import `i18n`. The clock and `Math.random` bans extend to `packages/i18n/src`. Eight smoke fixtures and a real-path probe in `tooling/eslint-smoke`.
- Exports map: `./locale`, `./rtl`, `./translate`, `./keys`, `./limits`, `./errors`, `./i18next-types`; no root barrel. Source files import each other with `.ts` extensions (`allowImportingTsExtensions`, `erasableSyntaxOnly`), so the Node scripts run the same source through Node 24's type stripping without a build step.
- `test/client-safe.test.ts`: src imports only the allowed specifiers, no source mentions `process`, `Buffer`, `__dirname`, `setImmediate`, `performance`, `crypto`, `console`, `Date.now`, `new Date(` or `Math.random`, the three libraries and their `@formatjs` dependencies import no Node built-in, and every module loads with `process` and `crypto` removed, then works with `Intl.Locale` and `Intl.PluralRules` removed (the RTL table fallback; formatting fails with a coded `format_failed` without PluralRules).

### MoneyError keys (D11, change 1)

No `@bricx/money` keys here, and no edge between money and i18n in either direction, test-only included.

### Intl features relied on (change 7)

| Feature | Used for | Node 24 verified | Hermes: must confirm at P7 |
|---|---|---|---|
| `Intl.getCanonicalLocales` | `normalizeLocale`, `resolveLocale`, `isRTL`, `formattingLocale` | Yes: `locale.test.ts`, `resolve-locale.test.ts` (throws `intl_unavailable` without it) | Must confirm |
| `Intl.Locale` + `maximize()` | `isRTL` likely script | Yes: `rtl.test.ts` | Must confirm (Hermes Intl doc lists no `Intl.Locale`; the table fallback covers it, tested with `Intl.Locale` removed) |
| `Intl.Locale.prototype.getTextInfo()` / `textInfo` | `isRTL` direction | Yes: `rtl.test.ts` (both shapes stubbed) | Must confirm |
| `Intl.PluralRules` cardinal | ICU `plural` arms at run time; `i18n:check` arm validation | Yes: `plural.test.ts` (ar six categories, en/fr), `check.test.ts` | Must confirm (Hermes Intl doc lists none: P7 needs a polyfill + ADR) |
| `Intl.PluralRules` ordinal | ICU `selectordinal` | Yes: `plural.test.ts` (en 1st–111th, fr 1er/2e, ar) | Must confirm |
| `Intl.NumberFormat` with `-u-nu-latn` | `{n, number}` and plural `#` | Yes: `locale.test.ts`, `plural.test.ts` (Latin digits for ar, ar-EG, ar-SA, fa-IR, hi-IN, bn-BD) | Must confirm |
| `Intl.DateTimeFormat` | Not used (D4: no date/time arguments) | n/a | n/a |
| `Intl.ListFormat` | Not used | n/a | n/a |

Nothing about Hermes is claimed as verified.

## Consequences

- Positive: one checked source of truth for three locales; typed keys and arguments at compile time and run time; Arabic plural and RTL rules tested; no raw template or message text ever reaches a user or a log through an error.
- Negative (for architect review): 82 KB minified (25 KB gzipped) of runtime libraries on the client; the fr and ar content is machine-drafted; a 2–3 s enumeration test in `rtl.test.ts`; the RTL tables must be regenerated after a Node/CLDR upgrade (the test fails until they are); French `many` falls back to `other`; Hermes needs a PluralRules polyfill.

## Follow-ups

- **P3-04 (`@bricx/validation`, which depends on both money and i18n):** `errors:money.<code>` keys for every `MoneyError` code and a drift test that fails when money adds a code without a key. The ROADMAP P3-04 line is not edited, because adding this would change the task's scope.
- **P7-01:** an ESLint `no-restricted-syntax` rule for `apps/client` (CLAUDE.md rule 8): string literals as JSX text, and as `title`, `placeholder`, `label`, `accessibilityLabel` and `alt` props, are errors; `t(...)` calls and keys pass. Proposed here, not implemented (D14). A Semgrep rule would only duplicate it.
- **P7:** confirm every row of the Intl table on Hermes; add an `Intl.PluralRules` polyfill (new dependency, ADR) and, if needed, `Intl.Locale`.
- **Before production / Tolgee import:** native-speaker review of every fr and ar message and glossary entry; flip each glossary entry to `native-reviewed`.
- A per-user digit preference setting (`formattingLocale` contract).
