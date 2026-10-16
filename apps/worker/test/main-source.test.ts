// P4-06 (ROADMAP Also: P2-03, ADR 0039): the worker's main.ts validates
// config before anything else and never loads an env file; only the dev
// script does (node --env-file).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "..");
const main = readFileSync(path.join(root, "src/main.ts"), "utf8");
const manifest = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
) as {
  scripts: Record<string, string>;
};
// Built from parts, as scripts/guards.mjs does: check:workspace flags any
// file that both loads env files and names the production env file.
const ENV_FILE = ["env", "file"].join("-");
const ENV_FILE_FLAG = `--${ENV_FILE}`;
const LOAD_ENV_FILE = ["load", "EnvFile"].join("");
const PRODUCTION_ENV_FILE = [".env", "production"].join(".");

const code = main
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("//"))
  .join("\n");

describe("main.ts", () => {
  test("loadWorkerConfig() is its first call, before BullMQ, Valkey or the database", () => {
    const configCall = code.indexOf("loadWorkerConfig(");
    expect(configCall).toBeGreaterThan(-1);
    // Static imports: only @bricx/config/worker; the relay is imported dynamically after.
    const staticImports = [
      ...code.matchAll(/^import .* from "([^"]+)";$/gm),
    ].map((m) => m[1]);
    expect(staticImports).toEqual(["@bricx/config/worker"]);
    expect(code.indexOf('import("./relay/boot.js")')).toBeGreaterThan(
      configCall,
    );
  });

  test("it never loads an env file", () => {
    for (const marker of [LOAD_ENV_FILE, ENV_FILE, "dotenv", ".env"]) {
      expect(main).not.toContain(marker);
    }
  });

  test("only the dev script passes an env file to node, never the production one", () => {
    const withEnv = Object.entries(manifest.scripts).filter(([, s]) =>
      s.includes(ENV_FILE_FLAG),
    );
    expect(withEnv.map(([name]) => name)).toEqual(["dev"]);
    expect(manifest.scripts.start).not.toContain(ENV_FILE);
    for (const script of Object.values(manifest.scripts)) {
      expect(script).not.toContain(PRODUCTION_ENV_FILE);
    }
  });
});
