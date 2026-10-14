// Plain reference implementations (P3 rule 10): written without Intl or
// intl-messageformat, so the property tests compare the real code with an
// independent oracle.

/** The locales the oracle knows, in the same order as the product. */
export const REF_SUPPORTED = ["en", "fr", "ar"] as const;
export const REF_MAX_TAG = 35;
export const REF_MAX_CHAIN = 8;

// RFC 5646 section 2.1 langtag, without extlang and grandfathered tags
// (the generators below never produce those): language, script, region,
// variants, extensions, private use. Case-insensitive.
const WELL_FORMED =
  /^[a-z]{2,3}(?:-[a-z]{4})?(?:-(?:[a-z]{2}|\d{3}))?(?:-(?:[a-z\d]{5,8}|\d[a-z\d]{3}))*(?:-[\da-wy-z](?:-[a-z\d]{2,8})+)*(?:-x(?:-[a-z\d]{1,8})+)?$/iu;

/**
 * True when `tag` matches the RFC 5646 grammar above. Repeated variants or
 * singletons (which Intl also rejects) are outside the generators' domain.
 */
export function refWellFormed(tag: string): boolean {
  return WELL_FORMED.test(tag);
}

/**
 * Reference fallback chain: the first entry that is a string of at most
 * 35 characters, well-formed, whose language subtag (lowercased) is
 * supported; else "en". The generators avoid language aliases (iw, ara,
 * fre...), which only Intl canonicalisation resolves; the table test
 * covers those.
 */
export function refResolveLocale(chain: readonly unknown[]): string {
  for (const entry of chain) {
    if (typeof entry !== "string" || entry.length > REF_MAX_TAG) continue;
    if (!refWellFormed(entry)) continue;
    const language = entry.split("-")[0]?.toLowerCase() ?? "";
    if ((REF_SUPPORTED as readonly string[]).includes(language))
      return language;
  }
  return "en";
}

/** One ICU argument in a reference signature. */
export type RefArg =
  "string" | "number" | "select" | "plural" | "selectordinal";

/** Argument kinds plus the arm names of every select and plural. */
export interface RefSignature {
  readonly args: Readonly<Record<string, RefArg>>;
  readonly arms: Readonly<Record<string, readonly string[]>>;
}

/**
 * Reference ICU parser for the subset the generators produce: literal text
 * without quotes or braces, `{a}`, `{a, number}`, `{a, select, x {...} other {...}}`,
 * `{a, plural, one {...} other {...}}` and `{a, selectordinal, ...}` with `#`.
 * Throws on anything else.
 */
export function refSignature(message: string): RefSignature {
  const args: Record<string, RefArg> = {};
  const arms: Record<string, string[]> = {};
  let pos = 0;

  const fail = (): never => {
    throw new Error("reference parser: unsupported message");
  };
  const skipSpaces = () => {
    while (message[pos] === " ") pos += 1;
  };
  const word = (): string => {
    const start = pos;
    while (pos < message.length && /[A-Za-z0-9_=]/u.test(message[pos] ?? ""))
      pos += 1;
    if (pos === start) fail();
    return message.slice(start, pos);
  };
  const expect = (ch: string) => {
    if (message[pos] !== ch) fail();
    pos += 1;
  };
  const record = (name: string, kind: RefArg) => {
    const seen = args[name];
    if (seen !== undefined && seen !== kind) fail();
    args[name] = kind;
  };

  const body = (): void => {
    while (pos < message.length && message[pos] !== "}") {
      if (message[pos] === "{") placeholder();
      else pos += 1;
    }
  };
  const placeholder = (): void => {
    expect("{");
    skipSpaces();
    const name = word();
    skipSpaces();
    if (message[pos] === "}") {
      pos += 1;
      record(name, "string");
      return;
    }
    expect(",");
    skipSpaces();
    const type = word();
    skipSpaces();
    if (type === "number") {
      expect("}");
      record(name, "number");
      return;
    }
    if (type !== "select" && type !== "plural" && type !== "selectordinal")
      fail();
    record(name, type as RefArg);
    expect(",");
    const names: string[] = [];
    skipSpaces();
    while (message[pos] !== "}") {
      names.push(word());
      skipSpaces();
      expect("{");
      body();
      expect("}");
      skipSpaces();
    }
    pos += 1;
    arms[name] = [...new Set([...(arms[name] ?? []), ...names])].sort();
  };

  body();
  if (pos !== message.length) fail();
  return { args, arms };
}
