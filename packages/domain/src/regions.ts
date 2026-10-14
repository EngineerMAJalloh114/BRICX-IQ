// Per-region unit defaults (P3-06 D6, ruling 1): data, never code branches.
// data/region-units.json is generated from CLDR supplemental measurementData
// (pinned by SHA-256 in data/source/source.json) by scripts/
// gen-region-units.mjs: CLDR "metric" -> metric, "US" -> us_customary, "UK"
// -> metric (UK construction is metric; ADR 0049). A country with no row
// gets the world default. P6-03 region configs override per org or project.
import regionUnits from "../data/region-units.json";
import { QuantityError } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import type { UnitCode } from "./units-data.ts";

export const UNIT_SYSTEM_NAMES = Object.freeze([
  "metric",
  "us_customary",
] as const);
export type UnitSystemName = (typeof UNIT_SYSTEM_NAMES)[number];

/** The slots a region default fills; "liquid" is volume for liquids. */
export const UNIT_SLOTS = Object.freeze([
  "length",
  "area",
  "volume",
  "mass",
  "liquid",
] as const);
export type UnitSlot = (typeof UNIT_SLOTS)[number];

export type UnitSystem = Readonly<Record<UnitSlot, UnitCode>>;

/** Each system's default unit per slot (plan, approved). */
export const UNIT_SYSTEMS: Readonly<Record<UnitSystemName, UnitSystem>> =
  Object.freeze({
    metric: Object.freeze({
      length: "m",
      area: "m2",
      volume: "m3",
      mass: "kg",
      liquid: "l",
    }),
    us_customary: Object.freeze({
      length: "ft",
      area: "ft2",
      volume: "yd3",
      mass: "lb",
      liquid: "us_gal",
    }),
  });

export interface RegionRow {
  /** The CLDR measurementSystem type the row came from. */
  readonly cldr: string;
  readonly system: UnitSystemName;
}

export interface RegionUnitDefaults {
  readonly default: UnitSystemName;
  /** ISO 3166-1 alpha-2 code -> row, for countries CLDR lists explicitly. */
  readonly countries: Readonly<Record<string, RegionRow>>;
}

export const isUnitSystemName = (value: unknown): value is UnitSystemName =>
  UNIT_SYSTEM_NAMES.some((name) => name === value);

/** A system name from the generated data; anything else is a broken data file. */
export function parseUnitSystemName(value: string): UnitSystemName {
  if (!isUnitSystemName(value)) throw new QuantityError("invalid_slot");
  return value;
}

const rows: Record<string, RegionRow> = {};
for (const [code, row] of Object.entries(regionUnits.countries)) {
  rows[code] = Object.freeze({
    cldr: row.cldr,
    system: parseUnitSystemName(row.system),
  });
}

export const REGION_UNIT_DEFAULTS: RegionUnitDefaults = Object.freeze({
  default: parseUnitSystemName(regionUnits.default),
  countries: Object.freeze(rows),
});

const COUNTRY = /^[A-Z]{2}$/;

/** The unit system of a country (two uppercase letters); the default when CLDR has no row. */
export function unitSystemFor(
  country: string,
): Result<UnitSystemName, QuantityError> {
  if (
    typeof country !== "string" ||
    country.length !== LIMITS.countryCode ||
    !COUNTRY.test(country)
  )
    return err(new QuantityError("invalid_country"));
  const row = Object.hasOwn(REGION_UNIT_DEFAULTS.countries, country)
    ? REGION_UNIT_DEFAULTS.countries[country]
    : undefined;
  return ok(row === undefined ? REGION_UNIT_DEFAULTS.default : row.system);
}

const isSlot = (value: unknown): value is UnitSlot =>
  typeof value === "string" && UNIT_SLOTS.some((slot) => slot === value);

/** The default unit of a slot in a country's system. */
export function defaultUnit(
  country: string,
  slot: UnitSlot,
): Result<UnitCode, QuantityError> {
  const system = unitSystemFor(country);
  if (!system.ok) return system;
  if (!isSlot(slot)) return err(new QuantityError("invalid_slot"));
  return ok(UNIT_SYSTEMS[system.value][slot]);
}
