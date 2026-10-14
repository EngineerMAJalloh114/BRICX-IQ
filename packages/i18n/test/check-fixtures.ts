// Builds an i18n:check tree in a temporary directory: the _base fixture,
// then a case's files on top, then the paths its _delete.txt lists.
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LIMITS } from "../src/limits.ts";

export const fixturesDir = path.join(import.meta.dirname, "fixtures/check");

export async function buildCase(
  name: string,
): Promise<{ root: string; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(path.join(tmpdir(), `i18n-check-${name}-`));
  await cp(path.join(fixturesDir, "_base"), root, { recursive: true });
  const caseDir = path.join(fixturesDir, name);
  await cp(caseDir, root, {
    recursive: true,
    filter: (src) => !/(?:_delete|README)\.txt$/u.test(src),
  });
  const deletions = path.join(caseDir, "_delete.txt");
  if (existsSync(deletions)) {
    for (const rel of (await readFile(deletions, "utf8"))
      .split("\n")
      .filter(Boolean)) {
      await rm(path.join(root, rel));
    }
  }
  if (name === "file-too-large") {
    const file = path.join(root, "locales/en/common.json");
    const text = await readFile(file, "utf8");
    await writeFile(file, text + " ".repeat(LIMITS.catalogBytes));
  }
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

/** "locales/fr/common.json: missing_key status" -> "locales/fr/common.json: missing_key" */
export const withoutKey = (line: string) =>
  line.split(" ").slice(0, 2).join(" ");
