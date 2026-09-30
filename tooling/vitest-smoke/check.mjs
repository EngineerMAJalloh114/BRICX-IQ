// Runs every fixture under fixtures/ in its own `vitest run --coverage` with
// the real @bricx/vitest-config presets and compares each outcome (exit code
// and output) with expected.json. Fails when an outcome differs, when a
// fixture has no expected entry, when an entry has no fixture, or when vitest
// runs on a different vite than the one @bricx/vitest-config pins.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = import.meta.dirname;
const fixturesDir = path.join(here, "fixtures");
const vitestBin = path.join(
  path.dirname(fileURLToPath(import.meta.resolve("vitest/package.json"))),
  "vitest.mjs",
);

/**
 * @typedef {{ fixture: string, why: string, exitCode: number,
 *   includes: string[], excludes: string[] }} Expectation
 */

/** @type {unknown} */
const expectedJson = JSON.parse(
  await readFile(path.join(here, "expected.json"), "utf8"),
);
const expected = /** @type {Expectation[]} */ (expectedJson);

/** Every directory under fixtures/ that holds a vitest config. */
async function findFixtures() {
  const entries = await readdir(fixturesDir, {
    recursive: true,
    withFileTypes: true,
  });
  return entries
    .filter((e) => e.isFile() && e.name === "vitest.config.mts")
    .map((e) =>
      path.relative(fixturesDir, e.parentPath).split(path.sep).join("/"),
    )
    .sort();
}

// Strip ANSI colour codes so the text matches whatever the terminal is.
const ansi = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

/** @param {string} fixture */
function run(fixture) {
  // Do not let a parent vitest run leak its state into the child.
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST")),
    ),
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  };
  const result = spawnSync(
    process.execPath,
    [vitestBin, "run", "--coverage", "--coverage.reporter=text"],
    { cwd: path.join(fixturesDir, fixture), env, encoding: "utf8" },
  );
  return {
    exitCode: result.status,
    output: `${result.stdout}\n${result.stderr}`.replace(ansi, ""),
  };
}

/** @type {string[]} */
const problems = [];

// vite is a peer of vitest that pnpm installs on its own; the pin in
// @bricx/vitest-config only holds if vitest resolves that same version.
/** @typedef {{ version?: string, dependencies?: Record<string, string> }} Manifest */
/** @param {string} file */
function readManifest(file) {
  /** @type {unknown} */
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return /** @type {Manifest} */ (parsed);
}
const pinnedVite = readManifest(
  fileURLToPath(import.meta.resolve("@bricx/vitest-config/package.json")),
).dependencies?.vite;
const vitestVite = readManifest(
  createRequire(vitestBin).resolve("vite/package.json"),
).version;
if (pinnedVite !== vitestVite) {
  problems.push(
    `VITE MISMATCH  vitest uses vite ${String(vitestVite)}, @bricx/vitest-config pins ${String(pinnedVite)}`,
  );
} else {
  console.log(`ok  vitest runs on the pinned vite ${String(pinnedVite)}`);
}

const fixtures = await findFixtures();
const listed = new Set(expected.map((e) => e.fixture));
for (const fixture of fixtures) {
  if (!listed.has(fixture)) problems.push(`NO EXPECTATION  ${fixture}`);
}

for (const e of expected) {
  if (!existsSync(path.join(fixturesDir, e.fixture, "vitest.config.mts"))) {
    problems.push(`MISSING FIXTURE  ${e.fixture}`);
    continue;
  }
  const { exitCode, output } = run(e.fixture);
  /** @type {string[]} */
  const wrong = [];
  if (exitCode !== e.exitCode) {
    wrong.push(`exit ${String(exitCode)}, expected ${String(e.exitCode)}`);
  }
  for (const text of e.includes) {
    if (!output.includes(text)) wrong.push(`output lacks "${text}"`);
  }
  for (const text of e.excludes) {
    if (output.includes(text)) wrong.push(`output contains "${text}"`);
  }
  if (wrong.length > 0) {
    problems.push(`WRONG  ${e.fixture}: ${wrong.join("; ")}\n${output}`);
    continue;
  }
  const verdict = e.exitCode === 0 ? "passes" : "fails";
  console.log(`ok  ${e.fixture}  ${verdict} as expected: ${e.why}`);
}

console.log(
  `\n${String(fixtures.length)} fixtures, ${String(expected.length)} expected outcomes`,
);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`\nvitest-smoke FAILED: ${String(problems.length)} problem(s)`);
  process.exit(1);
}
console.log("vitest-smoke passed: every fixture had its expected outcome");
