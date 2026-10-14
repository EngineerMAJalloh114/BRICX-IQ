// glossary.json (P3-03 ruling, D13, change 2): at least 30 construction
// terms, each with a definition for translators and text in en, fr and ar;
// fr and ar carry a review status, and every one is still "machine-drafted"
// (nothing is presented as final). Each term is a catalog key whose text
// equals the glossary text in every locale.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RESOURCES } from "../src/catalog.ts";
import { GLOSSARY_REVIEW_STATUSES, checkCatalogs } from "../src/check.ts";
import type { CatalogInput } from "../src/check.ts";
import { NAMESPACES, SUPPORTED_LOCALES } from "../src/locale.ts";

interface Entry {
  definition: string;
  en: { text: string; review?: string };
  fr: { text: string; review?: string };
  ar: { text: string; review?: string };
}
const glossaryPath = path.join(import.meta.dirname, "../glossary.json");
const glossary = JSON.parse(readFileSync(glossaryPath, "utf8")) as {
  terms: Record<string, Entry>;
};
const terms = Object.entries(glossary.terms);

const RULING_TERMS = [
  "construction:site",
  "construction:project",
  "construction:variation_order",
  "finance:requisition",
  "finance:retention",
  "finance:payment_certificate",
  "construction:snag_list",
  "construction:daywork",
  "field:toolbox_talk",
  "construction:change_order",
];

const input = (g: unknown): CatalogInput => ({
  catalogs: RESOURCES,
  glossary: g,
});

describe("glossary.json", () => {
  it("has at least 30 terms, including the ruling's examples", () => {
    expect(terms.length).toBeGreaterThanOrEqual(30);
    for (const key of RULING_TERMS)
      expect(Object.keys(glossary.terms)).toContain(key);
  });

  it.each(terms)(
    "%s has a definition and text in all three locales",
    (_key, entry) => {
      expect(entry.definition.trim()).not.toBe("");
      for (const locale of SUPPORTED_LOCALES)
        expect(entry[locale].text.trim()).not.toBe("");
    },
  );

  it.each(terms)(
    "%s: fr and ar are machine-drafted, awaiting native review",
    (_key, entry) => {
      expect(entry.fr.review).toBe("machine-drafted");
      expect(entry.ar.review).toBe("machine-drafted");
      expect(entry.en.review).toBeUndefined();
      expect(GLOSSARY_REVIEW_STATUSES).toContain(entry.fr.review);
    },
  );

  it.each(terms)(
    "%s is a catalog key with the same text in every locale",
    (key, entry) => {
      const [ns, name] = key.split(":");
      expect(NAMESPACES).toContain(ns);
      for (const locale of SUPPORTED_LOCALES) {
        const catalog = RESOURCES[locale][
          ns as (typeof NAMESPACES)[number]
        ] as Record<string, string>;
        expect(catalog[name ?? ""]).toBe(entry[locale].text);
      }
    },
  );

  it("the checker passes the real glossary", () => {
    expect(checkCatalogs(input(glossary))).toEqual([]);
  });

  it("a term without a review status fails the checker (change 2)", () => {
    for (const locale of ["fr", "ar"] as const) {
      const copy = structuredClone(glossary);
      const first = Object.values(copy.terms)[0];
      if (first === undefined) throw new Error("empty glossary");
      delete first[locale].review;
      expect(checkCatalogs(input(copy)).map((p) => p.code)).toEqual([
        "glossary_review_missing",
      ]);
    }
  });

  it("an unknown review status fails the checker", () => {
    const copy = structuredClone(glossary);
    const first = Object.values(copy.terms)[0];
    if (first === undefined) throw new Error("empty glossary");
    first.ar.review = "final";
    expect(checkCatalogs(input(copy)).map((p) => p.code)).toEqual([
      "glossary_review_missing",
    ]);
  });
});
