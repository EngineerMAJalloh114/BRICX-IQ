// checkCatalogs: the logic behind `pnpm i18n:check` (P3-03 ruling, ADR
// 0046). Pure: the loader (scripts/i18n-check-lib.mjs) reads the files,
// bounds their size and parses them; this checks the parsed values. en is
// the source of truth. Problems name the locale, namespace and key, never
// the message text.
import type { ArgKind, MessageSignature } from "./icu.ts";
import { messageSignature } from "./icu.ts";
import { LIMITS } from "./limits.ts";
import { NAMESPACES, SUPPORTED_LOCALES } from "./locale.ts";
import type { Namespace, SupportedLocale } from "./locale.ts";

export type ProblemCode =
  // Files (the loader reports file_too_large, invalid_json, unexpected_file).
  | "missing_file"
  | "file_too_large"
  | "invalid_json"
  | "unexpected_file"
  | "invalid_catalog"
  | "stale_generated"
  // Keys and messages.
  | "invalid_key"
  | "key_too_long"
  | "missing_key"
  | "extra_key"
  | "invalid_message"
  | "empty_message"
  | "message_too_long"
  | "too_many_placeholders"
  | "nesting_too_deep"
  | "invalid_icu"
  | "argument_conflict"
  | "i18next_syntax"
  | "date_time_argument"
  | "tag_not_allowed"
  | "invalid_argument_name"
  | "reserved_argument"
  | "placeholder_mismatch"
  | "select_arms_mismatch"
  | "plural_arms_invalid"
  // Glossary.
  | "glossary_invalid"
  | "glossary_definition_missing"
  | "glossary_missing_text"
  | "glossary_review_missing"
  | "glossary_unknown_key"
  | "glossary_mismatch";

export interface Problem {
  readonly code: ProblemCode;
  readonly locale?: string;
  readonly namespace?: string;
  readonly key?: string;
}

export interface CatalogInput {
  /** Parsed catalog files: catalogs[locale][namespace]. */
  readonly catalogs: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  /** Parsed glossary.json. */
  readonly glossary: unknown;
  /** "locale/namespace" files the loader could not read (already reported). */
  readonly unreadable?: ReadonlySet<string>;
}

/** Review states a fr or ar glossary entry may carry (change 2). */
export const GLOSSARY_REVIEW_STATUSES = Object.freeze([
  "machine-drafted",
  "native-reviewed",
] as const);

const KEY = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/u;
const ARG_NAME = /^[a-z][A-Za-z0-9]*$/u;
const EXACT_ARM = /^=\d+$/u;
const I18NEXT_INTERPOLATION = /\{\{\s*[^{}\s][^{}]*\}\}/u;

/**
 * i18next reads these names from t()'s options object, so a message
 * argument with one of them would change how i18next resolves the key
 * (plural suffixes, context, language) instead of being formatted.
 */
export const RESERVED_ARGUMENTS: ReadonlySet<string> = new Set([
  "count",
  "context",
  "ordinal",
  "lng",
  "lngs",
  "ns",
  "defaultValue",
  "replace",
  "returnObjects",
  "returnDetails",
  "joinArrays",
  "postProcess",
  "interpolation",
  "skipInterpolation",
  "keyPrefix",
  "fallbackLng",
  "nsSeparator",
  "keySeparator",
]);

