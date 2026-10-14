// createTranslator (P3-03, ADR 0046): an i18next instance with i18next-icu
// over the bundled catalogs, and a `t` typed from the generated en key map
// (D6). `t` also checks keys and arguments at run time, because i18next-icu
// silently returns the raw template when an argument is missing, and turns
// every formatting error into a code-only I18nError (intl-messageformat's
// errors quote the message).
import i18next from "i18next";
import ICU from "i18next-icu";
import { RESOURCES } from "./catalog.ts";
import { I18nError } from "./errors.ts";
import { MESSAGE_ARGS } from "./generated/keys.ts";
import type { ArgKind, MessageKey } from "./generated/keys.ts";
import { LIMITS } from "./limits.ts";
import {
  DEFAULT_LOCALE,
  NAMESPACES,
  SUPPORTED_LOCALES,
  formattingLocale,
  isSupportedLocale,
} from "./locale.ts";
import type { SupportedLocale } from "./locale.ts";
import { isRTL } from "./rtl.ts";

type Spec<K extends MessageKey> = (typeof MESSAGE_ARGS)[K];

type ArgValue<Kind> = Kind extends "number"
  ? number
  : Kind extends "select"
    ? string
    : string | number;

/** The arguments message K needs: numbers for plural/number, strings for select. */
export type MessageArgs<K extends MessageKey> = {
  readonly [A in keyof Spec<K>]: ArgValue<Spec<K>[A]>;
};

/** No argument for a message without placeholders, else exactly its arguments. */
export type TranslateArgs<K extends MessageKey> = keyof Spec<K> extends never
  ? []
  : [args: MessageArgs<K>];

export interface Translator {
  readonly locale: SupportedLocale;
  readonly direction: "ltr" | "rtl";
  readonly t: <K extends MessageKey>(
    key: K,
    ...args: TranslateArgs<K>
  ) => string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function checkValue(kind: ArgKind, value: unknown): string | number {
  if (value === undefined) throw new I18nError("missing_argument");
  if (typeof value === "number") {
    if (kind === "select" || !Number.isFinite(value)) {
      throw new I18nError("invalid_argument");
    }
    return value;
  }
  if (typeof value === "string" && kind !== "number") {
    if (value.length > LIMITS.argString) {
      throw new I18nError("argument_too_long");
    }
    return value;
  }
  throw new I18nError("invalid_argument");
}

/** The checked arguments for a message whose argument kinds are `spec`. */
function checkArgs(
  spec: Readonly<Record<string, ArgKind>>,
  args: unknown,
): Record<string, string | number> {
  const names = Object.keys(spec);
  if (args === undefined) {
    if (names.length > 0) throw new I18nError("missing_argument");
    return {};
  }
  if (!isPlainObject(args)) throw new I18nError("invalid_arguments");
  const given = Object.keys(args);
  if (given.length > LIMITS.args) throw new I18nError("too_many_arguments");
  for (const name of given) {
    if (!Object.hasOwn(spec, name)) throw new I18nError("unexpected_argument");
  }
  const checked: Record<string, string | number> = {};
  for (const name of names) {
    const kind = spec[name];
    if (kind !== undefined) checked[name] = checkValue(kind, args[name]);
  }
  return checked;
}

/**
 * A translator for one supported locale (from resolveLocale). Throws
 * `unsupported_locale` for anything else. Messages missing in fr or ar
 * fall back to en, which i18n:check forbids anyway.
 */
export function createTranslator(locale: SupportedLocale): Translator {
  if (!isSupportedLocale(locale)) throw new I18nError("unsupported_locale");
  const instance = i18next.createInstance();
  instance.use(
    new ICU({
      memoize: true,
      // Latin digits in every locale (D3).
      parseLngForICU: (lng) => formattingLocale(lng),
      parseErrorHandler: () => {
        throw new I18nError("format_failed");
      },
    }),
  );
  void instance.init({
    resources: RESOURCES,
    lng: locale,
    fallbackLng: DEFAULT_LOCALE,
    supportedLngs: [...SUPPORTED_LOCALES],
    ns: [...NAMESPACES],
    defaultNS: "common",
    keySeparator: false,
    nsSeparator: ":",
    initAsync: false,
    returnNull: false,
    returnEmptyString: false,
    interpolation: { escapeValue: false },
  });

  const t = (key: unknown, args?: unknown): string => {
    if (typeof key !== "string") throw new I18nError("invalid_key");
    if (key.length > LIMITS.key) throw new I18nError("key_too_long");
    if (!Object.hasOwn(MESSAGE_ARGS, key)) throw new I18nError("unknown_key");
    const known = key as MessageKey;
    const values = checkArgs(MESSAGE_ARGS[known], args);
    try {
      return instance.t(known, values);
    } catch {
      throw new I18nError("format_failed");
    }
  };

  return Object.freeze({
    locale,
    direction: isRTL(locale) ? "rtl" : "ltr",
    t,
  });
}
