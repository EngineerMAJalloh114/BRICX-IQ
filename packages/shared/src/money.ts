import { currencyMinorDigits } from './currencies';

/**
 * Money is always an integer count of the currency's minor unit (cents,
 * fils, ...) next to its ISO 4217 code, so amounts never go through floating
 * point and every value carries its currency. Arithmetic uses bigint so large
 * totals stay exact; the synced tables store the same value as an integer.
 */
/** An ISO 4217 code such as "USD"; see isCurrencyCode. */
export type CurrencyCode = string;

export interface Money {
  readonly amountMinor: bigint;
  readonly currency: string;
}

export function isCurrencyCode(code: string): boolean {
  return Object.hasOwn(currencyMinorDigits, code);
}

export function assertCurrency(code: string): string {
  if (!isCurrencyCode(code)) throw new Error(`Unknown currency "${code}"`);
  return code;
}

/** Number of decimal places in the currency's minor unit, e.g. USD 2, JPY 0, KWD 3. */
export function minorDigits(currency: string): number {
  const digits = currencyMinorDigits[currency];
  if (digits === undefined) throw new Error(`Unknown currency "${currency}"`);
  return digits;
}

const DECIMAL_RE = /^(-)?(\d+)(?:\.(\d+))?$/;

function parseMinor(amount: string, currency: string): bigint {
  const digits = minorDigits(currency);
  const match = DECIMAL_RE.exec(amount.trim());
  if (!match) throw new Error(`Invalid amount "${amount}"`);
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > digits) {
    throw new Error(`${currency} allows at most ${digits} decimal places`);
  }
  const minor = BigInt(whole + fraction.padEnd(digits, '0'));
  return sign ? -minor : minor;
}

/**
 * Parses a decimal string such as "1250.5" into minor units as a number, for
 * synced integer columns. Throws if the value is beyond Number's safe range.
 */
export function toMinor(amount: string, currency: string): number {
  const minor = parseMinor(amount, currency);
  if (minor > BigInt(Number.MAX_SAFE_INTEGER) || minor < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error(`Amount "${amount}" is too large`);
  }
  return Number(minor);
}

export function money(amountMinor: bigint | number, currency: string): Money {
  if (typeof amountMinor === 'number' && !Number.isSafeInteger(amountMinor)) {
    throw new Error(`Money amount must be an integer, got ${amountMinor}`);
  }
  return { amountMinor: BigInt(amountMinor), currency: assertCurrency(currency) };
}

/** Parse a decimal string such as "1234.56" or "-0.5" into Money. */
export function parseMoney(value: string, currency: string): Money {
  return { amountMinor: parseMinor(value, currency), currency };
}

/** Render Money as a plain decimal string, e.g. "1234.56". */
export function toDecimalString(m: Money): string {
  const digits = minorDigits(m.currency);
  const neg = m.amountMinor < 0n;
  const abs = (neg ? -m.amountMinor : m.amountMinor).toString().padStart(digits + 1, '0');
  const whole = abs.slice(0, abs.length - digits);
  const frac = abs.slice(abs.length - digits);
  return (neg ? '-' : '') + whole + (digits > 0 ? '.' + frac : '');
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

export function sum(items: Money[], currency: string): Money {
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
  if (denominator === 0n) throw new Error('Division by zero');
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
  const match = DECIMAL_RE.exec(value.trim());
  if (!match) throw new Error(`Invalid decimal: ${value}`);
  const [, sign, whole, frac = ''] = match;
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
  if (weights.length === 0) throw new Error('allocate needs at least one weight');
  if (weights.some((w) => !Number.isSafeInteger(w) || w < 0)) {
    throw new Error('allocate weights must be non-negative integers');
  }
  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) throw new Error('allocate weights must not all be zero');
  const t = BigInt(total);
  const shares = weights.map((w) => (m.amountMinor * BigInt(w)) / t);
  let remainder = m.amountMinor - shares.reduce((a, b) => a + b, 0n);
  const step = remainder < 0n ? -1n : 1n;
  for (let i = 0; remainder !== 0n; i = (i + 1) % shares.length) {
    if (weights[i] === 0) continue;
    shares[i]! += step;
    remainder -= step;
  }
  return shares.map((amountMinor) => ({ amountMinor, currency: m.currency }));
}

/** Locale-aware display, e.g. formatMoney(m, "fr-FR") -> "1 234,56 €". */
export function formatMoney(m: Money, locale?: string): string {
  const digits = minorDigits(m.currency);
  // Intl formats decimal strings exactly, so large amounts keep every digit.
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: m.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(toDecimalString(m) as unknown as number);
}