/** Plural categories every message must cover per locale (D5). */
const REQUIRED_PLURAL: Readonly<Record<SupportedLocale, readonly string[]>> = {
  en: ["one", "other"],
  fr: ["one", "other"],
  ar: ["zero", "one", "two", "few", "many", "other"],
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function pluralCategories(
  locale: string,
  type: "cardinal" | "ordinal",
): ReadonlySet<string> {
  return new Set(
    new Intl.PluralRules(locale, { type }).resolvedOptions().pluralCategories,
  );
}

interface Checked {
  readonly signature: MessageSignature;
}

/** Checks one message on its own; returns its signature when usable. */
function checkMessage(
  locale: SupportedLocale,
  value: unknown,
  report: (code: ProblemCode) => void,
): Checked | undefined {
  if (typeof value !== "string") {
    report("invalid_message");
    return undefined;
  }
  if (value.length > LIMITS.message) {
    report("message_too_long");
    return undefined;
  }
  if (value.trim() === "") {
    report("empty_message");
    return undefined;
  }
  // i18next's own nesting syntax is plain text to ICU, so it would reach
  // users verbatim. Its {{name}} interpolation is checked only when the ICU
  // parse fails: "{s, select, a {{x}} other {y}}" is valid ICU.
  if (value.includes("$t(")) {
    report("i18next_syntax");
    return undefined;
  }
  const result = messageSignature(value, locale);
  if (!result.ok) {
    report(
      result.reason === "invalid_icu" && I18NEXT_INTERPOLATION.test(value)
        ? "i18next_syntax"
        : result.reason,
    );
    return undefined;
  }
  let usable = true;
  const { args, arms } = result.signature;
  for (const [name, kind] of Object.entries(args)) {
    if (kind === "date" || kind === "time") {
      report("date_time_argument");
      usable = false;
    } else if (kind === "tag") {
      report("tag_not_allowed");
      usable = false;
    } else if (!ARG_NAME.test(name)) {
      report("invalid_argument_name");
      usable = false;
    } else if (RESERVED_ARGUMENTS.has(name)) {
      report("reserved_argument");
      usable = false;
    } else if (kind === "plural" || kind === "selectordinal") {
      const allowed = pluralCategories(
        locale,
        kind === "plural" ? "cardinal" : "ordinal",
      );
      const present = arms[name] ?? [];
      const required = kind === "plural" ? REQUIRED_PLURAL[locale] : ["other"];
      const valid =
        present.every((arm) => allowed.has(arm) || EXACT_ARM.test(arm)) &&
        required.every((arm) => present.includes(arm));
      if (!valid) {
        report("plural_arms_invalid");
        usable = false;
      }
    }
  }
  return usable ? { signature: result.signature } : undefined;
}

/**
 * The signature of an en message when its key and text pass every check
 * that does not need another locale; else undefined. The key generator
 * uses it, so a message the checker rejects never gets a typed key.
 */
export function usableEnSignature(
  key: string,
  value: unknown,
): MessageSignature | undefined {
  if (key.length > LIMITS.key || !KEY.test(key)) return undefined;
  return checkMessage("en", value, () => undefined)?.signature;
}

const sameArgs = (
  a: Readonly<Record<string, ArgKind>>,
  b: Readonly<Record<string, ArgKind>>,
) => {
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  return (
    keysA.length === keysB.length &&
    keysA.every((k, i) => k === keysB[i] && a[k] === b[k])
  );
};

/** Compares a translation's signature with en's. */
function compareWithEn(
  en: MessageSignature,
  other: MessageSignature,
  report: (code: ProblemCode) => void,
): void {
  if (!sameArgs(en.args, other.args)) {
    report("placeholder_mismatch");
    return;
  }
  for (const [name, kind] of Object.entries(en.args)) {
    if (kind !== "select") continue;
    const a = en.arms[name] ?? [];
    const b = other.arms[name] ?? [];
    if (a.length !== b.length || a.some((arm, i) => arm !== b[i])) {
      report("select_arms_mismatch");
    }
  }
}

/** Validated messages of one catalog: key -> signature (undefined if unusable). */
type Valid = Map<string, Checked | undefined>;

function checkCatalog(
  locale: SupportedLocale,
  namespace: Namespace,
  catalog: Readonly<Record<string, unknown>>,
  problems: Problem[],
): Valid {
  const valid: Valid = new Map();
  for (const key of Object.keys(catalog).sort()) {
    const report = (code: ProblemCode) =>
      problems.push({ code, locale, namespace, key });
    if (key.length > LIMITS.key) {
      problems.push({ code: "key_too_long", locale, namespace });
      continue;
    }
    if (!KEY.test(key)) {
      report("invalid_key");
      continue;
    }
    valid.set(key, checkMessage(locale, catalog[key], report));
  }
  return valid;
}

function checkGlossary(
  glossary: unknown,
  catalogs: CatalogInput["catalogs"],
  readable: (locale: string, namespace: string) => boolean,
  problems: Problem[],
): void {
  const report = (code: ProblemCode, key?: string, locale?: string) =>
    problems.push({
      code,
      ...(locale === undefined ? {} : { locale }),
      ...(key === undefined ? {} : { key }),
    });
  const terms: unknown = isPlainObject(glossary)
    ? glossary["terms"]
    : undefined;
  if (!isPlainObject(terms)) {
    report("glossary_invalid");
    return;
  }
  for (const key of Object.keys(terms).sort()) {
    const entry = terms[key];
    if (!isPlainObject(entry)) {
      report("glossary_invalid", key);
      continue;
    }
    const definition = entry["definition"];
    if (typeof definition !== "string" || definition.trim() === "") {
      report("glossary_definition_missing", key);
    }
    const [namespace, name, ...rest] = key.split(":");
    const known =
      rest.length === 0 &&
      namespace !== undefined &&
      name !== undefined &&
      (NAMESPACES as readonly string[]).includes(namespace) &&
      (!readable("en", namespace) ||
        Object.hasOwn(catalogs["en"]?.[namespace] ?? {}, name));
    if (!known) {
      report("glossary_unknown_key", key);
      continue;
    }
    for (const locale of SUPPORTED_LOCALES) {
      const text: unknown = isPlainObject(entry[locale])
        ? entry[locale]["text"]
        : undefined;
      if (typeof text !== "string" || text.trim() === "") {
        report("glossary_missing_text", key, locale);
        continue;
      }
      if (locale !== "en") {
        const review: unknown = isPlainObject(entry[locale])
          ? entry[locale]["review"]
          : undefined;
        if (
          !(GLOSSARY_REVIEW_STATUSES as readonly unknown[]).includes(review)
        ) {
          report("glossary_review_missing", key, locale);
        }
      }
      if (!readable(locale, namespace)) continue;
      const catalog = catalogs[locale]?.[namespace];
      if (
        isPlainObject(catalog) &&
        Object.hasOwn(catalog, name) &&
        catalog[name] !== text
      ) {
        report("glossary_mismatch", key, locale);
      }
    }
  }
}

/** Every problem in the catalogs and the glossary, in a fixed order. */
export function checkCatalogs(input: CatalogInput): Problem[] {
  const problems: Problem[] = [];
  const unreadable = input.unreadable ?? new Set<string>();
  const readable = (locale: string, namespace: string) =>
    !unreadable.has(`${locale}/${namespace}`) &&
    isPlainObject(input.catalogs[locale]?.[namespace]);

  for (const namespace of NAMESPACES) {
    const valid = new Map<SupportedLocale, Valid>();
    for (const locale of SUPPORTED_LOCALES) {
      if (unreadable.has(`${locale}/${namespace}`)) continue;
      const catalog = input.catalogs[locale]?.[namespace];
      if (catalog === undefined) {
        problems.push({ code: "missing_file", locale, namespace });
        continue;
      }
      if (!isPlainObject(catalog)) {
        problems.push({ code: "invalid_catalog", locale, namespace });
        continue;
      }
      valid.set(locale, checkCatalog(locale, namespace, catalog, problems));
    }
    const en = valid.get("en");
    if (en === undefined) continue;
    for (const locale of SUPPORTED_LOCALES) {
      const other = valid.get(locale);
      if (locale === "en" || other === undefined) continue;
      for (const [key, enChecked] of en) {
        const report = (code: ProblemCode) =>
          problems.push({ code, locale, namespace, key });
        if (!other.has(key)) {
          report("missing_key");
          continue;
        }
        const otherChecked = other.get(key);
        if (enChecked !== undefined && otherChecked !== undefined) {
          compareWithEn(enChecked.signature, otherChecked.signature, report);
        }
      }
      for (const key of other.keys()) {
        if (!en.has(key))
          problems.push({ code: "extra_key", locale, namespace, key });
      }
    }
  }
  checkGlossary(input.glossary, input.catalogs, readable, problems);
  return problems;
}
