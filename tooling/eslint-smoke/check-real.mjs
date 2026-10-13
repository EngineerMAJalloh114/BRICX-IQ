// Proves the @bricx/ids rules on the real workspace layout, not only on the
// fixture copy (P1-03 left this to P3; P3-01, ADR 0041). Lints probe text
// with the repository's own eslint.config.mjs at real paths in packages/ids:
// the source path must report exactly the expected errors, and the test path
// none of them. The import of packages/config resolves to the real package
// on disk. The cross-package proof through pnpm links comes with P3-02,
// the first package that depends on @bricx/ids.
import path from "node:path";
import process from "node:process";
import { ESLint } from "eslint";

const repoRoot = path.resolve(import.meta.dirname, "../..");

const probe = `import { randomUUID } from "node:crypto";
import { version } from "typescript";
import { loadApiConfig } from "../../config/src/api.js";

export const probes = [randomUUID, version, loadApiConfig];
export const now = Date.now();
export const roll = Math.random();
`;

/** @typedef {{ line: number, ruleId: string | null, message: string }} Finding */

/** @type {{ file: string, expected: Finding[] }[]} */
const cases = [
  {
    file: "packages/ids/src/uuid-v7.ts",
    expected: [
      {
        line: 1,
        ruleId: "boundaries/dependencies",
        message:
          'module with origin "core" are not allowed in elements of type "ids"',
      },
      {
        line: 2,
        ruleId: "boundaries/dependencies",
        message:
          'module with origin "external" are not allowed in elements of type "ids"',
      },
      {
        line: 3,
        ruleId: "boundaries/dependencies",
        message:
          'Dependencies to elements of type "package" are not allowed in elements of type "ids"',
      },
      {
        line: 6,
        ruleId: "no-restricted-properties",
        message: "Domain and id code must not read the real clock",
      },
      {
        line: 7,
        ruleId: "no-restricted-properties",
        message: "Domain and id code must not use Math.random",
      },
    ],
  },
  // Tests may use Node, npm modules, the real clock and other packages.
  { file: "packages/ids/test/generator.test.ts", expected: [] },
];

const eslint = new ESLint({ cwd: repoRoot });
/** @type {string[]} */
const problems = [];

for (const { file, expected } of cases) {
  const [result] = await eslint.lintText(probe, {
    filePath: path.join(repoRoot, file),
  });
  /** @type {Finding[]} */
  const actual = (result?.messages ?? []).map((m) => ({
    line: m.line,
    ruleId: m.ruleId,
    message: m.message,
  }));
  if (result === undefined) problems.push(`${file}: no lint result`);
  for (const e of expected) {
    const index = actual.findIndex(
      (a) =>
        a.line === e.line &&
        a.ruleId === e.ruleId &&
        a.message.includes(e.message),
    );
    if (index === -1) {
      problems.push(
        `MISSING  ${file}:${String(e.line)} ${e.ruleId ?? ""} "${e.message}"`,
      );
      continue;
    }
    actual.splice(index, 1);
    console.log(`ok  ${file}:${String(e.line)}  ${e.ruleId ?? ""}`);
  }
  for (const a of actual) {
    problems.push(
      `UNEXPECTED  ${file}:${String(a.line)} ${a.ruleId ?? "(fatal)"} ${a.message}`,
    );
  }
}

if (problems.length > 0) {
  for (const p of problems) console.error(p);
  console.error(
    `\neslint-smoke real-workspace check FAILED: ${String(problems.length)} problem(s)`,
  );
  process.exit(1);
}
console.log(
  "eslint-smoke real-workspace check passed: the ids rules fire at the real packages/ids/src path and not in its tests",
);
