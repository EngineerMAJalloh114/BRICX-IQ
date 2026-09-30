// Lints fixtures/ with the real @bricx/eslint-config and compares the result
// with expected.json. Fails when an expected error is missing, when any other
// error or warning appears (including parse errors), or when a fixture tries
// to silence a rule with an eslint-disable comment.
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { bricxConfig } from "@bricx/eslint-config";
import { ESLint } from "eslint";

const here = import.meta.dirname;
const fixturesDir = path.join(here, "fixtures");

/** @typedef {{ file: string, line: number, ruleId: string | null, message: string }} Finding */

/** @type {unknown} */
const expectedJson = JSON.parse(
  await readFile(path.join(here, "expected.json"), "utf8"),
);
const expected = /** @type {Finding[]} */ (expectedJson);

const eslint = new ESLint({
  cwd: fixturesDir,
  overrideConfigFile: true,
  overrideConfig: bricxConfig({
    rootDir: fixturesDir,
    tsconfigRootDir: here,
    tsconfigs: [path.join(here, "tsconfig.json")],
  }),
});
const results = await eslint.lintFiles(["."]);

/** @type {Finding[]} */
const actual = [];
/** @type {string[]} */
const problems = [];
for (const result of results) {
  const file = path
    .relative(fixturesDir, result.filePath)
    .split(path.sep)
    .join("/");
  const source = await readFile(result.filePath, "utf8");
  if (/eslint-(?:disable|enable)|\/\*\s*eslint\s/.test(source)) {
    problems.push(`${file}: fixtures must not contain eslint directives`);
  }
  for (const m of result.messages) {
    actual.push({ file, line: m.line, ruleId: m.ruleId, message: m.message });
  }
}

/**
 * @param {Finding} e
 * @param {Finding} a
 */
const matches = (e, a) =>
  e.file === a.file &&
  e.line === a.line &&
  e.ruleId === a.ruleId &&
  a.message.includes(e.message);

const unmatched = [...actual];
for (const e of expected) {
  const index = unmatched.findIndex((a) => matches(e, a));
  if (index === -1) {
    problems.push(
      `MISSING  ${e.file}:${String(e.line)} ${e.ruleId ?? ""} "${e.message}"`,
    );
    continue;
  }
  const [hit] = unmatched.splice(index, 1);
  console.log(
    `ok  ${e.file}:${String(e.line)}  ${e.ruleId ?? ""}  ${hit?.message ?? ""}`,
  );
}
for (const a of unmatched) {
  problems.push(
    `UNEXPECTED  ${a.file}:${String(a.line)} ${a.ruleId ?? "(fatal)"} ${a.message}`,
  );
}

console.log(
  `\n${String(results.length)} fixture files, ${String(expected.length)} expected errors`,
);
if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(`\neslint-smoke FAILED: ${String(problems.length)} problem(s)`);
  process.exit(1);
}
console.log(
  "eslint-smoke passed: every rule fired where expected and nowhere else",
);
