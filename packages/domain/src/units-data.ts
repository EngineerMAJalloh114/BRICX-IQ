// The unit table (P3-06 D3, D4; factors re-derived by hand by the architect
// and by test/factors.test.ts from the base definitions). Every factor is an
// exact terminating decimal to the SI base of its dimension (m, m2, m3, kg,
// or 1 for a count), as a string: nothing here is a float.
//
// Definitions: SI prefixes (BIPM SI Brochure); the international inch
// 0.0254 m and pound 0.45359237 kg (international yard and pound agreement
// of 1959; NIST Handbook 44 Appendix C, NIST SP 811 Appendix B); US gallon
// = 231 in3; imperial gallon = 4.54609 L (UK Weights and Measures Act 1985,
// Schedule 1); acre = 43 560 ft2; short ton = 2000 lb; long ton = 2240 lb.
// Temperature (affine) and time (no fixed working day) are left out.
export const DIMENSIONS = Object.freeze([
  "length",
  "area",
  "volume",
  "mass",
  "count",
] as const);
export type Dimension = (typeof DIMENSIONS)[number];

const UNIT_TABLE = [
  // length (base m)
  { code: "mm", dimension: "length", factor: "0.001" },
  { code: "cm", dimension: "length", factor: "0.01" },
  { code: "m", dimension: "length", factor: "1" },
  { code: "km", dimension: "length", factor: "1000" },
  { code: "in", dimension: "length", factor: "0.0254" },
  { code: "ft", dimension: "length", factor: "0.3048" },
  { code: "yd", dimension: "length", factor: "0.9144" },
  { code: "mi", dimension: "length", factor: "1609.344" },
  // area (base m2)
  { code: "mm2", dimension: "area", factor: "0.000001" },
  { code: "cm2", dimension: "area", factor: "0.0001" },
  { code: "m2", dimension: "area", factor: "1" },
  { code: "ha", dimension: "area", factor: "10000" },
  { code: "km2", dimension: "area", factor: "1000000" },
  { code: "in2", dimension: "area", factor: "0.00064516" },
  { code: "ft2", dimension: "area", factor: "0.09290304" },
  { code: "yd2", dimension: "area", factor: "0.83612736" },
  { code: "ac", dimension: "area", factor: "4046.8564224" },
  { code: "mi2", dimension: "area", factor: "2589988.110336" },
  // volume (base m3)
  { code: "cm3", dimension: "volume", factor: "0.000001" },
  { code: "l", dimension: "volume", factor: "0.001" },
  { code: "m3", dimension: "volume", factor: "1" },
  { code: "in3", dimension: "volume", factor: "0.000016387064" },
  { code: "ft3", dimension: "volume", factor: "0.028316846592" },
  { code: "yd3", dimension: "volume", factor: "0.764554857984" },
  { code: "us_gal", dimension: "volume", factor: "0.003785411784" },
  { code: "imp_gal", dimension: "volume", factor: "0.00454609" },
  // mass (base kg)
  { code: "g", dimension: "mass", factor: "0.001" },
  { code: "kg", dimension: "mass", factor: "1" },
  { code: "t", dimension: "mass", factor: "1000" },
  { code: "oz", dimension: "mass", factor: "0.028349523125" },
  { code: "lb", dimension: "mass", factor: "0.45359237" },
  { code: "short_ton", dimension: "mass", factor: "907.18474" },
  { code: "long_ton", dimension: "mass", factor: "1016.0469088" },
  // count
  { code: "ea", dimension: "count", factor: "1" },
] as const satisfies readonly {
  code: string;
  dimension: Dimension;
  factor: string;
}[];

export type UnitCode = (typeof UNIT_TABLE)[number]["code"];

export interface Unit {
  readonly code: UnitCode;
  readonly dimension: Dimension;
  /** Exact multiplier to the dimension's base unit, a plain decimal string. */
  readonly factor: string;
}

export const UNITS: readonly Unit[] = Object.freeze(
  UNIT_TABLE.map((unit) => Object.freeze({ ...unit })),
);
