// ICU plurals per locale (P3-03 ruling): en one/other; fr one (0, 1 and 1.5)
// and other, with CLDR 48's `many` (exact millions) falling back to `other`
// because fr messages need not carry it (D5); ar all six categories. Digits
// are Latin in every locale (D3).
import { describe, expect, it } from "vitest";
import { createTranslator } from "../src/translate.ts";
import { ARABIC_INDIC_DIGIT } from "./helpers.ts";

const en = createTranslator("en");
const fr = createTranslator("fr");
const ar = createTranslator("ar");

describe("CLDR plural categories on Node 24 (the premise)", () => {
  it("en has one/other, fr has one/many/other, ar has all six", () => {
    const cats = (l: string) =>
      new Intl.PluralRules(l).resolvedOptions().pluralCategories;
    expect(cats("en")).toEqual(["one", "other"]);
    expect(cats("fr")).toEqual(["one", "many", "other"]);
    expect(cats("ar")).toEqual(["zero", "one", "two", "few", "many", "other"]);
  });
});

describe("en: one and other", () => {
  it.each([
    [0, "0 open defects"],
    [1, "1 open defect"],
    [2, "2 open defects"],
    [1_000_000, "1,000,000 open defects"],
  ])("%d -> %s", (n, text) => {
    expect(en.t("field:defects_open", { defects: n })).toBe(text);
  });
});

describe("fr: one covers 0, 1 and 1.5; other from 2", () => {
  it.each([
    [0, "one", "0 défaut ouvert"],
    [1, "one", "1 défaut ouvert"],
    [1.5, "one", "1,5 défaut ouvert"],
    [2, "other", "2 défauts ouverts"],
    [17, "other", "17 défauts ouverts"],
  ])("%d is %s -> %s", (n, category, text) => {
    expect(new Intl.PluralRules("fr").select(n)).toBe(category);
    expect(fr.t("field:defects_open", { defects: n })).toBe(text);
  });

  it("1,000,000 is `many` in CLDR 48 and falls back to the `other` arm", () => {
    expect(new Intl.PluralRules("fr").select(1_000_000)).toBe("many");
    expect(fr.t("field:defects_open", { defects: 1_000_000 })).toMatch(
      /^1\s000\s000 défauts ouverts$/u,
    );
  });
});

describe("ar: zero, one, two, few, many, other", () => {
  it.each([
    [0, "zero", "لا توجد عيوب مفتوحة"],
    [1, "one", "عيب مفتوح واحد"],
    [2, "two", "عيبان مفتوحان"],
    [3, "few", "3 عيوب مفتوحة"],
    [10, "few", "10 عيوب مفتوحة"],
    [11, "many", "11 عيبًا مفتوحًا"],
    [99, "many", "99 عيبًا مفتوحًا"],
    [100, "other", "100 عيب مفتوح"],
    [102, "other", "102 عيب مفتوح"],
    [1_234, "many", "1,234 عيبًا مفتوحًا"],
  ])("%d is %s -> %s", (n, category, text) => {
    expect(new Intl.PluralRules("ar").select(n)).toBe(category);
    const out = ar.t("field:defects_open", { defects: n });
    expect(out).toBe(text);
    expect(out).not.toMatch(ARABIC_INDIC_DIGIT);
  });

  it("each of the six categories gives a different text", () => {
    const outs = [0, 1, 2, 3, 11, 100].map((n) =>
      ar.t("field:defects_open", { defects: n }),
    );
    expect(new Set(outs).size).toBe(6);
  });
});

describe("selectordinal", () => {
  it.each([
    [1, "1st floor"],
    [2, "2nd floor"],
    [3, "3rd floor"],
    [4, "4th floor"],
    [11, "11th floor"],
    [12, "12th floor"],
    [13, "13th floor"],
    [21, "21st floor"],
    [22, "22nd floor"],
    [23, "23rd floor"],
    [111, "111th floor"],
  ])("en %d -> %s", (n, text) => {
    expect(en.t("field:floor_ordinal", { floor: n })).toBe(text);
  });

  it("fr and ar", () => {
    expect(fr.t("field:floor_ordinal", { floor: 1 })).toBe("1er étage");
    expect(fr.t("field:floor_ordinal", { floor: 2 })).toBe("2e étage");
    expect(ar.t("field:floor_ordinal", { floor: 3 })).toBe("الطابق 3");
  });
});
