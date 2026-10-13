// Client safety (P3 rule 3): ids run on devices, so src/ imports nothing
// but its own files, uses no Node API, and reads globalThis.crypto only
// when an id is made, never at module load.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { seededRandom } from "./helpers.js";

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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("static: src/ is client-safe", () => {
  it("the scanner sees imports (control)", () => {
    expect(specifiers(read("uuid-v7.ts"))).toContain("./errors.js");
    expect(specifiers('import x from "node:crypto"')).toEqual(["node:crypto"]);
    expect(specifiers("await import(name)")).toEqual(["name"]);
  });

  it("src/ has the expected files", () => {
    expect(sources.sort()).toEqual([
      "brand.ts",
      "branded.ts",
      "errors.ts",
      "state.ts",
      "uuid-v7.ts",
    ]);
  });

  it.each(sources)("%s imports only its own files", (file) => {
    for (const spec of specifiers(read(file))) {
      expect(spec, `${file} imports ${spec}`).toMatch(/^\.\/[a-z0-9-]+\.js$/);
    }
  });

  it.each(sources)("%s uses no Node or ambient host API", (file) => {
    const code = read(file);
    for (const name of [
      "process",
      "Buffer",
      "require",
      "__dirname",
      "setImmediate",
      "Math.random",
      "Date.now",
      "performance",
    ]) {
      expect(code.includes(name), `${file} mentions ${name}`).toBe(false);
    }
    expect(/new Date\(\s*\)/.test(code), `${file} reads the clock`).toBe(false);
  });
});

describe("runtime: crypto is read only when an id is made", () => {
  it("imports and builds a generator with no globalThis.crypto; next() then fails with no_crypto", async () => {
    vi.stubGlobal("crypto", undefined);
    const mod = await import("../src/uuid-v7.js");
    const branded = await import("../src/branded.js");
    expect(branded.parseOrgId("017f22e2-79b0-7cc3-98c4-dc0c0c07398f")).toBe(
      "017f22e2-79b0-7cc3-98c4-dc0c0c07398f",
    );
    const ids = mod.createUuidV7Generator({ clock: { now: () => 1 } });
    expect(() => ids.next()).toThrow(
      expect.objectContaining({ code: "no_crypto" }),
    );
  });

  it("an injected fillRandom is used and globalThis.crypto is never touched", async () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    const mod = await import("../src/uuid-v7.js");
    const ids = mod.createUuidV7Generator({
      clock: { now: () => 1 },
      fillRandom: seededRandom(1),
    });
    ids.next();
    expect(spy).not.toHaveBeenCalled();
  });

  it("without fillRandom, globalThis.crypto.getRandomValues supplies 10 bytes per id", async () => {
    const spy = vi.spyOn(globalThis.crypto, "getRandomValues");
    const mod = await import("../src/uuid-v7.js");
    const ids = mod.createUuidV7Generator({ clock: { now: () => 1 } });
    ids.next();
    ids.next();
    expect(spy).toHaveBeenCalledTimes(2);
    const first = spy.mock.calls[0]?.[0];
    expect(first).toBeInstanceOf(Uint8Array);
    expect(first?.byteLength).toBe(10);
  });

  it("crypto is looked up per id, not captured at load: a crypto that appears later is used", async () => {
    vi.stubGlobal("crypto", undefined);
    const mod = await import("../src/uuid-v7.js");
    const ids = mod.createUuidV7Generator({ clock: { now: () => 1 } });
    let calls = 0;
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        calls += 1;
        bytes.fill(0);
        return bytes;
      },
    });
    expect(ids.next()).toBe("00000000-0001-7000-8000-000000000000");
    expect(calls).toBe(1);
  });

  it("a crypto object without getRandomValues fails with no_crypto", async () => {
    vi.stubGlobal("crypto", {});
    const mod = await import("../src/uuid-v7.js");
    const ids = mod.createUuidV7Generator({ clock: { now: () => 1 } });
    expect(() => ids.next()).toThrow(
      expect.objectContaining({ code: "no_crypto" }),
    );
  });
});
