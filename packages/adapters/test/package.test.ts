// @bricx/adapters' package rules (P6-04, ADR 0074; Done when 2): an
// explicit exports map with no root barrel, workspace dependencies only
// (no npm package, so no 7-day check), and no environment or config key
// that could feed the registry (owner condition C2).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const repo = path.resolve(root, "../..");
const manifest = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
) as {
  exports: Record<string, { types: string; default: string }>;
  dependencies: Record<string, string>;
};

describe("@bricx/adapters package.json", () => {
  test("an explicit exports map: types, null, registry; no root export", () => {
    expect(Object.keys(manifest.exports).sort()).toEqual([
      "./null",
      "./registry",
      "./types",
    ]);
    for (const [subpath, target] of Object.entries(manifest.exports)) {
      const file = `./src${subpath.slice(1)}.ts`;
      expect(target).toEqual({ types: file, default: file });
    }
  });

  test("workspace dependencies only: domain, money, validation", () => {
    expect(manifest.dependencies).toEqual({
      "@bricx/domain": "workspace:*",
      "@bricx/money": "workspace:*",
      "@bricx/validation": "workspace:*",
    });
  });

  test("no config key names an adapter (C2)", () => {
    const configDir = path.join(repo, "packages/config/src");
    for (const file of readdirSync(configDir)) {
      const text = readFileSync(path.join(configDir, file), "utf8");
      expect(text, file).not.toMatch(/ADAPTER/);
    }
    const example = readFileSync(path.join(repo, ".env.example"), "utf8");
    expect(example).not.toMatch(/ADAPTER/);
  });
});
