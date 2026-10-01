// `pnpm tools:gitleaks`: downloads the pinned gitleaks release, checks the
// archive and the extracted binary against the SHA-256 pins in
// gitleaks-pin.mjs, and only then installs it into .tools/ (ADR 0030).
// On any mismatch it exits 1 and writes nothing to .tools/.
import { execFileSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  binaryPath,
  binaryProblem,
  downloadUrl,
  gitleaks,
  platformProblem,
  root,
  sha256,
} from "./gitleaks-pin.mjs";

/** @param {string} message */
function refuse(message) {
  console.error(`install-gitleaks: ${message}\nRefusing to install.`);
  process.exit(1);
}

const platform = platformProblem();
if (platform) refuse(platform);

if ((await binaryProblem()) === undefined) {
  console.log(
    `gitleaks ${gitleaks.version} already installed and verified at ${path.relative(root, binaryPath)}`,
  );
  process.exit(0);
}

console.log(`Downloading ${downloadUrl}`);
const response = await fetch(downloadUrl);
if (!response.ok) {
  refuse(`download failed: HTTP ${String(response.status)}`);
}
const archive = Buffer.from(await response.arrayBuffer());
const archiveHash = sha256(archive);
if (archiveHash !== gitleaks.archiveSha256) {
  refuse(
    `checksum mismatch for ${gitleaks.archive}: got ${archiveHash}, expected ${gitleaks.archiveSha256}.`,
  );
}

const temp = await mkdtemp(path.join(os.tmpdir(), "bricx-gitleaks-"));
try {
  const archiveFile = path.join(temp, gitleaks.archive);
  await writeFile(archiveFile, archive);
  execFileSync("tar", ["-xzf", archiveFile, "-C", temp, "gitleaks"]);
  const extracted = path.join(temp, "gitleaks");
  const binaryHash = sha256(await readFile(extracted));
  if (binaryHash !== gitleaks.binarySha256) {
    refuse(
      `checksum mismatch for the extracted binary: got ${binaryHash}, expected ${gitleaks.binarySha256}.`,
    );
  }
  await mkdir(path.dirname(binaryPath), { recursive: true });
  await copyFile(extracted, binaryPath);
  await chmod(binaryPath, 0o755);
} finally {
  await rm(temp, { recursive: true, force: true });
}

const problem = await binaryProblem();
if (problem) refuse(problem);
console.log(
  `gitleaks ${gitleaks.version} installed and verified at ${path.relative(root, binaryPath)}`,
);
