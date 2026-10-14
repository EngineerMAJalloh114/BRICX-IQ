// Client safety (P3 rule 3): i18n runs on devices (Expo/Hermes) and in the
// API, so src/ imports only its own files, its catalogs, i18next,
// i18next-icu and intl-messageformat; no module loads node:*; and the
// modules load and work with no process, no crypto, no Intl.Locale and no
// Intl.PluralRules (Hermes, per its Intl documentation).
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { intlWithout } from "./helpers.ts";

const pkgDir = path.join(import.meta.dirname, "..");
const srcDir = path.join(pkgDir, "src");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const sources = walk(srcDir)
  .filter((f) => f.endsWith(".ts"))
  .map((f) => path.relative(srcDir, f).split(path.sep).join("/"))
  .sort();
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
  /^(?:\.\/[a-z0-9-]+\.ts|\.\/generated\/[a-z0-9-]+\.ts|\.\.\/[a-z0-9-]+\.ts|\.\.\/locales\/(?:en|fr|ar)\/[a-z]+\.json|i18next|i18next-icu|intl-messageformat)$/u;

const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("static: src/ is client-safe", () => {
  it("the scanner sees imports (control)", () => {
    expect(specifiers(read("translate.ts"))).toContain("i18next");
    expect(specifiers('import x from "node:fs"')).toEqual(["node:fs"]);
    expect(ALLOWED.test("node:fs")).toBe(false);
    expect(ALLOWED.test("@bricx/money/money")).toBe(false);
    expect(ALLOWED.test("../locales/fr/finance.json")).toBe(true);
  });

  it("src/ has the expected files", () => {
    expect(sources).toEqual([
      "catalog.ts",
      "check.ts",
      "errors.ts",
      "generated/keys.ts",
      "generated/rtl-data.ts",
      "i18next-types.ts",
      "icu.ts",
      "keys-gen.ts",
      "limits.ts",
      "locale.ts",
      "rtl.ts",
      "translate.ts",
    ]);
  });

  it.each(sources)(
    "%s imports only its own files, its catalogs and the three i18n libraries",
    (file) => {
      for (const spec of specifiers(read(file)))
        expect(spec, `${file} imports ${spec}`).toMatch(ALLOWED);
    },
  );

  it.each(sources)(
    "%s uses no Node or ambient host API, clock or randomness",
    (file) => {
      const code = read(file);
      const banned: readonly [string, RegExp][] = [
        ["process", /\bprocess\b/u],
        ["Buffer", /\bBuffer\b/u],
        ["__dirname", /\b__dirname\b/u],
        ["setImmediate", /\bsetImmediate\b/u],
        ["Math.random", /\bMath\.random\b/u],
        ["Date.now", /\bDate\.now\b/u],
        ["new Date(", /\bnew Date\(/u],
        ["performance", /\bperformance\b/u],
        ["crypto", /\bcrypto\b/u],
        ["console", /\bconsole\b/u],
      ];
      for (const [name, pattern] of banned)
        expect(pattern.test(code), `${file} mentions ${name}`).toBe(false);
    },
  );

  it("i18next, i18next-icu and intl-messageformat (with their @formatjs deps) import no Node built-in", () => {
    // .pnpm/intl-messageformat@<v>/node_modules, which also holds its
    // @formatjs dependencies.
    const store = path.dirname(
      realpathSync(path.join(pkgDir, "node_modules/intl-messageformat")),
    );
    const roots = [
      realpathSync(path.join(pkgDir, "node_modules/i18next")),
      realpathSync(path.join(pkgDir, "node_modules/i18next-icu")),
      path.join(store, "intl-messageformat"),
      path.join(store, "@formatjs"),
    ];
    let scanned = 0;
    for (const root of roots) {
      for (const file of walk(root).filter((f) => /\.(?:m?js|cjs)$/u.test(f))) {
        scanned += 1;
        for (const spec of specifiers(readFileSync(file, "utf8"))) {
          expect(builtins.has(spec), `${file} imports ${spec}`).toBe(false);
        }
      }
    }
    expect(scanned).toBeGreaterThan(10);
  });
});

describe("runtime: loads and works like Hermes (no process, crypto, Intl.Locale, Intl.PluralRules)", () => {
  it("every module imports with no process and no crypto, then works without Intl.Locale and PluralRules", async () => {
    const realProcess = process;
    vi.stubGlobal("Intl", intlWithout("Locale", "PluralRules"));
    vi.stubGlobal("crypto", undefined);
    vi.stubGlobal("process", undefined);
    const locale = await import("../src/locale.ts");
    const rtl = await import("../src/rtl.ts");
    const translate = await import("../src/translate.ts");
    const check = await import("../src/check.ts");
    const keys = await import("../src/generated/keys.ts");
    vi.stubGlobal("process", realProcess);
    expect(locale.resolveLocale([undefined, "AR-eg", "fr"])).toBe("ar");
    expect(locale.normalizeLocale("fr-ca")).toBe("fr-CA");
    expect(locale.formattingLocale("ar-EG")).toBe("ar-EG-u-nu-latn");
    expect(rtl.isRTL("ar")).toBe(true);
    expect(rtl.isRTL("fr")).toBe(false);
    const ar = translate.createTranslator("ar");
    expect(ar.direction).toBe("rtl");
    expect(ar.t("common:save")).toBe("حفظ");
    expect(ar.t("validation:too_long", { max: 1200 })).toContain("1,200");
    expect(typeof check.checkCatalogs).toBe("function");
    expect(Object.keys(keys.MESSAGE_ARGS).length).toBeGreaterThan(50);
  });
});
