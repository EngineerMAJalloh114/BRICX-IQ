// The pinned gitleaks release (ADR 0030). gitleaks is a Go binary, not an npm
// package: `pnpm tools:gitleaks` downloads it into .tools/ (gitignored) and
// the pre-commit hook refuses to run without it. To bump: change the version
// and both hashes together, take the archive hash from the release's
// gitleaks_<version>_checksums.txt, and update docs/DEPENDENCIES.md (§7).
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export const root = path.resolve(import.meta.dirname, "..");

export const gitleaks = {
  version: "8.30.1",
  // Only Linux x64 (WSL included) is pinned and tested (ADR 0030).
  platform: "linux-x64",
  archive: "gitleaks_8.30.1_linux_x64.tar.gz",
  // From gitleaks_8.30.1_checksums.txt, release v8.30.1.
  archiveSha256:
    "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  // The `gitleaks` file inside that archive.
  binarySha256:
    "88f91962aa2f93ac6ab281d553b9e125f5197bbbce38f9f2437f7299c32e5509",
};

export const downloadUrl = `https://github.com/gitleaks/gitleaks/releases/download/v${gitleaks.version}/${gitleaks.archive}`;

export const binaryPath = path.join(
  root,
  ".tools",
  "gitleaks",
  gitleaks.version,
  "gitleaks",
);

export const installHint = "Install it with: pnpm tools:gitleaks";

/** @param {Buffer} data */
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/** @returns {string | undefined} why this platform cannot run the pin */
export function platformProblem() {
  const current = `${process.platform}-${process.arch}`;
  if (current === gitleaks.platform) return undefined;
  return `gitleaks is pinned for ${gitleaks.platform} only, and this machine is ${current}. Commit from WSL or Linux x64 (ADR 0030).`;
}

/** @returns {Promise<string | undefined>} why the installed binary is unusable */
export async function binaryProblem() {
  const platform = platformProblem();
  if (platform) return platform;
  if (!existsSync(binaryPath)) {
    return `gitleaks ${gitleaks.version} is not installed at ${path.relative(root, binaryPath)}.`;
  }
  const actual = sha256(await readFile(binaryPath));
  if (actual !== gitleaks.binarySha256) {
    return `gitleaks at ${path.relative(root, binaryPath)} has SHA-256 ${actual}, expected ${gitleaks.binarySha256} (corrupt or replaced).`;
  }
  return undefined;
}
