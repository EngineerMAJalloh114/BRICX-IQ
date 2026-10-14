// CountryCodeSchema (P3-04 D2): ISO 3166-1 alpha-2, uppercase only, from
// the generated data/countries.json (datasets/country-list d214094).
import { describe, expect, it } from "vitest";
import { COUNTRY_CODES, CountryCodeSchema } from "../src/country.ts";
import { expectRejectedWithoutEcho, messageOf, parsed } from "./helpers.ts";

const INVALID = "validation:invalid_country";

describe("CountryCodeSchema", () => {
  it("has 249 codes, sorted, unique, frozen", () => {
    expect(COUNTRY_CODES).toHaveLength(249);
    expect([...COUNTRY_CODES]).toEqual([...COUNTRY_CODES].sort());
    expect(new Set(COUNTRY_CODES).size).toBe(249);
    expect(Object.isFrozen(COUNTRY_CODES)).toBe(true);
  });

  it.each(["SL", "GB", "US", "FR", "SA", "AE", "EH", "PS", "TW", "AQ"])(
    "accepts %s",
    (code) => {
      expect(parsed(CountryCodeSchema, code)).toBe(code);
    },
  );

  it.each([
    ["lowercase", "sl"],
    ["mixed case", "Sl"],
    ["alpha-3", "SLE"],
    ["numeric", "694"],
    ["Kosovo (user-assigned, not ISO)", "XK"],
    ["EU (exceptionally reserved)", "EU"],
    ["UK (exceptionally reserved)", "UK"],
    ["user-assigned AA", "AA"],
    ["user-assigned ZZ", "ZZ"],
    ["withdrawn YU", "YU"],
    ["leading space", " SL"],
    ["trailing space", "SL "],
    ["empty", ""],
  ])("rejects %s", (_label, input) => {
    expect(expectRejectedWithoutEcho(CountryCodeSchema, input)).toEqual([
      INVALID,
    ]);
  });

  it("rejects a non-string", () => {
    expect(messageOf(CountryCodeSchema, 694)).toBe(INVALID);
  });
});
