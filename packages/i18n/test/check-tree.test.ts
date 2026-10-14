// i18n:check end to end (P3-03 ruling): one fixture per failure, each run
// in-process through checkTree and, for the exit codes, through the real
// CLI. The real package tree must pass.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { checkTree } from "../scripts/i18n-check-lib.mjs";
import { buildCase, fixturesDir, withoutKey } from "./check-fixtures.ts";

const pkgDir = path.join(import.meta.dirname, "..");
const cli = path.join(pkgDir, "scripts/i18n-check.mjs");
const expected = JSON.parse(
  readFileSync(path.join(fixturesDir, "expected.json"), "utf8"),
) as Record<string, string[]>;

describe("i18n:check fixtures", () => {
  it("every fixture directory has an expectation and vice versa", async () => {
    const dirs = (await readdir(fixturesDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory() && d.name !== "_base")
      .map((d) => d.name)
      .sort();
    expect(dirs).toEqual(Object.keys(expected).sort());
  });

  it.each(Object.entries(expected))("%s", async (name, lines) => {
    const { root, cleanup } = await buildCase(name);
    try {
      const result = await checkTree(root);
      expect(result.lines.map(withoutKey).sort()).toEqual([...lines].sort());
    } finally {
      await cleanup();
    }
  });

  it("problem lines never contain message text", async () => {
    const { root, cleanup } = await buildCase("empty");
    try {
      const result = await checkTree(root);
      expect(result.lines.join("\n")).not.toContain("Enregistrer");
    } finally {
      await cleanup();
    }
    const tooLong = await buildCase("too-long");
    try {
      const result = await checkTree(tooLong.root);
      expect(result.lines.join("\n")).not.toContain("SSSS");
    } finally {
      await tooLong.cleanup();
    }
  });
});

describe("the CLI", () => {
  it("exits 0 on the base fixture", async () => {
    const { root, cleanup } = await buildCase("ok");
    try {
      const run = spawnSync(process.execPath, [cli, "--root", root], {
        encoding: "utf8",
      });
      expect(run.stderr).toBe("");
      expect(run.stdout).toMatch(/^i18n:check passed: /u);
      expect(run.status).toBe(0);
    } finally {
      await cleanup();
    }
  });

  it.each([
    "missing-key",
    "extra-key",
    "placeholder-type",
    "plural-arms-ar",
    "empty",
    "too-long",
    "stale-generated",
  ])("exits 1 on %s and names the problem", async (name) => {
    const { root, cleanup } = await buildCase(name);
    try {
      const run = spawnSync(process.execPath, [cli, "--root", root], {
        encoding: "utf8",
      });
      expect(run.status).toBe(1);
      for (const line of expected[name] ?? [])
        expect(run.stderr).toContain(line);
      expect(run.stderr).toMatch(/i18n:check FAILED: \d+ problem/u);
    } finally {
      await cleanup();
    }
  });

  it("exits 2 on an unknown flag", () => {
    const run = spawnSync(process.execPath, [cli, "--bogus"], {
      encoding: "utf8",
    });
    expect(run.status).toBe(2);
  });

  it("passes on the real package tree", () => {
    const out = execFileSync(process.execPath, [cli], {
      cwd: pkgDir,
      encoding: "utf8",
    });
    expect(out).toMatch(
      /^i18n:check passed: 3 locales x 6 namespaces, \d+ keys, \d+ glossary terms/u,
    );
  });
});
