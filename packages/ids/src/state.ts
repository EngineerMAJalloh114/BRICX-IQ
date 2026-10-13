// The generator's counter state (RFC 9562 §6.2, method 1, "fixed bit-length
// dedicated counter"; ADR 0041). Pure, so overflow is testable without 2^41
// calls.
//
// - A later clock value starts a new millisecond with a fresh random seed.
// - The same or an earlier clock value keeps the last millisecond and
//   increments the counter, so ids stay strictly increasing when the clock
//   stalls or goes backwards.
// - When the counter passes its maximum, the timestamp moves forward 1 ms
//   and the counter is reseeded (RFC 9562 §6.2 allows this).
import { IdError } from "./errors.js";

export interface GeneratorState {
  readonly ms: number;
  readonly counter: number;
}

/** Largest 48-bit unix_ts_ms value. */
export const MAX_TIMESTAMP = 2 ** 48 - 1;

/** Largest 42-bit counter value (rand_a + the top 30 bits of rand_b). */
export const MAX_COUNTER = 2 ** 42 - 1;

export function nextState(
  prev: GeneratorState | undefined,
  now: number,
  seed: number,
  maxCounter: number,
): GeneratorState {
  if (prev === undefined || now > prev.ms) return { ms: now, counter: seed };
  if (prev.counter < maxCounter) {
    return { ms: prev.ms, counter: prev.counter + 1 };
  }
  if (prev.ms >= MAX_TIMESTAMP) throw new IdError("timestamp_overflow");
  return { ms: prev.ms + 1, counter: seed };
}
