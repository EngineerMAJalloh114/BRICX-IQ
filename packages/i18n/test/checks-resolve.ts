// Checks for the fallback chain (D9), shared by resolve-locale.test.ts (real
// code) and sabotage.test.ts (mutants): a table plus a fast-check comparison
// with the reference in oracle.ts.
import fc from "fast-check";
import { expect } from "vitest";
import { refResolveLocale } from "./oracle.ts";

// The real function under test; sabotage.test.ts passes mutants instead.
export type Resolve = (chain: readonly unknown[]) => string;

export const TABLE: readonly [string, readonly unknown[], string][] = [
  ["project wins", ["fr", "ar", "en"], "fr"],
  ["user when project unset", [undefined, "ar-EG", "fr"], "ar"],
  ["device when project and user unset", [null, undefined, "fr-CA"], "fr"],
  ["en when nothing is set", [undefined, null, undefined], "en"],
  ["empty chain", [], "en"],
  ["case-insensitive language", ["AR-eg"], "ar"],
  ["upper-case tag", ["FR"], "fr"],
  ["region ignored", ["en-GB"], "en"],
  ["script ignored", ["ar-Latn"], "ar"],
  ["extensions ignored", ["fr-u-nu-arab"], "fr"],
  ["unsupported language skipped", ["de-DE", "ar"], "ar"],
  ["only unsupported", ["de", "ja", "zh-Hant"], "en"],
  ["malformed entry skipped", ["en_US", "fr"], "fr"],
  ["empty string skipped", ["", "ar"], "ar"],
  ["non-string skipped", [42, { tag: "fr" }, ["fr"], "ar"], "ar"],
  ["oversized entry skipped", ["fr-" + "a".repeat(40), "ar"], "ar"],
  ["ISO 639-2 alias ara is ar", ["ara"], "ar"],
  ["ISO 639-2 alias fre is fr", ["fre"], "fr"],
  ["Hebrew alias iw is unsupported", ["iw", "fr"], "fr"],
  ["language-only match, not prefix", ["frr", "ar"], "ar"],
  ["arb (Standard Arabic) canonicalises to ar", ["arb"], "ar"],
  [
    "full chain of eight",
    [null, null, null, null, null, null, null, "fr"],
    "fr",
  ],
];

export function resolveTableChecks(resolve: Resolve): void {
  for (const [, chain, expected] of TABLE)
    expect(resolve(chain)).toBe(expected);
}

// Languages whose tags Intl does not rewrite (no aliases), so the oracle's
// lower-casing equals Intl's canonical language.
export const LANGUAGES = [
  "en",
  "fr",
  "ar",
  "de",
  "es",
  "zh",
  "ja",
  "he",
  "fa",
  "ur",
  "sw",
  "pt",
  "haw",
  "yue",
  "fil",
  "ast",
  "frr",
  "ary",
];
const SCRIPTS = ["Latn", "Arab", "Cyrl", "Hant"];
const REGIONS = ["US", "GB", "FR", "CA", "EG", "SA", "SL", "419", "001"];
const VARIANTS = ["rozaj", "1996", "valencia"];

const caseMix = (s: string) =>
  fc
    .array(fc.boolean(), { minLength: s.length, maxLength: s.length })
    .map((flags) =>
      Array.from(s)
        .map((c, i) => (flags[i] === true ? c.toUpperCase() : c.toLowerCase()))
        .join(""),
    );

const wellFormedTag = fc
  .record({
    language: fc.constantFrom(...LANGUAGES),
    script: fc.option(fc.constantFrom(...SCRIPTS), { nil: undefined }),
    region: fc.option(fc.constantFrom(...REGIONS), { nil: undefined }),
    variant: fc.option(fc.constantFrom(...VARIANTS), { nil: undefined }),
    numbering: fc.option(fc.constantFrom("latn", "arab"), { nil: undefined }),
  })
  .map(({ language, script, region, variant, numbering }) =>
    [
      language,
      script,
      region,
      variant,
      numbering === undefined ? undefined : `u-nu-${numbering}`,
    ]
      .filter((p) => p !== undefined)
      .join("-"),
  )
  .chain(caseMix);

// Each breaks the grammar in a way both Intl and the oracle reject.
const malformedTag = fc.oneof(
  wellFormedTag.map((t) => t.replace("-", "_")),
  wellFormedTag.map((t) => `${t}-`),
  wellFormedTag.map((t) => `-${t}`),
  wellFormedTag.map((t) => t.replace("-", "--")),
  wellFormedTag.map((t) => `${t}-abcdefghi`),
  wellFormedTag.map((t) => ` ${t}`),
  fc.constantFrom("", "e", "123", "x", "en-é"),
);

export const entry = fc.oneof(
  { weight: 5, arbitrary: wellFormedTag },
  { weight: 2, arbitrary: malformedTag },
  {
    weight: 1,
    arbitrary: fc.constantFrom(undefined, null, 7, "fr-" + "a".repeat(40)),
  },
);

export function resolveOracleChecks(resolve: Resolve, runs = 2_000): void {
  fc.assert(
    fc.property(fc.array(entry, { maxLength: 8 }), (chain) => {
      expect(resolve(chain)).toBe(refResolveLocale(chain));
    }),
    { numRuns: runs, seed: 303 },
  );
}
