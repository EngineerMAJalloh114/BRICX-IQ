// Client safety (P3 rule 3, carried to the api-client): src/ runs on
// devices, so it imports only its own files, zod and @bricx/validation's
// error-envelope subpath; it uses no Node API, no clock and no randomness
// (the fetch implementation is injected). The generated client is held to
// the same rule: it imports the mutator and its own files only.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const srcDir = path.join(import.meta.dirname, "../src");
const listTs = (dir: string, prefix = ""): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? listTs(path.join(dir, entry.name), `${prefix}${entry.name}/`)
      : entry.name.endsWith(".ts")
        ? [`${prefix}${entry.name}`]
        : [],
  );
const sources = listTs(srcDir);
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
  /^(?:\.\.?\/[a-z0-9./-]+(?:\.ts)?|zod|@bricx\/validation\/(?:codes|error-envelope))$/;

describe("static: src/ is client-safe", () => {
  it("the scanner sees imports (control)", () => {
    expect(specifiers(read("fetcher.ts"))).toContain(
      "@bricx/validation/error-envelope",
    );
    expect(specifiers('import x from "node:crypto"')).toEqual(["node:crypto"]);
    expect(ALLOWED.test("node:crypto")).toBe(false);
    expect(ALLOWED.test("@bricx/money/money")).toBe(false);
    expect(ALLOWED.test("../fetcher")).toBe(true);
    expect(ALLOWED.test("./generated/client.ts")).toBe(true);
  });

  it("src/ has the fetcher and the generated client", () => {
    expect(sources).toContain("fetcher.ts");
    expect(sources.some((f) => f.startsWith("generated/"))).toBe(true);
  });

  it.each(sources)(
    "%s imports only its own files, zod and the envelope",
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
        ["console", /\bconsole\b/],
        ["localStorage", /\blocalStorage\b/],
      ];
      for (const [name, pattern] of banned) {
        expect(pattern.test(code), `${file} mentions ${name}`).toBe(false);
      }
      expect(/new Date\(/.test(code), `${file} constructs a Date`).toBe(false);
    },
  );
});
