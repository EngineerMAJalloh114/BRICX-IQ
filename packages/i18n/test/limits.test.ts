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

  // Linearity is checked as a ratio on the same machine, not against a
  // wall-clock budget: CI runners with coverage were 4x slower than a
  // workstation (416 ms for 1 MB). Four times the input must take well
  // under 16 times as long (the quadratic ratio); linear is about 4.
  it("is linear: 4x the input takes under 10x the time", () => {
    const braces = (n: number) => "{".repeat(n) + "}".repeat(n);
    const small = braces(125_000);
    const large = braces(500_000);
    let result = { braces: 0, depth: 0 };
    prescanMessage(small);
    const tSmall = timed(() => prescanMessage(small));
    const tLarge = timed(() => (result = prescanMessage(large)));
    expect(result).toEqual({ braces: 500_000, depth: 500_000 });
    expect(tLarge).toBeLessThan(10 * Math.max(tSmall, 1));
  });
});
