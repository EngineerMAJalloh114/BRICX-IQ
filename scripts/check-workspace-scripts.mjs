// Fails when a workspace package lacks a script `pnpm verify` depends on:
// every package under apps/, packages/ and tooling/ needs `typecheck` and
// `lint`; apps/ and packages/ also need `test` (tooling/ is proven by its
// smoke packages instead). Also fails if Vitest's pass-on-no-tests option
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
    if (missing.length > 0) {
      failures.push(
        `${group}/${entry.name} (${pkg.name ?? "unnamed"}): missing ${missing.join(", ")}`,
      );
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
    "\ncheck:workspace FAILED: apps/ and packages/ need typecheck, lint and test scripts; tooling/ needs typecheck and lint; no pass-on-no-tests anywhere",
  );
  process.exit(1);
}
console.log(
  `check:workspace passed: ${String(checked)} packages have their required scripts; ${String(scanned)} config files free of ${noTestsOption}`,
);
