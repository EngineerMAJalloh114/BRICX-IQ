// Shared test helpers: clocks, a seeded random source, field decoding, and
// the property checks that both the real tests and the sabotage tests run.
import { format, inspect } from "node:util";
import { expect } from "vitest";
import type { FillRandom, IdClock } from "../src/uuid-v7.js";

/** A clock that always returns `ms`. */
export const frozenClock = (ms: number): IdClock => ({ now: () => ms });

/** A clock that returns the values in order, then repeats the last one. */
export function sequenceClock(values: readonly number[]): IdClock {
  let i = 0;
  return {
    now: () => {
      const value = values[Math.min(i, values.length - 1)] ?? 0;
      i += 1;
      return value;
    },
  };
}

/**
 * A clock that advances one millisecond every `perMs` calls and, when
 * `backEvery` is set, jumps back `backBy` ms every `backEvery` calls.
 */
export function steppingClock(
  start: number,
  perMs: number,
  backEvery = 0,
  backBy = 0,
): IdClock {
  let calls = 0;
  let ms = start;
  return {
    now: () => {
      calls += 1;
      if (calls % perMs === 0) ms += 1;
      if (backEvery > 0 && calls % backEvery === 0) ms -= backBy;
      return ms;
    },
  };
}

/** Deterministic xorshift32 byte source; never Math.random. */
export function seededRandom(seed: number): FillRandom {
  let x = seed >>> 0 || 1;
  return (bytes) => {
    for (let i = 0; i < bytes.length; i += 1) {
      x ^= x << 13;
      x >>>= 0;
      x ^= x >>> 17;
      x ^= x << 5;
      x >>>= 0;
      bytes[i] = x & 0xff;
    }
  };
}

/** Fills every byte with `value`. */
export const constantRandom =
  (value: number): FillRandom =>
  (bytes) => {
    bytes.fill(value);
  };

/** The 48-bit unix_ts_ms field (first 12 hex digits) as a bigint. */
export const timestampField = (id: string): bigint =>
  BigInt(`0x${id.slice(0, 8)}${id.slice(9, 13)}`);

/** The 128 bits of an id as a bigint, for bit-level comparisons. */
export const bitsOf = (id: string): bigint =>
  BigInt(`0x${id.replaceAll("-", "")}`);

export const UUID_V7_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Checks `ids` are strictly increasing as strings (hence unique). */
export function expectStrictlyIncreasing(ids: readonly string[]): void {
  let violations = 0;
  for (let i = 1; i < ids.length; i += 1) {
    const prev = ids[i - 1] ?? "";
    const cur = ids[i] ?? "";
    if (!(prev < cur)) violations += 1;
  }
  expect(violations, "ids not strictly increasing").toBe(0);
}

/** Checks every id is lowercase RFC 9562 version 7, variant 10. */
export function expectVersionAndVariant(ids: readonly string[]): void {
  const bad = ids.filter((id) => !UUID_V7_SHAPE.test(id));
  expect(bad.length, "ids with a wrong shape, version or variant").toBe(0);
}

/** Generates `count` ids with `next`. */
export function generate(next: () => string, count: number): string[] {
  const ids = new Array<string>(count);
  for (let i = 0; i < count; i += 1) ids[i] = next();
  return ids;
}

/** Asserts no rendering of `error` contains any of `sentinels`. */
export function expectNoSentinel(
  error: unknown,
  sentinels: readonly string[],
): void {
  const own =
    typeof error === "object" && error !== null
      ? Object.getOwnPropertyNames(error)
      : [];
  const renderings = [
    String(error),
    JSON.stringify(error),
    JSON.stringify(error, own),
    inspect(error),
    inspect(error, { showHidden: true, depth: 5 }),
    inspect(error, { customInspect: false, showHidden: true }),
    format("%s %o %O %j", error, error, error, error),
  ];
  for (const rendering of renderings) {
    for (const sentinel of sentinels) {
      expect(rendering.toLowerCase()).not.toContain(sentinel.toLowerCase());
    }
  }
}
