// Writes and checks the committed generated/ files (ADR 0048). The
// generators are pure (src/generate.ts); this file does the file I/O.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { GENERATED_FILES, generateAll } from "../src/generate.ts";

/**
 * Compares `dir` with the generators' output.
 * @param {string} dir
 * @returns {Promise<string[]>} "missing:<file>" or "stale:<file>" per problem
 */
export async function checkGenerated(dir) {
  const expected = generateAll();
  /** @type {string[]} */
  const problems = [];
  for (const file of GENERATED_FILES) {
    let actual;
    try {
      actual = await readFile(path.join(dir, file), "utf8");
    } catch {
      problems.push(`missing:${file}`);
      continue;
    }
    if (actual !== expected[file]) problems.push(`stale:${file}`);
  }
  return problems;
}

/**
 * Writes every generated file into `dir`.
 * @param {string} dir
 * @returns {Promise<readonly string[]>} the files written
 */
export async function writeGenerated(dir) {
  const files = generateAll();
  for (const file of GENERATED_FILES) {
    await writeFile(path.join(dir, file), files[file]);
  }
  return GENERATED_FILES;
}
