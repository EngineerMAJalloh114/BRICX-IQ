// formattingLocale checks shared by sabotage.test.ts: Latin digits for
// every locale (D3).
import { expect } from "vitest";
import { ARABIC_INDIC_DIGIT } from "./helpers.ts";

export type FormattingLocale = (tag: unknown) => string;

export function formattingChecks(formattingLocale: FormattingLocale): void {
  for (const tag of ["ar", "ar-EG", "ar-SA", "fa-IR"]) {
    const nf = new Intl.NumberFormat(formattingLocale(tag));
    expect(nf.format(1234567)).not.toMatch(ARABIC_INDIC_DIGIT);
  }
  expect(formattingLocale("fr-CA-u-nu-arab")).toBe("fr-CA-u-nu-latn");
}
