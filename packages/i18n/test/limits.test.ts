// Input bounds (P3 rule 9, D8): fixed caps, and a linear pre-scan that
// bounds braces and nesting before any ICU parsing.
import { describe, expect, it } from "vitest";
import { LIMITS, prescanMessage } from "../src/limits.ts";
import { timed } from "./helpers.ts";

describe("LIMITS", () => {
  it("are the approved values and frozen", () => {
    expect(LIMITS).toEqual({
      localeTag: 35,
      chain: 8,
      key: 128,
      message: 1000,
      braces: 64,
      depth: 4,
      placeholders: 20,
      args: 20,
      argString: 1000,
      catalogBytes: 262_144,
    });
    expect(Object.isFrozen(LIMITS)).toBe(true);
  });
});

describe("prescanMessage", () => {
  it.each([
    ["", 0, 0],
    ["plain text", 0, 0],
    ["{a}", 1, 1],
    ["{a} and {b}", 2, 1],
    ["{n, plural, one {# x} other {# y}}", 3, 2],
    ["{a, select, x {{b, select, y {{c}} other {z}}} other {w}}", 7, 5],
    ["}}}", 0, 0],
    ["'{'", 1, 1],
  ])("%j: %d braces, depth %d", (text, braces, depth) => {
    expect(prescanMessage(text)).toEqual({ braces, depth });
  });

  it("is linear: a 1 MB brace string scans in well under 100 ms", () => {
    const text = "{".repeat(500_000) + "}".repeat(500_000);
    let result = { braces: 0, depth: 0 };
    expect(timed(() => (result = prescanMessage(text)))).toBeLessThan(100);
    expect(result).toEqual({ braces: 500_000, depth: 500_000 });
  });
});
