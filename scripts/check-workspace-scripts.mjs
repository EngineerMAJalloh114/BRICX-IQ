// Fails when a workspace package lacks a script `pnpm verify` depends on:
// every package under apps/, packages/ and tooling/ needs `typecheck` and
// `lint`; apps/ and packages/ also need `test` (tooling/ is proven by its
// smoke packages instead). Each apps/ and packages/ package must also run
// its tests through @bricx/vitest-config: exactly one vitest.config.mts or
// vitest.config.ts that calls defaultPreset or swcPreset, no other Vite or
// Vitest config file, and a `test` script that neither points Vitest at
// another config nor turns coverage off. Also fails if Vitest's pass-on-no-tests option
// appears in any package.json or Vitest/Vite config, so a package can never
// pass with zero tests. A folder without package.json is a placeholder.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
/** @type {Record<string, string[]>} */
const requiredByGroup = {
  apps: ["typecheck", "lint", "test"],
  packages: ["typecheck", "lint", "test"],
  tooling: ["typecheck", "lint"],
};
// Built from parts so this file does not match its own search.
const noTestsOption = ["pass", "With", "No", "Tests"].join("");
const configFile =
  /^(?:package\.json|vite(?:st)?\.(?:config|workspace)\.[cm]?[jt]s)$/;
const skippedDirs = new Set([
  ".git",
  ".turbo",
  "node_modules",
  "coverage",
  "dist",
  "build",
]);

const presetGroups = new Set(["apps", "packages"]);
const allowedConfigs = ["vitest.config.mts", "vitest.config.ts"];
const anyViteConfig = /^vite(?:st)?\.(?:config|workspace)\.[cm]?[jt]s$/;
const importsPreset = /from\s+["']@bricx\/vitest-config["']/;
const callsPreset = /\b(?:defaultPreset|swcPreset)\s*\(/;
// `--config`/`-c` swaps the preset out; the rest turn coverage off.
const bypassFlag =
  /(?:^|\s)(?:--config|-c|--dir|--root|-r|--no-coverage|--coverage\.enabled(?:=|\s+)false|--coverage=false)(?:[=\s]|$)/;

/**
 * Problems with how a package under apps/ or packages/ runs Vitest.
 * @param {string} dir
 * @param {string | undefined} testScript
 * @returns {Promise<string[]>}
 */
async function presetProblems(dir, testScript) {
  /** @type {string[]} */
  const problems = [];
  const names = (await readdir(dir)).filter((n) => anyViteConfig.test(n));
  const configs = names.filter((n) => allowedConfigs.includes(n));
  const others = names.filter((n) => !allowedConfigs.includes(n));
  if (others.length > 0) {
    problems.push(
      `has ${others.join(", ")}; use only vitest.config.mts or vitest.config.ts`,
    );
  }
  if (configs.length !== 1) {
    problems.push(
      configs.length === 0
        ? "has no vitest.config.mts or vitest.config.ts"
        : `has both ${configs.join(" and ")}`,
    );
  }
  for (const config of configs) {
    const source = await readFile(path.join(dir, config), "utf8");
    if (!importsPreset.test(source) || !callsPreset.test(source)) {
      problems.push(
        `${config} must import @bricx/vitest-config and call defaultPreset or swcPreset`,
      );
    }
  }
  if (testScript && bypassFlag.test(testScript)) {
    problems.push(
      `test script "${testScript}" bypasses the preset (another config or coverage off)`,
    );
  }
  return problems;
}

/** @typedef {{ name?: string, scripts?: Record<string, string> }} PackageJson */

/** @type {string[]} */
const failures = [];
let checked = 0;
for (const [group, required] of Object.entries(requiredByGroup)) {
  const entries = await readdir(path.join(root, group), {
    withFileTypes: true,
  });
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const manifest = path.join(root, group, entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    /** @type {unknown} */
    const parsed = JSON.parse(await readFile(manifest, "utf8"));
    const pkg = /** @type {PackageJson} */ (parsed);
    checked += 1;
    const missing = required.filter((script) => !pkg.scripts?.[script]?.trim());
    const label = `${group}/${entry.name} (${pkg.name ?? "unnamed"})`;
    if (missing.length > 0) {
      failures.push(`${label}: missing ${missing.join(", ")}`);
    }
    if (presetGroups.has(group)) {
      const dir = path.join(root, group, entry.name);
      for (const problem of await presetProblems(dir, pkg.scripts?.test)) {
        failures.push(`${label}: ${problem}`);
      }
    }
  }
}

/**
 * package.json and Vitest/Vite config files at any depth, outside
 * node_modules and build output.
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* configFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirs.has(entry.name)) {
        yield* configFiles(path.join(dir, entry.name));
      }
    } else if (configFile.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

let scanned = 0;
for await (const file of configFiles(root)) {
  scanned += 1;
  if ((await readFile(file, "utf8")).includes(noTestsOption)) {
    failures.push(
      `${path.relative(root, file)}: uses ${noTestsOption}; a test run must fail when it finds no tests`,
    );
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error(
    "\ncheck:workspace FAILED: apps/ and packages/ need typecheck, lint and test scripts and a vitest config using @bricx/vitest-config; tooling/ needs typecheck and lint; no pass-on-no-tests anywhere",
  );
  process.exit(1);
}
console.log(
  `check:workspace passed: ${String(checked)} packages have their required scripts (apps/ and packages/ also run tests through @bricx/vitest-config); ${String(scanned)} config files free of ${noTestsOption}`,
);
