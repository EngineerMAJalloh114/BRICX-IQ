import { currencyMinorDigits } from './currencies';

/**
 * Money is always stored as an integer count of the currency's minor unit
 * (cents, fils, ...) next to its ISO 4217 code, so amounts never go through
 * floating point and every value carries its currency.
 */
export interface Money {
  amountMinor: number;
  currency: string;
}

export function isCurrencyCode(code: string): boolean {
  return Object.hasOwn(currencyMinorDigits, code);
}

/** Number of decimal places in the currency's minor unit, e.g. USD 2, JPY 0, KWD 3. */
export function minorDigits(currency: string): number {
  const digits = currencyMinorDigits[currency];
  if (digits === undefined) throw new Error(`Unknown currency "${currency}"`);
  return digits;
}

/** Parses a decimal string such as "1250.5" into minor units without float rounding. */
export function toMinor(amount: string, currency: string): number {
  const digits = minorDigits(currency);
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (!match) throw new Error(`Invalid amount "${amount}"`);
  const [, sign, whole, fraction = ''] = match;
  if (fraction.length > digits) {
    throw new Error(`${currency} allows at most ${digits} decimal places`);
  }
  const minor = Number(whole + fraction.padEnd(digits, '0'));
  if (!Number.isSafeInteger(minor)) throw new Error(`Amount "${amount}" is too large`);
  return sign ? -minor : minor;
}

export function formatMoney(money: Money, locale?: string): string {
  const digits = minorDigits(money.currency);
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: money.currency,
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(money.amountMinor / 10 ** digits);
}
