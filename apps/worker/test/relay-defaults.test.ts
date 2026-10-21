// P4-06 (ADR 0056): the relay's defaults and its two backoffs.
// - Batches of 100, polled every 250 ms when idle (P5-04 owner condition
//   4: 1 s until then) and at once after a full batch; a batch deadline of
//   15 s (condition 6); Valkey commands bounded
//   at 5 s; dead-letter after 10 row failures (condition 1).
// - Global backoff on an infrastructure failure: 1 s, doubling, capped at
//   30 s (condition 1). The per-row backoff (min(2^attempts s, 300 s)) is
//   the database's (markOutboxFailed, proved in packages/db).
import { describe, expect, test } from "vitest";
import { RELAY_DEFAULTS, globalBackoffMs } from "../src/relay/relay.js";

describe("RELAY_DEFAULTS", () => {
  test("are the approved values, frozen", () => {
    expect(RELAY_DEFAULTS).toEqual({
      batchSize: 100,
      deadLetterAfter: 10,
      batchDeadlineMs: 15_000,
      idlePollMs: 250,
      maxBackoffMs: 30_000,
      commandTimeoutMs: 5_000,
      unavailableLogEveryMs: 60_000,
      jobRetentionSeconds: 86_400,
    });
    expect(Object.isFrozen(RELAY_DEFAULTS)).toBe(true);
  });
});

describe("globalBackoffMs(consecutiveFailures, maxBackoffMs)", () => {
  test("1 s, doubling, capped at 30 s", () => {
    expect(
      [1, 2, 3, 4, 5, 6, 7, 50, 1000].map((n) => globalBackoffMs(n, 30_000)),
    ).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000,
    ]);
  });

  test("never below 1 s, never above the cap", () => {
    expect(globalBackoffMs(0, 30_000)).toBe(1_000);
    expect(globalBackoffMs(3, 2_500)).toBe(2_500);
  });
});
