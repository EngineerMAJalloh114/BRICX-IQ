// Called by .husky/pre-commit (ADR 0030) and by CI (ADR 0031). Fails closed:
//   --check     exits 1 unless the pinned gitleaks binary is installed and its
//               SHA-256 matches the pin (runs before lint-staged).
//   --scan      checks again, then scans the staged changes; any finding or
//               error exits non-zero and blocks the commit. Output is redacted.
//   --history   (CI) scans every commit reachable from HEAD; fails on a
//               shallow clone, on zero commits, or on any finding.
//   --selftest  (CI) generates a fake GitHub token at runtime, commits it in
//               a throwaway repo under the OS temp dir (never this repo), and
//               fails unless the pinned gitleaks reports it.
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import {
  binaryPath,
  binaryProblem,
  installHint,
  root,
} from "./gitleaks-pin.mjs";

const mode = process.argv[2];
const modes = ["--check", "--scan", "--history", "--selftest"];
if (mode === undefined || !modes.includes(mode)) {
  console.error(
    "usage: node scripts/gitleaks-staged.mjs --check | --scan | --history | --selftest",
  );
  process.exit(2);
}

const problem = await binaryProblem();
if (problem) {
  console.error(
    `\npre-commit BLOCKED: ${problem}\n${installHint}\nSecret scanning is required for every commit; there is no skip.\n`,
  );
  process.exit(1);
}

if (mode === "--scan") {
  const result = spawnSync(
    binaryPath,
    ["git", "--staged", "--redact", "--no-banner", "--exit-code", "1", "."],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error(
      `\npre-commit BLOCKED: gitleaks found a secret in the staged changes, or could not scan (exit ${String(result.status ?? result.signal)}). Remove the secret from the staged files and commit again.\n`,
    );
    process.exit(1);
  }
}

/**
 * @param {string[]} args
 * @param {string} cwd
 */
function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    console.error(`git ${args.join(" ")} failed: ${result.stderr}`);
    process.exit(1);
  }
  return result.stdout.trim();
}

if (mode === "--history") {
  if (git(["rev-parse", "--is-shallow-repository"], root) !== "false") {
    console.error(
      "gitleaks --history: the clone is shallow; check out with fetch-depth: 0 so every commit is scanned.",
    );
    process.exit(1);
  }
  const commits = Number(git(["rev-list", "--count", "HEAD"], root));
  if (!(commits > 0)) {
    console.error("gitleaks --history: no commits reachable from HEAD.");
    process.exit(1);
  }
  console.log(
    `gitleaks --history: scanning ${String(commits)} commits reachable from HEAD`,
  );
  const result = spawnSync(
    binaryPath,
    [
      "git",
      "--log-opts=--full-history HEAD",
      "--redact",
      "--no-banner",
      "--exit-code",
      "1",
      ".",
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) {
    console.error(
      `gitleaks --history: a secret was found in the history, or the scan failed (exit ${String(result.status ?? result.signal)}).`,
    );
    process.exit(1);
  }
}

if (mode === "--selftest") {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const fakeToken = `ghp_${[...randomBytes(36)].map((b) => alphabet[b % alphabet.length]).join("")}`;
  const temp = await mkdtemp(
    path.join(os.tmpdir(), "bricx-gitleaks-selftest-"),
  );
  try {
    git(["init", "-q"], temp);
    await writeFile(
      path.join(temp, "config.env"),
      `GITHUB_TOKEN=${fakeToken}\n`,
    );
    git(["add", "config.env"], temp);
    git(
      [
        "-c",
        "user.name=selftest",
        "-c",
        "user.email=selftest@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "-m",
        "selftest",
      ],
      temp,
    );
    const report = path.join(temp, "report.json");
    const result = spawnSync(
      binaryPath,
      [
        "git",
        "--redact",
        "--no-banner",
        "--exit-code",
        "1",
        "--report-format",
        "json",
        "--report-path",
        report,
        ".",
      ],
      { cwd: temp, stdio: "inherit" },
    );
    /** @type {unknown} */
    const parsed = JSON.parse(await readFile(report, "utf8"));
    const findings = /** @type {{ RuleID?: string }[]} */ (parsed);
    const caught = findings.some((f) => f.RuleID === "github-pat");
    if (result.status !== 1 || !caught) {
      console.error(
        `gitleaks --selftest FAILED: a runtime-generated fake GitHub token was not reported (exit ${String(result.status ?? result.signal)}, rules ${JSON.stringify(findings.map((f) => f.RuleID))}).`,
      );
      process.exit(1);
    }
    console.log(
      "gitleaks --selftest passed: the pinned gitleaks caught a runtime-generated fake GitHub token (github-pat) in a throwaway repo.",
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
