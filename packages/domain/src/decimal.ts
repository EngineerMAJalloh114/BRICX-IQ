// Internal (not in the exports map): exact integer division with the
// rounding modes of @bricx/money, on bigint. A quantity conversion is one
// rational multiplication followed by one roundDiv; nothing else rounds.
import { Rounding, isRounding } from "@bricx/money/rounding";
import { QuantityError } from "./errors.ts";

/** Rounds n / d (d > 0) to an integer by `mode`; exact when d divides n. */
export function roundDiv(n: bigint, d: bigint, mode: Rounding): bigint {
  if (!isRounding(mode)) throw new QuantityError("invalid_rounding");
  const q = n / d; // truncated towards zero
  const r = n % d; // same sign as n
  if (r === 0n) return q;
  const away = n < 0n ? q - 1n : q + 1n;
  switch (mode) {
    case Rounding.DOWN:
      return q;
    case Rounding.UP:
      return away;
    case Rounding.FLOOR:
      return n < 0n ? away : q;
    case Rounding.CEILING:
      return n > 0n ? away : q;
    default: {
      const twice = (r < 0n ? -r : r) * 2n;
      if (twice > d) return away;
      if (twice < d) return q;
      if (mode === Rounding.HALF_UP) return away;
      if (mode === Rounding.HALF_DOWN) return q;
      return q % 2n === 0n ? q : away;
    }
  }
}

/** 10^k as a bigint for an integer k >= 0. */
export const pow10 = (k: number): bigint => 10n ** BigInt(k);
