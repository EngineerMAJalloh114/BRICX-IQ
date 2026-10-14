// Client safety (P3 rule 3; design constraint 6): permissions runs on
// devices, so src/ imports only its own files, @bricx/ids, @casl/ability and
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
    expect(VALUE_ALLOWED.test("zod")).toBe(false);
  });

  it("src/ has the expected files", () => {
    expect(sources.sort()).toEqual([
      "ability.ts",
      "catalogue.ts",
      "errors.ts",
      "generate.ts",
      "limits.ts",
      "model.ts",
      "roles.ts",
      "rules.ts",
      "scopes.ts",
      "sod-rules.ts",
      "sod.ts",
    ]);
  });

  it.each(sources)(
    "%s imports only its own files, @bricx/ids, @casl/ability, and @bricx/i18n/keys as types",
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
      ];
      for (const [name, pattern] of banned) {
        expect(pattern.test(code), `${file} mentions ${name}`).toBe(false);
      }
      expect(/new Date\(/.test(code), `${file} constructs a Date`).toBe(false);
    },
  );
});

describe("runtime: loads and works with no crypto and no process", () => {
  it("every module imports and checks without globalThis.crypto or process", async () => {
    vi.stubGlobal("crypto", undefined);
    vi.stubGlobal("process", undefined);
    const { buildAbility, can } = await import("../src/ability.ts");
    const { grantsForRole } = await import("../src/roles.ts");
    const { checkSod } = await import("../src/sod.ts");
    const { generateAll } = await import("../src/generate.ts");
    const { CONTEXT, IN_SCOPE, TARGETS, USER, uuid } =
      await import("./helpers.ts");
    const ability = buildAbility(grantsForRole("foreman", TARGETS), CONTEXT);
    expect(can(ability, "create", "field.dailylog", IN_SCOPE)).toBe(true);
    expect(
      checkSod({
        chainId: uuid(1),
        recordId: uuid(1),
        recordType: "finance.payment",
        action: "approve",
        actorId: USER,
        history: [],
      }),
    ).toEqual({ ok: true });
    expect(Object.keys(generateAll())).toHaveLength(6);
  });
});
