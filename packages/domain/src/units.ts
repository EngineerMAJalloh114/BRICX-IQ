// Units of measure (P3-06 D1-D5, ruling 4). A Quantity is an exact decimal:
// a bigint coefficient at a scale of 0 to 9 (value = coefficient x 10^-scale)
// with at most 12 integer digits, and a unit code. Nothing here is a float,
// so a quantity string feeds @bricx/money's multiply without loss (12 + 9
// digits fit its 12 + 12 factor limit). JSON carries the value as a string.
// A conversion multiplies by the exact ratio of the two factors and rounds
// once, at the caller's scale with the caller's Rounding (no default).
import { Rounding, isRounding } from "@bricx/money/rounding";
import type { MessageKey } from "@bricx/i18n/keys";
import { pow10, roundDiv } from "./decimal.ts";
import { QuantityError } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";
import { DIMENSIONS, UNITS } from "./units-data.ts";
import type { Dimension, Unit, UnitCode } from "./units-data.ts";

export { DIMENSIONS, UNITS };
export type { Dimension, Unit, UnitCode };

declare const quantityBrand: unique symbol;

export interface Quantity {
  /** The value is coefficient x 10^-scale; zero is always 0n (no sign). */
  readonly coefficient: bigint;
  /** Fraction digits, 0 to 9; "12.500" keeps scale 3. */
  readonly scale: number;
  readonly unit: UnitCode;
  readonly [quantityBrand]: true;
}

export interface QuantityJson {
  readonly value: string;
  readonly unit: UnitCode;
}

export interface ConvertOptions {
  /** Fraction digits of the result, 0 to 9. */
  readonly scale: number;
  /** How the single rounding step rounds; no default (D2). */
  readonly rounding: Rounding;
}

export interface Converted {
  readonly quantity: Quantity;
  /** False when rounding changed the value. */
  readonly exact: boolean;
}

export type QuantityResult = Result<Quantity, QuantityError>;

/** The i18n key of each unit's symbol: common:unit.<code>. */
type UnitKey = `common:unit.${UnitCode}`;
type Assert<T extends true> = T;
/** Every unit key exists in the generated i18n key map (D5). */
export type UnitKeysExist = Assert<
  [UnitKey] extends [MessageKey] ? true : false
>;
export const UNIT_KEYS: Readonly<Record<UnitCode, UnitKey>> = Object.freeze(
  Object.fromEntries(
    UNITS.map((unit) => [unit.code, `common:unit.${unit.code}`]),
  ) as Record<UnitCode, UnitKey>,
);

// --- The unit table as a Map (no prototype lookups, ruling 3) --------------

interface Factor {
  /** factor = n / d, d a power of ten. */
  readonly n: bigint;
  readonly d: bigint;
}

interface UnitEntry {
  readonly unit: Unit;
  readonly factor: Factor;
}

function factorOf(decimal: string): Factor {
  const dot = decimal.indexOf(".");
  if (dot === -1) return { n: BigInt(decimal), d: 1n };
  const fraction = decimal.slice(dot + 1);
  return {
    n: BigInt(decimal.slice(0, dot) + fraction),
    d: pow10(fraction.length),
  };
}

const UNIT_BY_CODE: ReadonlyMap<string, UnitEntry> = new Map(
  UNITS.map((unit) => [unit.code, { unit, factor: factorOf(unit.factor) }]),
);

function lookupUnit(code: unknown): UnitEntry | undefined {
  if (typeof code !== "string" || code.length > LIMITS.unitCode)
    return undefined;
  return UNIT_BY_CODE.get(code);
}

export const isUnitCode = (value: unknown): value is UnitCode =>
  lookupUnit(value) !== undefined;

/** The dimension of a unit code. */
export function dimensionOf(code: UnitCode): Dimension {
  const entry = lookupUnit(code);
  if (entry === undefined) throw new QuantityError("unknown_unit");
  return entry.unit.dimension;
}

// --- Construction ----------------------------------------------------------

const made = new WeakSet<object>();

export const isQuantity = (value: unknown): value is Quantity =>
  typeof value === "object" && value !== null && made.has(value);

const isScale = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= LIMITS.maxScale;

/** |coefficient| < 10^(12 + scale). */
const inRange = (coefficient: bigint, scale: number): boolean => {
  const limit = pow10(LIMITS.integerDigits + scale);
  return coefficient < limit && coefficient > -limit;
};

function create(coefficient: bigint, scale: number, unit: UnitCode): Quantity {
  const value = Object.freeze({
    coefficient: coefficient === 0n ? 0n : coefficient,
    scale,
    unit,
  }) as unknown as Quantity;
  made.add(value);
  return value;
}

/** A quantity from a bigint coefficient and a scale. */
export function quantity(
  coefficient: bigint,
  scale: number,
  unit: string,
): QuantityResult {
  if (typeof coefficient !== "bigint")
    return err(new QuantityError("invalid_quantity"));
  if (!isScale(scale)) return err(new QuantityError("invalid_scale"));
  const entry = lookupUnit(unit);
  if (entry === undefined) return err(new QuantityError("unknown_unit"));
  if (!inRange(coefficient, scale))
    return err(new QuantityError("quantity_out_of_range"));
  return ok(create(coefficient, scale, entry.unit.code));
}

