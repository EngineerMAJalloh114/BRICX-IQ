// allocate (P3-02 step 2 and rulings): split Money by ratios with the
// largest-remainder method so the parts sum exactly to the original.
//
// Ratios are scaled to integers w_i (common power of ten), W = sum(w_i).
// For |amount| = A: floor_i = A·w_i div W, rem_i = A·w_i mod W, all bigint,
// so nothing is approximated. The A − sum(floor_i) leftover units (fewer
// than the number of parts) go one each to the largest remainders; equal
// remainders go to the lowest index. A negative amount is split on its
// absolute value and every part negated, so allocation is symmetric.
import Decimal from "decimal.js";
import { D, toDecimal } from "./decimal.js";
import { MoneyError } from "./errors.js";
import { fromMinor, isMoney } from "./money.js";
import type { DecimalLike, Money } from "./money.js";

/** A bigint, a Decimal or a plain decimal string; never a JS number. */
export type Ratio = bigint | DecimalLike;

const MAX_RATIO_DIGITS = 64;

function toRatio(ratio: unknown): Decimal {
  const d =
    typeof ratio === "bigint"
      ? new D(ratio.toString())
      : toDecimal(ratio, "invalid_ratio", true);
  if (d.isNegative() && !d.isZero()) throw new MoneyError("negative_ratio");
  if (d.toFixed().replace(/^-|\./g, "").length > MAX_RATIO_DIGITS) {
    throw new MoneyError("invalid_ratio");
  }
  return d;
}

/**
 * Parts in ratio order, in the source currency. Throws no_ratios,
 * invalid_ratio, negative_ratio or ratios_sum_zero.
 */
export function allocate(
  money: Money,
  ratios: readonly Ratio[],
): readonly Money[] {
  if (!isMoney(money)) throw new MoneyError("not_money");
  if (ratios.length === 0) throw new MoneyError("no_ratios");
  const decimals = ratios.map(toRatio);
  const places = Math.max(...decimals.map((d) => d.decimalPlaces()));
  const scale = new D(10).pow(places);
  const weights = decimals.map((d) => BigInt(d.mul(scale).toFixed(0)));
  const total = weights.reduce((a, b) => a + b, 0n);
  if (total === 0n) throw new MoneyError("ratios_sum_zero");

  const negative = money.amount < 0n;
  const amount = negative ? -money.amount : money.amount;
  const floors = weights.map((w) => (amount * w) / total);
  const remainders = weights.map((w) => (amount * w) % total);
  let leftover = amount - floors.reduce((a, b) => a + b, 0n);

  // Indices by remainder, largest first; Array.prototype.sort is stable, so
  // equal remainders keep index order (lowest index first).
  const order = remainders
    .map((r, i) => ({ r, i }))
    .sort((a, b) => (a.r === b.r ? 0 : a.r > b.r ? -1 : 1));
  const parts = [...floors];
  for (const { i } of order) {
    if (leftover === 0n) break;
    parts[i] = (parts[i] ?? 0n) + 1n;
    leftover -= 1n;
  }
  return Object.freeze(
    parts.map((p) => fromMinor(negative ? -p : p, money.currency)),
  );
}
