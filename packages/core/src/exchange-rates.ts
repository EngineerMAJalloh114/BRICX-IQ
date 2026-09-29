import {
  assertCurrency,
  divRoundHalfEven,
  minorUnits,
  parseDecimal,
  type CurrencyCode,
  type Money,
} from "./money";

/**
 * One unit of `base` is worth `rate` units of `quote` from `effectiveDate`
 * (inclusive) until a newer rate for the same pair takes over.
 */
export interface ExchangeRate {
  readonly base: CurrencyCode;
  readonly quote: CurrencyCode;
  /** Decimal string, e.g. "0.9213". Never a float. */
  readonly rate: string;
  /** ISO date, YYYY-MM-DD. */
  readonly effectiveDate: string;
  readonly source?: string;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertIsoDate(date: string): string {
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date + "T00:00:00Z"))) {
    throw new Error(`Invalid ISO date: ${date}`);
  }
  return date;
}

export function validateRate(r: ExchangeRate): ExchangeRate {
  assertCurrency(r.base);
  assertCurrency(r.quote);
  assertIsoDate(r.effectiveDate);
  if (r.base === r.quote) throw new Error("Exchange rate base and quote must differ");
  if (parseDecimal(r.rate).units <= 0n) throw new Error(`Exchange rate must be positive: ${r.rate}`);
  return r;
}

/**
 * The rate in force on `date`: the latest one whose effectiveDate is on or
 * before `date`. Accepts the inverse pair if no direct rate exists.
 */
export function findRate(
  rates: readonly ExchangeRate[],
  from: CurrencyCode,
  to: CurrencyCode,
  date: string,
): { rate: ExchangeRate; inverted: boolean } | undefined {
  assertIsoDate(date);
  let best: { rate: ExchangeRate; inverted: boolean } | undefined;
  for (const r of rates) {
    if (r.effectiveDate > date) continue;
    const direct = r.base === from && r.quote === to;
    const inverse = r.base === to && r.quote === from;
    if (!direct && !inverse) continue;
    const better =
      !best ||
      r.effectiveDate > best.rate.effectiveDate ||
      // Prefer a direct quote over an inverse one on the same day.
      (r.effectiveDate === best.rate.effectiveDate && direct && best.inverted);
    if (better) best = { rate: r, inverted: inverse };
  }
  return best;
}

/**
 * Convert Money into another currency at the rate in force on `date`,
 * rounding half-to-even to the target currency's minor unit.
 */
export function convert(
  m: Money,
  to: CurrencyCode,
  date: string,
  rates: readonly ExchangeRate[],
): { money: Money; rate: ExchangeRate } {
  assertCurrency(to);
  if (m.currency === to) {
    return {
      money: m,
      rate: { base: to, quote: to, rate: "1", effectiveDate: assertIsoDate(date) },
    };
  }
  const found = findRate(rates, m.currency, to, date);
  if (!found) throw new Error(`No ${m.currency}->${to} exchange rate on or before ${date}`);

  const d = parseDecimal(found.rate.rate);
  const scaleShift = BigInt(minorUnits(to) - minorUnits(m.currency));
  // amount_to = amount_from * rate * 10^(to_digits - from_digits)
  let num = m.amountMinor;
  let den = 1n;
  if (found.inverted) {
    num *= 10n ** BigInt(d.scale);
    den *= d.units;
  } else {
    num *= d.units;
    den *= 10n ** BigInt(d.scale);
  }
  if (scaleShift >= 0n) num *= 10n ** scaleShift;
  else den *= 10n ** -scaleShift;

  return {
    money: { amountMinor: divRoundHalfEven(num, den), currency: to },
    rate: found.rate,
  };
}
