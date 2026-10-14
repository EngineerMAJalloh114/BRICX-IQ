// Independent oracles (P3 rule: non-trivial logic gets a second,
// differently built implementation).
//
// - naiveStep: a machine step that scans the plain transition list, with
//   none of the Maps, bounds or checks of src/machine.ts.
// - definitionalRound: rounding of n/d by the definition of each mode,
//   comparing the distances to the two neighbouring integers with
//   cross-multiplication, instead of src/decimal.ts's truncated quotient and
//   remainder.
// - reachable: breadth-first reachability over the plain list.

export interface PlainTransition {
  readonly from: string;
  readonly event: string;
  readonly to: string;
  readonly guard?: string;
}

export type NaiveOutcome =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly code: string };

export function naiveStep(
  transitions: readonly PlainTransition[],
  states: readonly string[],
  events: readonly string[],
  state: string,
  event: string,
  guardResult: (guard: string) => boolean,
): NaiveOutcome {
  if (!states.includes(state)) return { ok: false, code: "unknown_state" };
  if (!events.includes(event)) return { ok: false, code: "unknown_event" };
  const found = transitions.filter(
    (t) => t.from === state && t.event === event,
  );
  const t = found[0];
  if (t === undefined) return { ok: false, code: "illegal_transition" };
  if (t.guard !== undefined && !guardResult(t.guard))
    return { ok: false, code: "guard_rejected" };
  return { ok: true, value: t.to };
}

export function reachable(
  initial: string,
  transitions: readonly PlainTransition[],
): Set<string> {
  const seen = new Set([initial]);
  let frontier = [initial];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const t of transitions) {
      if (frontier.includes(t.from) && !seen.has(t.to)) {
        seen.add(t.to);
        next.push(t.to);
      }
    }
    frontier = next;
  }
  return seen;
}

export type Mode =
  "HALF_EVEN" | "HALF_UP" | "HALF_DOWN" | "UP" | "DOWN" | "CEILING" | "FLOOR";

/** floor(n / d) for d > 0, by stepping from the truncated quotient. */
function floorDiv(n: bigint, d: bigint): bigint {
  let q = n / d;
  while (q * d > n) q -= 1n;
  while ((q + 1n) * d <= n) q += 1n;
  return q;
}

/** n / d rounded to an integer by the definition of `mode` (d > 0). */
export function definitionalRound(n: bigint, d: bigint, mode: Mode): bigint {
  const lo = floorDiv(n, d);
  if (lo * d === n) return lo;
  const hi = lo + 1n;
  // Distances to the neighbours, scaled by d: n/d - lo and hi - n/d.
  const toLo = n - lo * d;
  const toHi = hi * d - n;
  const towardZero = n > 0n ? lo : hi;
  const awayFromZero = n > 0n ? hi : lo;
  switch (mode) {
    case "FLOOR":
      return lo;
    case "CEILING":
      return hi;
    case "DOWN":
      return towardZero;
    case "UP":
      return awayFromZero;
    default: {
      if (toLo < toHi) return lo;
      if (toHi < toLo) return hi;
      if (mode === "HALF_UP") return awayFromZero;
      if (mode === "HALF_DOWN") return towardZero;
      return lo % 2n === 0n ? lo : hi;
    }
  }
}
