// Called by .husky/pre-commit (ADR 0030). Fails closed:
//   --check  exits 1 unless the pinned gitleaks binary is installed and its
//            SHA-256 matches the pin (runs before lint-staged).
//   --scan   checks again, then scans the staged changes; any finding or
//            error exits non-zero and blocks the commit. Output is redacted.
import { spawnSync } from "node:child_process";
import process from "node:process";
import {
  binaryPath,
  binaryProblem,
  installHint,
  root,
} from "./gitleaks-pin.mjs";

const mode = process.argv[2];
if (mode !== "--check" && mode !== "--scan") {
  console.error("usage: node scripts/gitleaks-staged.mjs --check | --scan");
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
