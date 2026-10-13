// Client safety (P3 rule 3): money runs on devices, so src/ imports only its
// own files, its data file, decimal.js and zod; it uses no Node or host API,
// reads no clock and no randomness, and its modules load and work with no
// globalThis.crypto and no process.
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const srcDir = path.join(import.meta.dirname, "../src");
const sources = readdirSync(srcDir).filter((f) => f.endsWith(".ts"));
const read = (file: string) => readFileSync(path.join(srcDir, file), "utf8");

/** Module specifiers of every import/export-from, dynamic import and require. */
function specifiers(code: string): string[] {
  const found: string[] = [];
  const patterns = [
    /\bfrom\s*["']([^"']+)["']/g,
    /\bimport\s*["']([^"']+)["']/g,
    /\bimport\s*\(\s*["']?([^"')]+)["']?\s*\)/g,
    /\brequire\s*\(\s*["']?([^"')]+)["']?\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of code.matchAll(pattern)) found.push(match[1] ?? "");
  }
  return found;
}

const ALLOWED =
  /^(?:\.\/[a-z0-9-]+\.js|\.\.\/data\/iso4217\.json|decimal\.js|zod)$/;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("static: src/ is client-safe", () => {
  it("the scanner sees imports (control)", () => {
    expect(specifiers(read("money.ts"))).toContain("./errors.js");
    expect(specifiers('import x from "node:crypto"')).toEqual(["node:crypto"]);
    expect(ALLOWED.test("node:crypto")).toBe(false);
    expect(ALLOWED.test("decimal.js")).toBe(true);
  });

  it("src/ has the expected files", () => {
    expect(sources.sort()).toEqual([
      "allocate.ts",
      "currency.ts",
      "decimal.ts",
      "errors.ts",
      "format.ts",
      "fx.ts",
      "money.ts",
      "rounding.ts",
      "schema.ts",
    ]);
  });

  it.each(sources)(
    "%s imports only its own files, its data, decimal.js and zod",
    (file) => {
      for (const spec of specifiers(read(file))) {
        expect(spec, `${file} imports ${spec}`).toMatch(ALLOWED);
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
        ["setImmediate", /\bsetImmediate\b/],
        ["Math.random", /\bMath\.random\b/],
        ["Date.now", /\bDate\.now\b/],
        ["performance", /\bperformance\b/],
        ["crypto", /\bcrypto\b/],
        ["parseFloat", /\bparseFloat\b/],
      ];
      for (const [name, pattern] of banned) {
        expect(pattern.test(code), `${file} mentions ${name}`).toBe(false);
      }
      expect(/new Date\(/.test(code), `${file} constructs a Date`).toBe(false);
    },
  );

  it("decimal.js's ESM entry imports nothing (no node:* at load)", () => {
    const require = createRequire(import.meta.url);
    const entry = require
      .resolve("decimal.js")
      .replace(/decimal\.js$/, "decimal.mjs");
    const code = readFileSync(entry, "utf8");
    expect(specifiers(code)).toEqual([]);
    // Its only crypto use is Decimal.random() with crypto: true, which money never calls.
    expect(code.includes("require(")).toBe(false);
  });
});

describe("runtime: loads and works with no crypto and no process", () => {
  it("every module imports and computes without globalThis.crypto or process", async () => {
    vi.stubGlobal("crypto", undefined);
    vi.stubGlobal("process", undefined);
    const money = await import("../src/money.js");
    const { allocate } = await import("../src/allocate.js");
    const { convert } = await import("../src/fx.js");
    const { formatMoney } = await import("../src/format.js");
    const { MoneySchema } = await import("../src/schema.js");
    vi.unstubAllGlobals();
    const m = money.fromMinor(100n, "USD");
    expect(allocate(m, [1n, 1n, 1n]).map((p) => p.amount)).toEqual([
      34n,
      33n,
      33n,
    ]);
    expect(convert(m, "2", "EUR").money.amount).toBe(200n);
    expect(formatMoney(m, "en-US")).toBe("$1.00");
    expect(MoneySchema.parse({ amount: "1", currency: "USD" }).amount).toBe(1n);
  });
});
