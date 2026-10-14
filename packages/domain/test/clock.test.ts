// Clock (ruling 5): an injected { now(): number } with the same contract as
// @bricx/ids's IdClock (an integer number of milliseconds from 0 to
// 2^48 - 1). fixedClock and manualClock reject anything else with
// ClockError; advance() and set() return ClockError and never wrap.
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";
import { describe, expect, it } from "vitest";
import { MAX_CLOCK_MS, fixedClock, manualClock } from "../src/clock.ts";
import type { Clock } from "../src/clock.ts";
import { ClockError } from "../src/errors.ts";

const BAD: readonly [string, unknown][] = [
  ["a fraction", 1.5],
  ["a negative value", -1],
  ["above 2^48 - 1", MAX_CLOCK_MS + 1],
  ["NaN", Number.NaN],
  ["Infinity", Number.POSITIVE_INFINITY],
  ["a string", "1"],
  ["a bigint", 1n],
  ["undefined", undefined],
];

function thrownCode(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ClockError);
    return (error as ClockError).code;
  }
  throw new Error("expected a ClockError");
}

describe("MAX_CLOCK_MS", () => {
  it("is 2^48 - 1, the largest UUIDv7 timestamp", () => {
    expect(MAX_CLOCK_MS).toBe(2 ** 48 - 1);
  });
});

describe("fixedClock", () => {
  it("always returns its instant", () => {
    const clock = fixedClock(1_760_000_000_000);
    expect(clock.now()).toBe(1_760_000_000_000);
    expect(clock.now()).toBe(1_760_000_000_000);
    expect(Object.isFrozen(clock)).toBe(true);
  });

  it("accepts 0 and 2^48 - 1", () => {
    expect(fixedClock(0).now()).toBe(0);
    expect(fixedClock(MAX_CLOCK_MS).now()).toBe(MAX_CLOCK_MS);
  });

  it.each(BAD)("rejects %s with ClockError", (_name, value) => {
    expect(thrownCode(() => fixedClock(value as number))).toBe("invalid_clock");
  });
});

describe("manualClock", () => {
  it("starts at its instant, advances and is set", () => {
    const clock = manualClock(1000);
    expect(clock.now()).toBe(1000);
    expect(clock.advance(500)).toEqual({ ok: true, value: 1500 });
    expect(clock.now()).toBe(1500);
    expect(clock.set(10)).toEqual({ ok: true, value: 10 });
    expect(clock.now()).toBe(10);
    expect(clock.advance(0)).toEqual({ ok: true, value: 10 });
  });

  it.each(BAD)("the constructor rejects %s with ClockError", (_name, value) => {
    expect(thrownCode(() => manualClock(value as number))).toBe(
      "invalid_clock",
    );
  });

  it.each(BAD)(
    "advance(%s) returns ClockError and leaves the time unchanged",
    (_name, value) => {
      const clock = manualClock(1000);
      const result = clock.advance(value as number);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toBeInstanceOf(ClockError);
      expect(!result.ok && result.error.code).toBe("invalid_clock");
      expect(clock.now()).toBe(1000);
    },
  );

  it.each(BAD)(
    "set(%s) returns ClockError and leaves the time unchanged",
    (_name, value) => {
      const clock = manualClock(1000);
      const result = clock.set(value as number);
      expect(!result.ok && result.error.code).toBe("invalid_clock");
      expect(clock.now()).toBe(1000);
    },
  );

  it("an advance past 2^48 - 1 returns ClockError and never wraps", () => {
    const clock = manualClock(MAX_CLOCK_MS - 10);
    expect(clock.advance(10)).toEqual({ ok: true, value: MAX_CLOCK_MS });
    const result = clock.advance(1);
    expect(!result.ok && result.error.code).toBe("invalid_clock");
    expect(clock.now()).toBe(MAX_CLOCK_MS);
    const big = manualClock(1).advance(MAX_CLOCK_MS);
    expect(!big.ok && big.error.code).toBe("invalid_clock");
  });
});

describe("a domain Clock is an @bricx/ids clock", () => {
  it("feeds createUuidV7Generator directly", () => {
    const clock: Clock = fixedClock(1_760_000_000_000);
    const generator = createUuidV7Generator({
      clock,
      fillRandom: (bytes) => bytes.fill(1),
    });
    const id = generator.next();
    expect(Number.parseInt(id.replace(/-/g, "").slice(0, 12), 16)).toBe(
      1_760_000_000_000,
    );
  });
});