/** Optional "-", no leading zeros, optional fraction; no exponent, no spaces. */
const DECIMAL = /^(-)?(0|[1-9][0-9]*)(?:\.([0-9]+))?$/;

/** A quantity from a plain decimal string (the JSON form) and a unit code. */
export function parseQuantity(value: string, unit: string): QuantityResult {
  if (typeof value !== "string" || value.length > LIMITS.quantityString)
    return err(new QuantityError("invalid_quantity"));
  const entry = lookupUnit(unit);
  if (entry === undefined) return err(new QuantityError("unknown_unit"));
  const match = DECIMAL.exec(value);
  if (match === null) return err(new QuantityError("invalid_quantity"));
  const sign = match[1] ?? "";
  const integer = match[2] ?? "0";
  const fraction = match[3] ?? "";
  if (fraction.length > LIMITS.maxScale)
    return err(new QuantityError("quantity_precision"));
  if (integer.length > LIMITS.integerDigits)
    return err(new QuantityError("quantity_out_of_range"));
  const magnitude = BigInt(integer + fraction);
  return ok(
    create(
      sign === "-" ? -magnitude : magnitude,
      fraction.length,
      entry.unit.code,
    ),
  );
}

// --- Output ----------------------------------------------------------------

/** The exact decimal string at the quantity's scale: 12500n at 3 -> "12.500". */
export function toDecimalString(value: Quantity): string {
  own(value);
  const negative = value.coefficient < 0n;
  const digits = (negative ? -value.coefficient : value.coefficient)
    .toString()
    .padStart(value.scale + 1, "0");
  const integer = digits.slice(0, digits.length - value.scale);
  const fraction = digits.slice(digits.length - value.scale);
  return `${negative ? "-" : ""}${integer}${value.scale === 0 ? "" : `.${fraction}`}`;
}

export const toJSON = (value: Quantity): QuantityJson =>
  Object.freeze({ value: toDecimalString(value), unit: value.unit });

// --- Conversion and comparison ---------------------------------------------

function own(value: unknown): Quantity {
  if (!isQuantity(value)) throw new QuantityError("invalid_quantity");
  return value;
}

function entryOf(value: Quantity): UnitEntry {
  const entry = UNIT_BY_CODE.get(value.unit);
  if (entry === undefined) throw new QuantityError("unknown_unit");
  return entry;
}

/**
 * Converts to another unit of the same dimension, rounding once to
 * `scale` with `rounding`. A result over 12 integer digits, before or
 * after the rounding carry, is quantity_out_of_range.
 */
export function convert(
  value: Quantity,
  unit: string,
  options: ConvertOptions,
): Result<Converted, QuantityError> {
  if (!isQuantity(value)) return err(new QuantityError("invalid_quantity"));
  const to = lookupUnit(unit);
  if (to === undefined) return err(new QuantityError("unknown_unit"));
  const raw: unknown = options;
  if (typeof raw !== "object" || raw === null || !isScale(options.scale))
    return err(new QuantityError("invalid_scale"));
  if (!isRounding(options.rounding))
    return err(new QuantityError("invalid_rounding"));
  const from = entryOf(value);
  if (from.unit.dimension !== to.unit.dimension)
    return err(new QuantityError("incompatible_units"));
  // value x fromFactor / toFactor, at the target scale:
  //   coefficient x (fn / fd) x (td / tn) x 10^scale / 10^value.scale
  const numerator =
    value.coefficient * from.factor.n * to.factor.d * pow10(options.scale);
  const denominator = from.factor.d * to.factor.n * pow10(value.scale);
  const rounded = roundDiv(numerator, denominator, options.rounding);
  if (!inRange(rounded, options.scale))
    return err(new QuantityError("quantity_out_of_range"));
  return ok(
    Object.freeze({
      quantity: create(rounded, options.scale, to.unit.code),
      exact: rounded * denominator === numerator,
    }),
  );
}

/** Orders two quantities of one dimension by exact value, across units and scales. */
export function compare(
  a: Quantity,
  b: Quantity,
): Result<-1 | 0 | 1, QuantityError> {
  if (!isQuantity(a) || !isQuantity(b))
    return err(new QuantityError("invalid_quantity"));
  const ea = entryOf(a);
  const eb = entryOf(b);
  if (ea.unit.dimension !== eb.unit.dimension)
    return err(new QuantityError("incompatible_units"));
  // a = ca x fa.n / (fa.d x 10^sa); b likewise. Cross-multiply.
  const left = a.coefficient * ea.factor.n * eb.factor.d * pow10(b.scale);
  const right = b.coefficient * eb.factor.n * ea.factor.d * pow10(a.scale);
  return ok(left < right ? -1 : left > right ? 1 : 0);
}

/** True when both are quantities of one dimension with the same exact value. */
export function equals(a: Quantity, b: Quantity): boolean {
  const result = compare(a, b);
  return result.ok && result.value === 0;
}
