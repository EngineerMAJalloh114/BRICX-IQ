import { describe, expect, it } from 'vitest';

import { formatMoney, isCurrencyCode, minorDigits, toMinor } from '../src';

describe('money', () => {
  it('knows each currency minor unit', () => {
    expect(minorDigits('USD')).toBe(2);
    expect(minorDigits('JPY')).toBe(0);
    expect(minorDigits('KWD')).toBe(3);
  });

  it('parses decimal strings into minor units without float error', () => {
    expect(toMinor('0.29', 'USD')).toBe(29);
    expect(toMinor('1250.5', 'EUR')).toBe(125050);
    expect(toMinor('1000', 'JPY')).toBe(1000);
    expect(toMinor('1.234', 'KWD')).toBe(1234);
    expect(toMinor('-3.10', 'GBP')).toBe(-310);
  });

  it('rejects too many decimals and malformed input', () => {
    expect(() => toMinor('1.5', 'JPY')).toThrow();
    expect(() => toMinor('1.005', 'USD')).toThrow();
    expect(() => toMinor('12abc', 'USD')).toThrow();
  });

  it('validates ISO 4217 codes', () => {
    expect(isCurrencyCode('SLE')).toBe(true);
    expect(isCurrencyCode('usd')).toBe(false);
    expect(isCurrencyCode('US')).toBe(false);
    expect(isCurrencyCode('ZZZ')).toBe(false);
    expect(isCurrencyCode('XAU')).toBe(false);
  });

  it('formats for a locale', () => {
    expect(formatMoney({ amountMinor: 123456, currency: 'USD' }, 'en-US')).toBe('$1,234.56');
    expect(formatMoney({ amountMinor: 5000, currency: 'JPY' }, 'en-US')).toBe('¥5,000');
  });
});
