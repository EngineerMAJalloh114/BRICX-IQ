// P4-02 (ADR 0052): the migrate entry point validates its config first,
// imports the migrator only afterwards, never loads an env file, and only
// the root `db:migrate` script hands node the dev .env.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const appDir = path.resolve(import.meta.dirname, "..");
const source = readFileSync(path.join(appDir, "src/migrate.ts"), "utf8");
const code = source
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");
const scriptsOf = (file: string): Record<string, string> => {
  const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (
    typeof parsed === "object" &&
    parsed !== null &&
    "scripts" in parsed &&
    typeof parsed.scripts === "object" &&
    parsed.scripts !== null
  ) {
    return Object.fromEntries(
      Object.entries(parsed.scripts).map(([k, v]) => [k, String(v)]),
    );
  }
  return {};
};
const ENV_FILE = ["env", "file"].join("-");
const LOAD_ENV_FILE = ["load", "EnvFile"].join("");

describe("src/migrate.ts", () => {
  test("loadMigrateConfig() comes first; the migrator is imported after it", () => {
    const configCall = code.indexOf("loadMigrateConfig(");
    expect(configCall).toBeGreaterThan(-1);
    const staticImports = [
      ...code.matchAll(/^import .* from "([^"]+)";$/gm),
    ].map((m) => m[1]);
    expect(staticImports).toEqual(["@bricx/config/migrate"]);
    expect(code.indexOf('import("@bricx/db/migrate")')).toBeGreaterThan(
      configCall,
    );
  });

  // P4-04 condition 3: no folder argument, so the migrator reads only the
  // production journal (MIGRATIONS_DIR), never a test fixture folder.
  test("migrate() gets the URL only, so it runs the production journal", () => {
    const calls = [...code.matchAll(/\bmigrate\(([^)]*)\)/g)].map((m) => m[1]);
    expect(calls).toEqual(["config.migrationDatabase.url"]);
    expect(code).not.toMatch(/fixtures|MIGRATIONS_DIR|readMigrations/);
  });

  test("it never loads an env file and never reads the api config", () => {
    for (const marker of [LOAD_ENV_FILE, ENV_FILE, "dotenv", ".env"]) {
      expect(source).not.toContain(marker);
    }
    expect(source).not.toContain("@bricx/config/api");
  });

  test("the api's migrate script runs the build with no env file", () => {
    const scripts = scriptsOf(path.join(appDir, "package.json"));
    expect(scripts["migrate"]).toBe(
      "node --import ./dist/register.js dist/migrate.js",
    );
  });

  test("the root db:migrate builds, then runs it with the dev .env", () => {
    const scripts = scriptsOf(path.join(appDir, "../../package.json"));
    expect(scripts["db:migrate"]).toBe(
      `pnpm --filter @bricx/api build && node --${ENV_FILE}=.env --import ./apps/api/dist/register.js apps/api/dist/migrate.js`,
    );
    expect(scripts["db:generate"]).toBe("pnpm --filter @bricx/db generate");
  });
});
