// Reads this repository's audit ignores and checks them (ADR 0037): used by
// check:workspace (the guard) and by `pnpm audit:prod`, which prints each
// ignore with its ADR before the audit runs.
import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { auditIgnoreProblems } from "./guards.mjs";

/**
 * @param {string} root
 * @param {string} today YYYY-MM-DD (UTC)
 */
export async function repoAuditIgnores(root, today) {
  const adrDir = path.join(root, "docs/adr");
  const adrs = await Promise.all(
    (await readdir(adrDir))
      .filter((file) => /^\d{4}-.*\.md$/.test(file))
      .map(async (file) => ({
        file: `docs/adr/${file}`,
        text: await readFile(path.join(adrDir, file), "utf8"),
      })),
  );
  /** @type {unknown} */
  const manifest = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  /** @type {unknown} */
  const importers = JSON.parse(
    execFileSync(
      "pnpm",
      ["ls", "-r", "--prod", "--depth", "Infinity", "--json"],
      { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
    ),
  );
  return auditIgnoreProblems({
    workspaceYaml: await readFile(
      path.join(root, "pnpm-workspace.yaml"),
      "utf8",
    ),
    packageJsonPnpm: /** @type {{ pnpm?: unknown }} */ (manifest).pnpm,
    npmrc: await readFile(path.join(root, ".npmrc"), "utf8"),
    adrs,
    importers: /** @type {import("./guards.mjs").PnpmLsImporter[]} */ (
      importers
    ),
    root,
    today,
  });
}
