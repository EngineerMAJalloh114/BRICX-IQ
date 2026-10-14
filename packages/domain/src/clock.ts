// Clock: time comes in as a parameter (CLAUDE.md rule 7). The contract is
// @bricx/ids's IdClock: now() is an integer number of milliseconds since the
// Unix epoch from 0 to 2^48 - 1 (the UUIDv7 timestamp range). This package
// never reads the system clock; apps build their Clock from it, tests and
// seeds use fixedClock and manualClock.
import { ClockError } from "./errors.ts";
import { err, ok } from "./result.ts";
import type { Result } from "./result.ts";

export interface Clock {
  now(): number;
}

/** A clock a test or seed moves by hand; advance and set never wrap. */
export interface ManualClock extends Clock {
  /** Moves forward by `ms`; ClockError past 2^48 - 1, the time unchanged. */
  advance(ms: number): Result<number, ClockError>;
  /** Jumps to `ms`; ClockError for an invalid instant, the time unchanged. */
  set(ms: number): Result<number, ClockError>;
}

/** The largest clock instant: 2^48 - 1 ms (RFC 9562 UUIDv7 timestamp). */
export const MAX_CLOCK_MS = 2 ** 48 - 1;

/** True for an integer from 0 to MAX_CLOCK_MS. */
export const isClockInstant = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= MAX_CLOCK_MS;

function instant(value: unknown): number {
  if (!isClockInstant(value)) throw new ClockError("invalid_clock");
  return value;
}

/** A clock stopped at `ms`. */
export function fixedClock(ms: number): Clock {
  const at = instant(ms);
  return Object.freeze({ now: () => at });
}

/** A clock starting at `ms`, moved by advance() and set(). */
export function manualClock(ms: number): ManualClock {
  let at = instant(ms);
  return Object.freeze({
    now: () => at,
    advance(delta: number): Result<number, ClockError> {
      if (!isClockInstant(delta) || !isClockInstant(at + delta))
        return err(new ClockError("invalid_clock"));
      at += delta;
      return ok(at);
    },
    set(value: number): Result<number, ClockError> {
      if (!isClockInstant(value)) return err(new ClockError("invalid_clock"));
      at = value;
      return ok(at);
    },
  });
}
