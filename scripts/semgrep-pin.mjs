// The pinned Semgrep image and the exact way it runs (ADR 0043, amending
// ADR 0032). Semgrep runs from the Docker image pinned by digest, with no
// network, against the rules written for this repo in tooling/semgrep/rules
// (never registry rules). check:workspace (guards.mjs semgrepProblems) fails
// if anything here changes without the matching docs/DEPENDENCIES.md §7 row,
// or if a flag below is dropped. To bump: pick a version at least 7 days old,
// take the image index digest and the linux/amd64 digest from Docker Hub,
// change all three together and update the §7 row.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");

export const semgrep = {
  image: "semgrep/semgrep",
  version: "1.179.0",
  // Multi-arch image index (what `docker pull` resolves); pushed
  // 2026-10-02T00:02:27Z.
  indexDigest:
    "sha256:93963d9295a366f59e4850127b1550400ee7b388f04fe144e4a1f6325d96e01b",
  // The linux/amd64 image inside that index (CI runners and WSL).
  amd64Digest:
    "sha256:cab19964e6c93019934252a9cd591d9b27df1e5b5d1734b26f4069ae51c295f8",
};

export const imageRef = `${semgrep.image}:${semgrep.version}@${semgrep.indexDigest}`;

export const rulesDir = path.join(root, "tooling", "semgrep", "rules");
export const manifestPath = path.join(
  root,
  "tooling",
  "semgrep",
  "MANIFEST.json",
);
export const selftestDir = path.join(root, "tooling", "semgrep", "selftest");

/**
 * `docker run` options before the image. No network: rules can only come
 * from the read-only /rules mount, never from the registry. Every mount is
 * read-only.
 * @param {string} target host directory scanned, mounted at /src
 */
export const dockerArgs = (target) => [
  "run",
  "--rm",
  "--network",
  "none",
  "-v",
  `${rulesDir}:/rules:ro`,
  "-v",
  `${target}:/src:ro`,
  "-w",
  "/src",
];

/** Flags for every Semgrep run (scan and self-test). */
export const baseArgs = [
  "semgrep",
  "scan",
  "--config",
  "/rules",
  "--metrics=off",
  "--disable-version-check",
  "--strict",
];

/** The repository scan: any finding fails the run. */
export const scanArgs = [...baseArgs, "--error", "."];

/** The self-test reads findings as JSON and compares them itself. */
export const selftestArgs = [...baseArgs, "--json", "."];

/** @param {Buffer | string} data */
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

/**
 * The rule files and their contents, by file name.
 * @returns {Promise<Record<string, string>>}
 */
export async function readRuleFiles() {
  /** @type {Record<string, string>} */
  const files = {};
  for (const name of (await readdir(rulesDir)).sort()) {
    files[name] = await readFile(path.join(rulesDir, name), "utf8");
  }
  return files;
}
