// Exact allocation checks shared by the property tests and the sabotage
// tests. Ratios are scaled to integers so every comparison is bigint.
import Decimal from "decimal.js";
import { expect } from "vitest";
import type { Money } from "../src/money.js";
import { abs } from "./helpers.js";

type Ratio = bigint | string | Decimal;

/** Ratios as integers with a common scale: w_i = r_i · 10^dp. */
export function scaled(ratios: readonly Ratio[]): bigint[] {
  const decimals = ratios.map(
    (r) => new Decimal(typeof r === "bigint" ? r.toString() : r),
  );
  const dp = Math.max(0, ...decimals.map((d) => d.decimalPlaces()));
  const factor = new Decimal(10).pow(dp);
  return decimals.map((d) => BigInt(d.mul(factor).toFixed(0)));
}

/**
 * Sum is exact, signs follow the total, and each part is within one minor
 * unit of its exact share total·w_i/W: |part_i·W − total·w_i| < W.
 */
export function checkAllocation(
  m: Money,
  ratios: readonly Ratio[],
  parts: readonly Money[],
): void {
  expect(parts.length).toBe(ratios.length);
  const sum = parts.reduce((acc, p) => acc + p.amount, 0n);
  expect(sum).toBe(m.amount);
  const w = scaled(ratios);
  const total = w.reduce((a, b) => a + b, 0n);
  parts.forEach((p, i) => {
    expect(p.currency).toBe(m.currency);
    const exact = m.amount * (w[i] ?? 0n);
    expect(abs(p.amount * total - exact) < total).toBe(true);
    if (m.amount > 0n) expect(p.amount >= 0n).toBe(true);
    if (m.amount < 0n) expect(p.amount <= 0n).toBe(true);
    if ((w[i] ?? 0n) === 0n) expect(p.amount).toBe(0n);
  });
}
