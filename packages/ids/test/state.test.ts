// The counter state machine on its own, so counter overflow can be tested
// without 2^41 calls (P3-01, ADR 0041: 42-bit counter).
import { describe, expect, it } from "vitest";
import { IdError } from "../src/errors.js";
import { MAX_COUNTER, MAX_TIMESTAMP, nextState } from "../src/state.js";

describe("nextState", () => {
  it("the counter is 42 bits and the timestamp 48 bits", () => {
    expect(MAX_COUNTER).toBe(2 ** 42 - 1);
    expect(MAX_TIMESTAMP).toBe(2 ** 48 - 1);
  });

  it("first id: the clock value and the seed", () => {
    expect(nextState(undefined, 10, 7, MAX_COUNTER)).toEqual({
      ms: 10,
      counter: 7,
    });
  });

  it("a later millisecond reseeds", () => {
    expect(nextState({ ms: 10, counter: 99 }, 11, 7, MAX_COUNTER)).toEqual({
      ms: 11,
      counter: 7,
    });
  });

  it("the same millisecond increments", () => {
    expect(nextState({ ms: 10, counter: 99 }, 10, 7, MAX_COUNTER)).toEqual({
      ms: 10,
      counter: 100,
    });
  });

  it("an earlier clock value keeps the last millisecond and increments", () => {
    expect(nextState({ ms: 10, counter: 99 }, 3, 7, MAX_COUNTER)).toEqual({
      ms: 10,
      counter: 100,
    });
  });

  it("counter overflow moves the timestamp forward 1 ms and reseeds", () => {
    expect(nextState({ ms: 10, counter: 15 }, 10, 4, 15)).toEqual({
      ms: 11,
      counter: 4,
    });
    expect(
      nextState({ ms: 10, counter: MAX_COUNTER }, 9, 4, MAX_COUNTER),
    ).toEqual({ ms: 11, counter: 4 });
  });

  it("refuses to move past the largest 48-bit timestamp", () => {
    expect(() =>
      nextState(
        { ms: MAX_TIMESTAMP, counter: MAX_COUNTER },
        MAX_TIMESTAMP,
        0,
        MAX_COUNTER,
      ),
    ).toThrow(IdError);
  });
});
