// checkCatalogs unit cases the file fixtures do not cover: plural and
// ordinal arm rules per locale (D5), exact `=N` arms, and the comparison
// with en running on in-memory catalogs.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkCatalogs } from "../src/check.ts";
import type { CatalogInput, Problem } from "../src/check.ts";
import { NAMESPACES, SUPPORTED_LOCALES } from "../src/locale.ts";

const baseDir = path.join(import.meta.dirname, "fixtures/check/_base");
const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(path.join(baseDir, rel), "utf8"));

type Catalogs = Record<string, Record<string, Record<string, unknown>>>;

function baseInput(): { catalogs: Catalogs; glossary: unknown } {
  const catalogs: Catalogs = {};
  for (const locale of SUPPORTED_LOCALES) {
    catalogs[locale] = {};
    for (const ns of NAMESPACES) {
      catalogs[locale][ns] = readJson(`locales/${locale}/${ns}.json`) as Record<
        string,
        unknown
      >;
    }
  }
  return { catalogs, glossary: readJson("glossary.json") };
}

/** Sets `key` in common for each locale given, then checks. */
function withMessages(
  messages: Partial<Record<string, string>>,
  key = "probe",
): readonly Problem[] {
  const input = baseInput();
  for (const [locale, text] of Object.entries(messages)) {
    const common = input.catalogs[locale]?.["common"];
    if (common !== undefined && text !== undefined) common[key] = text;
  }
  return checkCatalogs(input);
}

const codes = (problems: readonly Problem[]) =>
  problems.map((p) => `${p.locale ?? ""}:${p.code}`).sort();

const AR_SIX =
  "{n, plural, zero {z} one {o} two {t} few {# f} many {# m} other {# x}}";

describe("checkCatalogs", () => {
  it("passes the base fixture", () => {
    expect(checkCatalogs(baseInput() as CatalogInput)).toEqual([]);
  });

  it("reports each problem with locale, namespace and key", () => {
    const problems = withMessages({ en: "x", fr: "y" });
    expect(problems).toEqual([
      { code: "missing_key", locale: "ar", namespace: "common", key: "probe" },
    ]);
  });

  it.each([
    [
      "en =0 plus one/other",
      {
        en: "{n, plural, =0 {none} one {# a} other {# b}}",
        fr: "{n, plural, one {# a} other {# b}}",
        ar: AR_SIX,
      },
      [],
    ],
    [
      "fr may carry the optional `many` arm",
      {
        en: "{n, plural, one {a} other {b}}",
        fr: "{n, plural, one {a} many {m} other {b}}",
        ar: AR_SIX,
      },
      [],
    ],
    [
      "ar may add an exact =0 arm",
      {
        en: "{n, plural, one {a} other {b}}",
        fr: "{n, plural, one {a} other {b}}",
        ar: "{n, plural, =0 {none} zero {z} one {o} two {t} few {f} many {m} other {x}}",
      },
      [],
    ],
    [
      "fr without one",
      {
        en: "{n, plural, one {a} other {b}}",
        fr: "{n, plural, other {b}}",
        ar: AR_SIX,
      },
      ["fr:plural_arms_invalid"],
    ],
    [
      "en with a category en lacks",
      {
        en: "{n, plural, one {a} few {f} other {b}}",
        fr: "{n, plural, one {a} other {b}}",
        ar: AR_SIX,
      },
      ["en:plural_arms_invalid"],
    ],
    [
      "ar without zero",
      {
        en: "{n, plural, one {a} other {b}}",
        fr: "{n, plural, one {a} other {b}}",
        ar: "{n, plural, one {o} two {t} few {f} many {m} other {x}}",
      },
      ["ar:plural_arms_invalid"],
    ],
    [
      "a malformed exact arm",
      {
        en: "{n, plural, =x {a} one {a} other {b}}",
        fr: "{n, plural, one {a} other {b}}",
        ar: AR_SIX,
      },
      ["en:invalid_icu"],
    ],
    [
      "ordinal: en few is valid, ar has only other",
      {
        en: "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
        fr: "{n, selectordinal, one {#er} other {#e}}",
        ar: "{n, selectordinal, other {#}}",
      },
      [],
    ],
    [
      "ordinal: ar `one` is not an ar ordinal category",
      {
        en: "{n, selectordinal, one {#st} other {#th}}",
        fr: "{n, selectordinal, one {#er} other {#e}}",
        ar: "{n, selectordinal, one {#} other {#}}",
      },
      ["ar:plural_arms_invalid"],
    ],
    [
      "plural vs selectordinal is a kind mismatch",
      {
        en: "{n, plural, one {a} other {b}}",
        fr: "{n, selectordinal, one {a} other {b}}",
        ar: AR_SIX,
      },
      ["fr:placeholder_mismatch"],
    ],
    [
      "nested arguments must match too",
      {
        en: "{s, select, a {{x}} other {y}}",
        fr: "{s, select, a {{z}} other {y}}",
        ar: "{s, select, a {{x}} other {y}}",
      },
      ["fr:placeholder_mismatch"],
    ],
    [
      "a placeholder only in fr",
      { en: "Done", fr: "Fini {x}", ar: "تم" },
      ["fr:placeholder_mismatch"],
    ],
    [
      "placeholder order may differ",
      { en: "{a} then {b}", fr: "{b} puis {a}", ar: "{a} {b}" },
      [],
    ],
  ] as const)("%s", (_name, messages, expected) => {
    expect(codes(withMessages(messages))).toEqual([...expected].sort());
  });

  it("a catalog that is missing from the input is reported as missing_file", () => {
    const input = baseInput();
    delete input.catalogs["fr"]?.["field"];
    expect(checkCatalogs(input)).toEqual([
      { code: "missing_file", locale: "fr", namespace: "field" },
    ]);
  });

  it("an unreadable catalog (reported by the loader) is skipped, and so are comparisons against it", () => {
    const input = baseInput();
    delete input.catalogs["en"]?.["common"];
    expect(
      checkCatalogs({
        ...input,
        unreadable: new Set(["en/common"]),
      }),
    ).toEqual([]);
  });

  it("is deterministic: locales, namespaces and keys in a fixed order", () => {
    const input = baseInput();
    for (const locale of ["fr", "ar"])
      delete input.catalogs[locale]?.["common"]?.["save"];
    const problems = checkCatalogs(input);
    expect(problems.map((p) => `${p.locale ?? ""}:${p.code}`)).toEqual([
      "fr:missing_key",
      "ar:missing_key",
    ]);
  });
});
