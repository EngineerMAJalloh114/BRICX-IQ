import { describe, expect, it } from 'vitest';
import { convert, findRate, validateRate, type ExchangeRate } from '../src';
import { parseMoney, toDecimalString } from '../src';

const rates: ExchangeRate[] = [
  { base: 'USD', quote: 'SLE', rate: '22.50', effectiveDate: '2026-01-01' },
  { base: 'USD', quote: 'SLE', rate: '23.10', effectiveDate: '2026-06-01' },
  { base: 'EUR', quote: 'USD', rate: '1.0850', effectiveDate: '2026-01-01' },
  { base: 'USD', quote: 'JPY', rate: '149.37', effectiveDate: '2026-01-01' },
  { base: 'USD', quote: 'KWD', rate: '0.3075', effectiveDate: '2026-01-01' },
];

describe('exchange rates', () => {
  it('uses the rate in force on the transaction date', () => {
    expect(findRate(rates, 'USD', 'SLE', '2026-03-15')?.rate.rate).toBe('22.50');
    expect(findRate(rates, 'USD', 'SLE', '2026-06-01')?.rate.rate).toBe('23.10');
    expect(findRate(rates, 'USD', 'SLE', '2025-12-31')).toBeUndefined();
  });

  it('converts with half-even rounding to the target minor unit', () => {
    const r = convert(parseMoney('100.00', 'USD'), 'SLE', '2026-07-01', rates);
    expect(toDecimalString(r.money)).toBe('2310.00');
    expect(r.rate.effectiveDate).toBe('2026-06-01');

    expect(
      toDecimalString(convert(parseMoney('10.00', 'USD'), 'JPY', '2026-02-01', rates).money),
    ).toBe('1494');
    expect(
      toDecimalString(convert(parseMoney('10.00', 'USD'), 'KWD', '2026-02-01', rates).money),
    ).toBe('3.075');
  });

  it('uses the inverse pair when only the opposite rate exists', () => {
    const r = convert(parseMoney('108.50', 'USD'), 'EUR', '2026-02-01', rates);
    expect(toDecimalString(r.money)).toBe('100.00');
  });

  it('is a no-op for the same currency', () => {
    const m = parseMoney('5.00', 'USD');
    expect(convert(m, 'USD', '2026-01-01', []).money).toEqual(m);
  });

  it('fails loudly when no rate exists', () => {
    expect(() => convert(parseMoney('1.00', 'GBP'), 'SLE', '2026-01-01', rates)).toThrow(
      /No GBP->SLE/,
    );
  });

  it('validates rates', () => {
    expect(() =>
      validateRate({ base: 'USD', quote: 'USD', rate: '1', effectiveDate: '2026-01-01' }),
    ).toThrow();
    expect(() =>
      validateRate({ base: 'USD', quote: 'EUR', rate: '0', effectiveDate: '2026-01-01' }),
    ).toThrow();
    expect(() =>
      validateRate({ base: 'USD', quote: 'EUR', rate: '0.9', effectiveDate: '2026-13-01' }),
    ).toThrow();
  });
});
