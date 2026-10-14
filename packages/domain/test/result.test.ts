// Result (P3-06): { ok: true, value } | { ok: false, error }, frozen, with
// small combinators. The shape matches @bricx/ids's parse results on `ok`
// and `value`.
import { describe, expect, it } from "vitest";
import { andThen, err, isErr, isOk, map, mapErr, ok } from "../src/result.ts";
import type { Result } from "../src/result.ts";

const half = (n: number): Result<number, string> =>
  n % 2 === 0 ? ok(n / 2) : err("odd");

describe("ok and err", () => {
  it("build frozen values", () => {
    const a = ok(1);
    const b = err("e");
    expect(a).toEqual({ ok: true, value: 1 });
    expect(b).toEqual({ ok: false, error: "e" });
    expect(Object.isFrozen(a)).toBe(true);
    expect(Object.isFrozen(b)).toBe(true);
    expect(Object.keys(a)).toEqual(["ok", "value"]);
    expect(Object.keys(b)).toEqual(["ok", "error"]);
  });

  it("isOk and isErr narrow", () => {
    expect(isOk(ok(1))).toBe(true);
    expect(isOk(err(1))).toBe(false);
    expect(isErr(err(1))).toBe(true);
    expect(isErr(ok(1))).toBe(false);
  });
});

describe("combinators", () => {
  it("map changes a value and passes an error through untouched", () => {
    expect(map(ok(2), (n) => n + 1)).toEqual(ok(3));
    const e = err("x");
    let called = false;
    const out = map(e as Result<number, string>, (n) => {
      called = true;
      return n;
    });
    expect(out).toBe(e);
    expect(called).toBe(false);
  });

  it("mapErr changes an error and passes a value through untouched", () => {
    expect(mapErr(err("x"), (s) => s.length)).toEqual(err(1));
    const v = ok(5);
    expect(mapErr(v as Result<number, string>, (s) => s.length)).toBe(v);
  });

  it("andThen chains and stops at the first error", () => {
    expect(andThen(ok(8), half)).toEqual(ok(4));
    expect(andThen(andThen(ok(8), half), half)).toEqual(ok(2));
    expect(andThen(ok(3), half)).toEqual(err("odd"));
    const first = err("first");
    expect(andThen(first as Result<number, string>, half)).toBe(first);
  });

  it("results of combinators are frozen", () => {
    expect(Object.isFrozen(map(ok(1), (n) => n))).toBe(true);
    expect(Object.isFrozen(mapErr(err(1), (n) => n))).toBe(true);
  });
});
