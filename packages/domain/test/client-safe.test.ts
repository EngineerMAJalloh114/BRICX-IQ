// Client safety (P3 rule 3; design constraint 1): domain runs on devices,
// so src/ imports only its own files, its data/, @bricx/money/rounding and
// (type-only) @bricx/i18n/keys; it uses no Node or host API, reads no clock
// and no randomness, and works with no globalThis.crypto and no process.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TYPE_ONLY_ALLOWED, VALUE_ALLOWED, imports } from "./scan.ts";

const srcDir = path.join(import.meta.dirname, "../src");
const sources = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
const read = (file: string) => readFileSync(path.join(srcDir, file), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("static: src/ is client-safe", () => {
  it("the scanner sees imports (control)", () => {
    expect(imports('import { x } from "node:crypto"')).toEqual([
      ["node:crypto", false],
    ]);
    expect(
      imports('import type { MessageKey } from "@bricx/i18n/keys"'),
    ).toEqual([["@bricx/i18n/keys", true]]);
    expect(VALUE_ALLOWED.test("@bricx/i18n/keys")).toBe(false);
    expect(VALUE_ALLOWED.test("@bricx/money/money")).toBe(false);
    expect(VALUE_ALLOWED.test("@bricx/ids/uuid-v7")).toBe(false);
    expect(VALUE_ALLOWED.test("xstate")).toBe(false);
    expect(VALUE_ALLOWED.test("@bricx/money/rounding")).toBe(true);
  });

  it("src/ has the expected files", () => {
    expect(sources.sort()).toEqual([
      "clock.ts",
      "decimal.ts",
      "errors.ts",
      "limits.ts",
      "machine.ts",
      "regions.ts",
      "result.ts",
      "units-data.ts",
      "units.ts",
    ]);
  });

  it.each(sources)(
    "%s imports only its own files, data/, @bricx/money/rounding, and @bricx/i18n/keys as types",
    (file) => {
      for (const [spec, typeOnly] of imports(read(file))) {
        if (typeOnly && TYPE_ONLY_ALLOWED.test(spec)) continue;
        expect(spec, `${file} imports ${spec}`).toMatch(VALUE_ALLOWED);
      }
    },
  );

  it.each(sources)(
    "%s uses no Node or ambient host API, clock or randomness",
    (file) => {
      const code = read(file);
      const banned: readonly [string, RegExp][] = [
        ["process", /\bprocess\b/],
        ["Buffer", /\bBuffer\b/],
        ["__dirname", /\b__dirname\b/],
        ["Math.random", /\bMath\.random\b/],
        ["Date.now", /\bDate\.now\b/],
        ["performance", /\bperformance\b/],
        ["crypto", /\bcrypto\b/],
        ["console", /\bconsole\b/],
        ["eval", /\beval\b|new Function/],
        ["xstate", /["']xstate/],
      ];
      for (const [name, pattern] of banned) {
        expect(pattern.test(code), `${file} mentions ${name}`).toBe(false);
      }
      expect(/new Date\(/.test(code), `${file} constructs a Date`).toBe(false);
    },
  );
});

describe("runtime: loads and works with no crypto and no process", () => {
  it("every module imports and works without globalThis.crypto or process", async () => {
    vi.stubGlobal("crypto", undefined);
    vi.stubGlobal("process", undefined);
    const { fixedClock } = await import("../src/clock.ts");
    const { ok } = await import("../src/result.ts");
    const { MachineError } = await import("../src/errors.ts");
    const { defineMachine, transition, toXStateConfig } =
      await import("../src/machine.ts");
    const { parseQuantity, convert } = await import("../src/units.ts");
    const { unitSystemFor } = await import("../src/regions.ts");
    const { Rounding } = await import("@bricx/money/rounding");
    expect(fixedClock(5).now()).toBe(5);
    expect(ok(1).ok).toBe(true);
    expect(new MachineError("illegal_transition").code).toBe(
      "illegal_transition",
    );
    const machine = defineMachine({
      id: "m",
      initial: "a",
      states: ["a", "b"],
      events: ["go"],
      final: ["b"],
      transitions: [{ from: "a", event: "go", to: "b" }],
    });
    expect(transition(machine, "a", "go", undefined)).toEqual({
      ok: true,
      value: "b",
    });
    expect(toXStateConfig(machine).initial).toBe("a");
    const metre = parseQuantity("1", "m");
    expect(metre.ok).toBe(true);
    if (metre.ok) {
      const ft = convert(metre.value, "ft", {
        scale: 2,
        rounding: Rounding.HALF_EVEN,
      });
      expect(ft.ok).toBe(true);
    }
    expect(unitSystemFor("US")).toEqual({ ok: true, value: "us_customary" });
  });
});
