// Client safety (P3 rule 3): validation runs on devices, so src/ imports
// only its own files, its data, zod, and the allowed subpaths of
// @bricx/money and @bricx/i18n; it uses no Node or host API, reads no clock
// and no randomness, and its modules load and work with no globalThis.crypto
// and no process.
import { readFileSync, readdirSync } from "node:fs";
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
  /^(?:\.\/[a-z0-9-]+\.ts|\.\.\/data\/(?:countries|time-zones)\.json|zod|@bricx\/money\/(?:currency|errors|schema)|@bricx\/i18n\/(?:locale|errors|keys|limits))$/;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("static: src/ is client-safe", () => {
  it("the scanner sees imports (control)", () => {
    expect(specifiers(read("email.ts"))).toContain("zod");
    expect(specifiers('import x from "node:crypto"')).toEqual(["node:crypto"]);
    expect(ALLOWED.test("node:crypto")).toBe(false);
    expect(ALLOWED.test("@bricx/money/money")).toBe(false);
    expect(ALLOWED.test("@bricx/i18n/translate")).toBe(false);
    expect(ALLOWED.test("@bricx/money/errors")).toBe(true);
  });

  it("src/ has the expected files", () => {
    expect(sources.sort()).toEqual([
      "bounded.ts",
      "codes.ts",
      "country.ts",
      "currency.ts",
      "email.ts",
      "error-envelope.ts",
      "formats.ts",
      "geo.ts",
      "limits.ts",
      "locale.ts",
      "money.ts",
      "pagination.ts",
      "path.ts",
      "phone.ts",
      "time-zone.ts",
    ]);
  });

  it.each(sources)(
    "%s imports only its own files, its data, zod and allowed @bricx subpaths",
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
        ["parseFloat", /\bparseFloat\b/],
        ["z.coerce", /\bcoerce\b/],
      ];
      for (const [name, pattern] of banned) {
        expect(pattern.test(code), `${file} mentions ${name}`).toBe(false);
      }
      expect(/new Date\(/.test(code), `${file} constructs a Date`).toBe(false);
    },
  );
});

describe("runtime: loads and works with no crypto and no process", () => {
  it("every module imports and parses without globalThis.crypto or process", async () => {
    vi.stubGlobal("crypto", undefined);
    vi.stubGlobal("process", undefined);
    const { EmailSchema } = await import("../src/email.ts");
    const { PhoneE164Schema } = await import("../src/phone.ts");
    const { CountryCodeSchema } = await import("../src/country.ts");
    const { CurrencySchema } = await import("../src/currency.ts");
    const { TimeZoneSchema } = await import("../src/time-zone.ts");
    const { LanguageTagSchema } = await import("../src/locale.ts");
    const { GeoPointSchema } = await import("../src/geo.ts");
    const { MoneySchema } = await import("../src/money.ts");
    const { PageQuerySchema } = await import("../src/pagination.ts");
    const { parseAtBoundary } = await import("../src/error-envelope.ts");
    const codes = await import("../src/codes.ts");
    const limits = await import("../src/limits.ts");
    expect(EmailSchema.parse("A@B.co")).toBe("a@b.co");
    expect(PhoneE164Schema.parse("+23276123456")).toBe("+23276123456");
    expect(CountryCodeSchema.parse("SL")).toBe("SL");
    expect(CurrencySchema.parse("SLE")).toBe("SLE");
    expect(TimeZoneSchema.parse("UTC")).toBe("Etc/UTC");
    expect(LanguageTagSchema.parse("ar-eg")).toBe("ar-EG");
    expect(GeoPointSchema.parse({ lat: 1, lng: 2 })).toEqual({
      lat: 1,
      lng: 2,
    });
    expect(MoneySchema.parse({ amount: "1", currency: "USD" }).amount).toBe(1n);
    expect(PageQuerySchema.parse({})).toEqual({ limit: 25 });
    const result = parseAtBoundary(EmailSchema, "x");
    expect(result.success).toBe(false);
    expect(codes.VALIDATION_CODES.length).toBeGreaterThan(0);
    expect(limits.LIMITS.issues).toBe(100);
  });
});
