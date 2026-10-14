// ICU signatures (argument names, kinds and arms), bounded before parsing
// (P3 rule 9) and compared with the independent reference parser in
// oracle.ts (P3 rule 10).
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../src/limits.ts";
import { messageSignature } from "../src/icu.ts";
import { icuOracleChecks, messageArb } from "./checks-icu.ts";
import { timed } from "./helpers.ts";
import { refSignature } from "./oracle.ts";

const sig = (message: string) => messageSignature(message, "en");

describe("messageSignature", () => {
  it.each([
    ["Save", {}, {}],
    ["Hi {name}", { name: "string" }, {}],
    ["{max, number} chars", { max: "number" }, {}],
    ["{d, date, short}", { d: "date" }, {}],
    ["{d, time}", { d: "time" }, {}],
    ["<b>x</b> {a}", { b: "tag", a: "string" }, {}],
    [
      "{s, select, a {A {x}} other {B}}",
      { s: "select", x: "string" },
      { s: ["a", "other"] },
    ],
    [
      "{n, plural, =0 {none} one {# item} other {# items}}",
      { n: "plural" },
      { n: ["=0", "one", "other"] },
    ],
    [
      "{n, selectordinal, one {#st} other {#th}}",
      { n: "selectordinal" },
      { n: ["one", "other"] },
    ],
    ["{a} {a}", { a: "string" }, {}],
    ["it''s '{literal}'", {}, {}],
  ])("%j", (message, args, arms) => {
    expect(sig(message)).toEqual({ ok: true, signature: { args, arms } });
  });

  it.each([
    ["{", "invalid_icu"],
    ["{a, plural, one {x}}", "invalid_icu"],
    ["{a, bogus}", "invalid_icu"],
    ["{a} {a, number}", "argument_conflict"],
    ["{a, select, x {{a, number}} other {}}", "argument_conflict"],
  ])("%j is rejected: %s", (message, reason) => {
    expect(sig(message)).toEqual({ ok: false, reason });
  });

  it("bounds length, braces and depth before parsing", () => {
    expect(sig("a".repeat(LIMITS.message))).toMatchObject({ ok: true });
    expect(sig("a".repeat(LIMITS.message + 1))).toEqual({
      ok: false,
      reason: "message_too_long",
    });
    expect(sig("{a}".repeat(LIMITS.braces + 1))).toEqual({
      ok: false,
      reason: "too_many_placeholders",
    });
    const deep =
      "{a, select, other {".repeat(LIMITS.depth) +
      "x" +
      "}}".repeat(LIMITS.depth);
    expect(sig(deep)).toMatchObject({ ok: true });
    const deeper =
      "{a, select, other {".repeat(LIMITS.depth + 1) +
      "x" +
      "}}".repeat(LIMITS.depth + 1);
    expect(sig(deeper)).toEqual({ ok: false, reason: "nesting_too_deep" });
  });

  it(`counts placeholders after the bounded parse: ${String(LIMITS.placeholders)} pass, one more fails`, () => {
    const names = (n: number) =>
      Array.from({ length: n }, (_, i) => `{a${String(i)}}`).join(" ");
    expect(sig(names(LIMITS.placeholders))).toMatchObject({ ok: true });
    expect(sig(names(LIMITS.placeholders + 1))).toEqual({
      ok: false,
      reason: "too_many_placeholders",
    });
  });

  it("rejects pathological input quickly (2,000-deep nesting overflowed the parser in the probe)", () => {
    const deep = "{a, select, other {".repeat(2_000) + "x" + "}}".repeat(2_000);
    const huge = "{a}".repeat(1_000_000);
    expect(
      timed(() => {
        expect(sig(deep)).toEqual({ ok: false, reason: "message_too_long" });
      }),
    ).toBeLessThan(50);
    expect(
      timed(() => {
        expect(sig(huge)).toEqual({ ok: false, reason: "message_too_long" });
      }),
    ).toBeLessThan(50);
    const shortDeep = "{a,select,other{".repeat(60).slice(0, LIMITS.message);
    expect(
      timed(() => {
        expect(sig(shortDeep)).toMatchObject({ ok: false });
      }),
    ).toBeLessThan(50);
  });
});

describe("oracle", () => {
  it("agrees with the reference parser on 1,000 generated messages", () => {
    icuOracleChecks(messageSignature);
  });

  it("the generator covers every argument kind (control)", () => {
    const kinds = new Set(
      fc
        .sample(messageArb, { numRuns: 300, seed: 7 })
        .flatMap((m) => Object.values(refSignature(m).args)),
    );
    expect([...kinds].sort()).toEqual([
      "number",
      "plural",
      "select",
      "selectordinal",
      "string",
    ]);
  });
});
