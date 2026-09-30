// Fails when a workspace package under apps/, packages/ or tooling/ has no
// `typecheck` or `lint` script, so no package can drop out of `pnpm verify`.
// A folder without package.json is a placeholder, not a package.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
const groups = ["apps", "packages", "tooling"];
const required = ["typecheck", "lint"];

/** @typedef {{ name?: string, scripts?: Record<string, string> }} PackageJson */

/** @type {string[]} */
const failures = [];
let checked = 0;
for (const group of groups) {
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

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error(
    `\ncheck:workspace FAILED: every workspace package needs ${required.join(" and ")} scripts`,
  );
  process.exit(1);
}
console.log(
  `check:workspace passed: ${String(checked)} packages have ${required.join(" and ")} scripts`,
);
