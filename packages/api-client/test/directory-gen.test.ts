// P6-01 (ADR 0071, owner condition C6): resolveCell() lives in
// src/directory.ts, outside src/generated/, the folder orval cleans and
// rewrites on every `pnpm gen:api`. This test runs orval with the
// package's own config on a copy of the package (so the committed files
// are never touched while other suites read them) and proves that
// src/directory.ts survives byte for byte, that the generated client is
// reproduced exactly, and (the control) that a file placed inside
// src/generated/ is deleted.
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const packageDir = path.resolve(import.meta.dirname, "..");
const orvalBin = path.join(packageDir, "node_modules/orval/dist/bin/orval.mjs");
let copy: string;

beforeAll(() => {
  // Inside the package, so the config's `import "orval"` resolves.
  copy = mkdtempSync(path.join(packageDir, ".orval-check-"));
  for (const entry of ["orval.config.ts", "openapi.json", "src"]) {
    cpSync(path.join(packageDir, entry), path.join(copy, entry), {
      recursive: true,
    });
  }
  writeFileSync(
    path.join(copy, "src/generated/stray.ts"),
    "export const stray = 1;\n",
  );
  execFileSync(process.execPath, [orvalBin, "--config", "./orval.config.ts"], {
    cwd: copy,
    stdio: "pipe",
  });
}, 120_000);
afterAll(() => {
  rmSync(copy, { recursive: true, force: true });
});

describe("gen:api leaves resolveCell intact (C6)", () => {
  test("src/directory.ts is outside the folder orval writes", () => {
    const config = readFileSync(
      path.join(packageDir, "orval.config.ts"),
      "utf8",
    );
    expect(config).toContain('target: "./src/generated/client.ts"');
    expect(config).toContain("clean: true");
    expect(existsSync(path.join(packageDir, "src/directory.ts"))).toBe(true);
    expect(
      existsSync(path.join(packageDir, "src/generated/directory.ts")),
    ).toBe(false);
  });

  test("after orval runs, src/directory.ts is byte for byte the same", () => {
    expect(readFileSync(path.join(copy, "src/directory.ts"))).toEqual(
      readFileSync(path.join(packageDir, "src/directory.ts")),
    );
  });

  test("the generated client is reproduced exactly (the committed one is current)", () => {
    expect(
      readFileSync(path.join(copy, "src/generated/client.ts"), "utf8"),
    ).toBe(
      readFileSync(path.join(packageDir, "src/generated/client.ts"), "utf8"),
    );
  });

  test("control: a file inside src/generated/ is deleted by the same run", () => {
    expect(existsSync(path.join(copy, "src/generated/stray.ts"))).toBe(false);
  });
});
