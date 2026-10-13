// ROADMAP P3-01 "Done when": 1M ids generated in-process are strictly
// increasing and unique. Three clocks, the real random source, elapsed time
// reported as a test annotation (shown by --reporter=verbose; no time
// limit, so it cannot flake). Strictly increasing implies
// unique; the frozen-clock run also counts distinct ids.
import { describe, expect, it } from "vitest";
import type { IdClock } from "../src/uuid-v7.js";
import { createUuidV7Generator } from "../src/uuid-v7.js";
import {
  expectStrictlyIncreasing,
  expectVersionAndVariant,
  frozenClock,
  generate,
  steppingClock,
  timestampField,
} from "./helpers.js";

const COUNT = 1_000_000;
const START = Date.UTC(2026, 9, 13);

function run(
  name: string,
  clock: IdClock,
  annotate: (message: string) => Promise<unknown>,
): Promise<string[]> {
  const ids = createUuidV7Generator({ clock });
  const started = performance.now();
  const out = generate(() => ids.next(), COUNT);
  const elapsed = performance.now() - started;
  const message = `[1M ids] ${name}: ${COUNT.toLocaleString("en")} ids in ${elapsed.toFixed(0)} ms (${((COUNT / elapsed) * 1000).toFixed(0)} ids/s)`;
  return annotate(message).then(() => out);
}

describe("1M ids", { timeout: 120_000 }, () => {
  it("frozen clock (every id in one millisecond): strictly increasing and unique", async ({
    annotate,
  }) => {
    const ids = await run("frozen clock", frozenClock(START), annotate);
    expect(ids).toHaveLength(COUNT);
    expectStrictlyIncreasing(ids);
    expect(new Set(ids).size).toBe(COUNT);
    expectVersionAndVariant(ids.slice(0, 10_000));
  });

  it("clock that goes back 5 ms every 50,000 calls: strictly increasing, and string order equals generation order", async ({
    annotate,
  }) => {
    const ids = await run(
      "backwards clock",
      steppingClock(START, 1_000, 50_000, 5),
      annotate,
    );
    expectStrictlyIncreasing(ids);
    expect([...ids].sort()).toEqual(ids);
    // About 1,000 distinct milliseconds were crossed.
    expect(new Set(ids.map(timestampField)).size).toBeGreaterThan(900);
  });

  it("real clock passed in by the test: strictly increasing, and string order equals generation order", async ({
    annotate,
  }) => {
    const ids = await run("real clock", { now: () => Date.now() }, annotate);
    expectStrictlyIncreasing(ids);
    expect([...ids].sort()).toEqual(ids);
  });
});
