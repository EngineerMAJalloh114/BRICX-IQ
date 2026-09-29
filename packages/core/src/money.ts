/**
 * Money is stored as an integer count of the currency's minor unit
 * (cents, fils, ...) plus an ISO 4217 currency code. Never use floats.
 */

export type CurrencyCode = string;

export interface Money {
  /** Integer amount in the currency's minor unit. */
  readonly amountMinor: bigint;
  readonly currency: CurrencyCode;
}

/**
 * Minor-unit exponents for currencies that differ from the default of 2.
 * Anything not listed here uses 2 decimal places.
 */
const MINOR_UNIT_OVERRIDES: Record<string, number> = {
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
};

const CURRENCY_RE = /^[A-Z]{3}$/;

export function assertCurrency(code: string): CurrencyCode {
  if (!CURRENCY_RE.test(code)) {
    throw new Error(`Invalid currency code: ${code}`);
  }
  return code;
}

export function minorUnits(currency: CurrencyCode): number {
  assertCurrency(currency);
  return MINOR_UNIT_OVERRIDES[currency] ?? 2;
}

export function money(amountMinor: bigint | number, currency: CurrencyCode): Money {
  if (typeof amountMinor === "number" && !Number.isSafeInteger(amountMinor)) {
    throw new Error(`Money amount must be an integer, got ${amountMinor}`);
  }
  return { amountMinor: BigInt(amountMinor), currency: assertCurrency(currency) };
}

/** Parse a decimal string such as "1234.56" or "-0.5" into Money. */
export function parseMoney(value: string, currency: CurrencyCode): Money {
  const digits = minorUnits(currency);
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`Invalid money amount: ${value}`);
  const [, sign, whole, frac = ""] = m;
  if (frac.length > digits) {
    throw new Error(`${currency} allows at most ${digits} decimal places: ${value}`);
  }
  const minor = BigInt(whole + frac.padEnd(digits, "0"));
  return money(sign ? -minor : minor, currency);
}

/** Render Money as a plain decimal string, e.g. "1234.56". */
export function toDecimalString(m: Money): string {
  const digits = minorUnits(m.currency);
  const neg = m.amountMinor < 0n;
  const abs = (neg ? -m.amountMinor : m.amountMinor).toString().padStart(digits + 1, "0");
  const whole = abs.slice(0, abs.length - digits);
  const frac = abs.slice(abs.length - digits);
  return (neg ? "-" : "") + whole + (digits > 0 ? "." + frac : "");
}

function assertSameCurrency(a: Money, b: Money): void {
  if (a.currency !== b.currency) {
    throw new Error(`Currency mismatch: ${a.currency} vs ${b.currency}`);
  }
}

export function add(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor + b.amountMinor, currency: a.currency };
}

export function subtract(a: Money, b: Money): Money {
  assertSameCurrency(a, b);
  return { amountMinor: a.amountMinor - b.amountMinor, currency: a.currency };
}

export function sum(items: Money[], currency: CurrencyCode): Money {
  return items.reduce((acc, m) => add(acc, m), money(0n, currency));
}

export function isZero(m: Money): boolean {
  return m.amountMinor === 0n;
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertSameCurrency(a, b);
  return a.amountMinor < b.amountMinor ? -1 : a.amountMinor > b.amountMinor ? 1 : 0;
}

/** Divide with round-half-to-even (banker's rounding). */
export function divRoundHalfEven(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("Division by zero");
  if (denominator < 0n) {
    numerator = -numerator;
    denominator = -denominator;
  }
  let q = numerator / denominator;
  let r = numerator % denominator;
  if (r < 0n) {
    q -= 1n;
    r += denominator;
  }
  const twice = r * 2n;
  if (twice > denominator || (twice === denominator && q % 2n !== 0n)) q += 1n;
  return q;
}

/** A decimal as an integer numerator over a power of ten. */
export interface Decimal {
  readonly units: bigint;
  readonly scale: number;
}

export function parseDecimal(value: string): Decimal {
  const m = /^(-)?(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) throw new Error(`Invalid decimal: ${value}`);
  const [, sign, whole, frac = ""] = m;
  const units = BigInt(whole + frac);
  return { units: sign ? -units : units, scale: frac.length };
}

/** Multiply Money by a decimal factor such as "1.075", rounding half-to-even. */
export function multiply(m: Money, factor: string): Money {
  const d = parseDecimal(factor);
  return {
    amountMinor: divRoundHalfEven(m.amountMinor * d.units, 10n ** BigInt(d.scale)),
    currency: m.currency,
  };
}

/**
 * Split Money across integer weights without losing or inventing a minor unit.
 * Remainders go to the earliest shares.
 */
export function allocate(m: Money, weights: number[]): Money[] {
  if (weights.length === 0) throw new Error("allocate needs at least one weight");
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new Error("allocate weights must be non-negative integers");
  }
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) throw new Error("allocate weights must not all be zero");
  const t = BigInt(total);
  const shares = weights.map((w) => (m.amountMinor * BigInt(w)) / t);
  let remainder = m.amountMinor - shares.reduce((a, b) => a + b, 0n);
  const step = remainder < 0n ? -1n : 1n;
  for (let i = 0; remainder !== 0n; i = (i + 1) % shares.length) {
    if (weights[i] === 0) continue;
    shares[i] += step;
    remainder -= step;
  }
  return shares.map((amountMinor) => ({ amountMinor, currency: m.currency }));
}

/** Locale-aware display, e.g. formatMoney(m, "fr-FR") -> "1 234,56 €". */
export function formatMoney(m: Money, locale: string): string {
  const digits = minorUnits(m.currency);
  // Intl accepts decimal strings exactly, avoiding float precision loss.
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency: m.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(toDecimalString(m) as unknown as number);
}
