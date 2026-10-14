// isRTL checks shared by rtl.test.ts (both paths) and sabotage.test.ts.
import { expect } from "vitest";

export type IsRTL = (tag: unknown) => boolean;

/** Tags and their direction on Node 24 (CLDR 48). */
export const RTL_TAGS: readonly [string, boolean][] = [
  ["ar", true],
  ["AR-eg", true],
  ["ar-SA", true],
  ["ar-u-nu-latn", true],
  ["ar-Latn", false],
  ["he", true],
  ["iw", true],
  ["fa-IR", true],
  ["ur-PK", true],
  ["ps", true],
  ["ckb", true],
  ["dv", true],
  ["yi", true],
  ["ug", true],
  ["sd", true],
  ["ks", true],
  ["az", false],
  ["az-Arab", true],
  ["az-IR", true],
  ["pa", false],
  ["pa-PK", true],
  ["pa-Arab", true],
  ["uz-AF", true],
  ["tr-Arab", true],
  ["en", false],
  ["en-GB", false],
  ["en-Arab", true],
  ["en-Hebr-IL", true],
  ["fr", false],
  ["fr-CA", false],
  ["de", false],
  ["ja", false],
  ["zh-Hant-TW", false],
  ["sr-Cyrl", false],
  ["und", false],
];

export function rtlChecks(isRTL: IsRTL): void {
  for (const [tag, rtl] of RTL_TAGS)
    expect([tag, isRTL(tag)]).toEqual([tag, rtl]);
}
