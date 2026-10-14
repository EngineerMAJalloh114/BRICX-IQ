// Fallback chain project -> user -> device -> en (P3-03 ruling, D9): a table
// plus a fast-check comparison with the reference in oracle.ts.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/limits.ts";
import { resolveLocale } from "../src/locale.ts";
import {
  LANGUAGES,
  TABLE,
  entry,
  resolveOracleChecks,
} from "./checks-resolve.ts";
import { SENTINEL, expectI18nError, timed } from "./helpers.ts";
import { refResolveLocale, refWellFormed } from "./oracle.ts";

describe("resolveLocale", () => {
  it.each(TABLE)("%s", (_name, chain, expected) => {
    expect(resolveLocale(chain)).toBe(expected);
  });

  it("agrees with the reference implementation on 2,000 generated chains", () => {
    resolveOracleChecks(resolveLocale);
  });

  it("the generators exercise both branches of the oracle (control)", () => {
    const samples = fc.sample(entry, { numRuns: 500, seed: 1 });
    const strings = samples.filter((s): s is string => typeof s === "string");
    expect(strings.some((s) => refWellFormed(s))).toBe(true);
    expect(strings.some((s) => !refWellFormed(s))).toBe(true);
    expect(new Set(samples.map((s) => refResolveLocale([s]))).size).toBe(3);
  });

  it("generator languages are not Intl aliases (the oracle's premise)", () => {
    for (const language of LANGUAGES)
      expect(Intl.getCanonicalLocales(language)).toEqual([language]);
  });

  it(`accepts ${String(LIMITS.chain)} entries and rejects ${String(LIMITS.chain + 1)} quickly`, () => {
    expect(
      resolveLocale(Array.from({ length: LIMITS.chain }, () => "de")),
    ).toBe("en");
    expectI18nError(
      () => resolveLocale(Array.from({ length: LIMITS.chain + 1 }, () => "fr")),
      "chain_too_long",
    );
    const huge = Array.from({ length: 1_000_000 }, () => "fr");
    expect(
      timed(() => expectI18nError(() => resolveLocale(huge), "chain_too_long")),
    ).toBeLessThan(50);
  });

  it("skips a 1 MB entry without parsing it", () => {
    const huge = "fr-" + "a".repeat(1_000_000);
    expect(
      timed(() => {
        expect(resolveLocale([huge, "ar"])).toBe("ar");
      }),
    ).toBeLessThan(50);
  });

  it("rejects a chain that is not an array, without echoing it", () => {
    expectI18nError(
      () => resolveLocale(SENTINEL as unknown as readonly unknown[]),
      "invalid_chain",
    );
    expectI18nError(
      () => resolveLocale(undefined as unknown as readonly unknown[]),
      "invalid_chain",
    );
  });
});
