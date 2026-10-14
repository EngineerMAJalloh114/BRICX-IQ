// Sabotage (P3 rule 1, permanent): the checks below pass on the real code
// and fail on each deliberately broken variant in mutants.ts. If a check
// stops catching its mutant, this file fails. The count of caught mutants
// is asserted, so a mutant cannot be dropped silently.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkTree } from "../scripts/i18n-check-lib.mjs";
import { messageSignature } from "../src/icu.ts";
import { formattingLocale, resolveLocale } from "../src/locale.ts";
import { isRTL } from "../src/rtl.ts";
import { buildCase, fixturesDir, withoutKey } from "./check-fixtures.ts";
import { formattingChecks } from "./checks-format.ts";
import { icuOracleChecks } from "./checks-icu.ts";
import { resolveOracleChecks, resolveTableChecks } from "./checks-resolve.ts";
import { rtlChecks } from "./checks-rtl.ts";
import {
  checkTreeIgnoring,
  formattingWithoutLatn,
  isRTLLanguageOnly,
  isRTLOnlyAr,
  resolveCaseSensitive,
  resolveLastMatch,
  resolveNoValidation,
  signatureSelectAsString,
  signatureWithoutArms,
} from "./mutants.ts";

const expected = JSON.parse(
  readFileSync(path.join(fixturesDir, "expected.json"), "utf8"),
) as Record<string, string[]>;

/** Fails (throws) when `check` passes. */
async function expectCaught(check: () => unknown): Promise<void> {
  let failed = false;
  try {
    await check();
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
}

type Tree = (root: string) => Promise<{ lines: readonly string[] }>;

async function fixtureChecks(
  tree: Tree,
  names: readonly string[],
): Promise<void> {
  for (const name of names) {
    const { root, cleanup } = await buildCase(name);
    try {
      const { lines } = await tree(root);
      expect(lines.map(withoutKey).sort()).toEqual(
        [...(expected[name] ?? [])].sort(),
      );
    } finally {
      await cleanup();
    }
  }
}

// Fixture case(s) each detector must keep failing.
const CHECKER_MUTANTS: readonly [string, readonly string[]][] = [
  ["missing_key", ["missing-key"]],
  ["extra_key", ["extra-key"]],
  ["placeholder_mismatch", ["placeholder-name", "placeholder-type"]],
  ["select_arms_mismatch", ["select-arms"]],
  ["plural_arms_invalid", ["plural-arms-ar", "plural-arms-category"]],
  ["empty_message", ["empty"]],
  ["message_too_long", ["too-long"]],
  ["too_many_placeholders", ["too-many-placeholders"]],
  ["nesting_too_deep", ["nesting"]],
  ["stale_generated", ["stale-generated"]],
  ["glossary_mismatch", ["glossary-mismatch"]],
  ["glossary_review_missing", ["glossary-review-missing"]],
  ["missing_file", ["missing-file"]],
  ["unexpected_file", ["unexpected-file"]],
  ["file_too_large", ["file-too-large"]],
];

let caught = 0;

describe("the real code passes every check", () => {
  it("resolveLocale, isRTL, ICU signatures, formattingLocale", () => {
    resolveTableChecks(resolveLocale);
    resolveOracleChecks(resolveLocale, 300);
    rtlChecks(isRTL);
    icuOracleChecks(messageSignature, 300);
    formattingChecks(formattingLocale);
  });

  it("the checker on the fixtures the mutants use", async () => {
    await fixtureChecks(checkTree, [
      ...new Set(CHECKER_MUTANTS.flatMap(([, names]) => names)),
    ]);
  }, 60_000);
});

describe("every mutant is caught", () => {
  it.each([
    ["resolveCaseSensitive", resolveCaseSensitive],
    ["resolveNoValidation", resolveNoValidation],
    ["resolveLastMatch", resolveLastMatch],
  ] as const)("%s", async (_name, mutant) => {
    await expectCaught(() => {
      resolveTableChecks(mutant);
    });
    await expectCaught(() => {
      resolveOracleChecks(mutant, 300);
    });
    caught += 1;
  });

  it.each([
    ["isRTLLanguageOnly", isRTLLanguageOnly],
    ["isRTLOnlyAr", isRTLOnlyAr],
  ] as const)("%s", async (_name, mutant) => {
    await expectCaught(() => {
      rtlChecks(mutant);
    });
    caught += 1;
  });

  it.each([
    ["signatureWithoutArms", signatureWithoutArms],
    ["signatureSelectAsString", signatureSelectAsString],
  ] as const)("%s", async (_name, mutant) => {
    await expectCaught(() => {
      icuOracleChecks(mutant, 300);
    });
    caught += 1;
  });

  it("formattingWithoutLatn", async () => {
    await expectCaught(() => {
      formattingChecks(formattingWithoutLatn);
    });
    caught += 1;
  });

  it.each(CHECKER_MUTANTS)(
    "checker ignoring %s",
    async (code, names) => {
      for (const name of names) {
        await expectCaught(() =>
          fixtureChecks(checkTreeIgnoring(code), [name]),
        );
      }
      caught += 1;
    },
    60_000,
  );

  it("caught all 23 mutants", () => {
    expect(caught).toBe(3 + 2 + 2 + 1 + CHECKER_MUTANTS.length);
    expect(caught).toBe(23);
  });
});
