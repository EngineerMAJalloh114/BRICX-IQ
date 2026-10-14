// CountryCodeSchema (P3-04 D2): ISO 3166-1 alpha-2, uppercase, from
// data/countries.json, generated from a pinned snapshot of
// datasets/country-list (d214094, 2026-07-27, 249 codes). User-assigned
// codes (XK, AA, ZZ...) and exceptionally reserved ones (EU, UK) are not in
// it. Country names are display text: they come from i18n, not from here.
import type { z } from "zod";
import countries from "../data/countries.json";
import { boundedString, issueMessage } from "./bounded.ts";
import { FORMATS } from "./formats.ts";

export const COUNTRY_CODES: readonly string[] = Object.freeze([
  ...countries.codes,
]);

export const CountryCodeSchema = boundedString(
  FORMATS.country,
  issueMessage("invalid_country"),
).brand<"CountryCode">();

export type CountryCode = z.output<typeof CountryCodeSchema>;
