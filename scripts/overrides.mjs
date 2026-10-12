// Reads this repository's pnpm overrides and checks them (ADR 0038): used by
// check:workspace (the guard) and by `pnpm audit:prod`, which prints each
// override with its ADR before the audit runs.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { overrideProblems, workspaceOverrides } from "./guards.mjs";

/** @param {string} root */
export async function repoOverrides(root) {
  const read = (/** @type {string} */ file) =>
    readFile(path.join(root, file), "utf8");
  const adrs = await Promise.all(
    (await readdir(path.join(root, "docs/adr")))
      .filter((file) => /^\d{4}-.*\.md$/.test(file))
      .map(async (file) => ({
        file: `docs/adr/${file}`,
        text: await read(`docs/adr/${file}`),
      })),
  );
  const workspaceYaml = await read("pnpm-workspace.yaml");
  /** @type {unknown} */
  const manifest = JSON.parse(await read("package.json"));
  const problems = overrideProblems({
    workspaceYaml,
    manifest:
      /** @type {Parameters<typeof overrideProblems>[0]["manifest"]} */ (
        manifest
      ),
    adrs,
    dependenciesMd: await read("docs/DEPENDENCIES.md"),
    lockfile: await read("pnpm-lock.yaml"),
  });
  const { overrides } = workspaceOverrides(workspaceYaml);
  return {
    overrides: [...overrides].map(([name, version]) => ({
      name,
      version,
      adr:
        adrs.find((adr) =>
          adr.text.includes(`- Override: \`${name}\` ${version}`),
        )?.file ?? "no ADR",
    })),
    problems,
  };
}
