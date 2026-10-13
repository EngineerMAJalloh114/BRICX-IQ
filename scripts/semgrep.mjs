// Semgrep SAST with this repo's own rules (ADR 0043, amending ADR 0032).
//   --scan      scans the repository; any finding, rule error or config
//               warning fails (exit 1). `pnpm semgrep` runs this.
//   --selftest  runs the rules over tooling/semgrep/selftest: every rule must
//               report exactly the known-bad lines listed in expected.json and
//               nothing in the known-good tree, or the run fails.
// Both refuse to run when the rule files differ from MANIFEST.json, and both
// run the pinned image by digest with no network (semgrep-pin.mjs), pulling
// it first unless that digest is already local (3 attempts; a failed pull
// fails, never skips). Needs Docker.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { semgrepManifestProblems, semgrepSelftestProblems } from "./guards.mjs";
import {
  dockerArgs,
  imageRef,
  manifestPath,
  readRuleFiles,
  root,
  scanArgs,
  selftestArgs,
  selftestDir,
  sha256,
} from "./semgrep-pin.mjs";

const mode = process.argv[2];
if (mode !== "--scan" && mode !== "--selftest") {
  console.error("usage: node scripts/semgrep.mjs --scan | --selftest");
  process.exit(2);
}

/** @param {string} message */
function fail(message) {
  console.error(`\nsemgrep ${mode ?? ""} FAILED: ${message}\n`);
  process.exit(1);
}

const manifestText = await readFile(manifestPath, "utf8").catch(
  () => undefined,
);
const manifestProblems = semgrepManifestProblems(
  manifestText === undefined
    ? undefined
    : /** @type {unknown} */ (JSON.parse(manifestText)),
  Object.fromEntries(
    Object.entries(await readRuleFiles()).map(([name, text]) => [
      name,
      sha256(text),
    ]),
  ),
);
if (manifestProblems.length > 0) fail(manifestProblems.join("\n"));

// A local image is addressed by the same digest, so it is the pinned content;
// pulling again would only spend Docker Hub's anonymous rate limit (a HEAD
// request gets 429 too). Otherwise pull, 3 attempts.
const local = spawnSync(
  "docker",
  ["image", "inspect", "--format", "{{.Id}}", imageRef],
  {
    stdio: "ignore",
  },
);
const pullAttempts = 3;
for (let attempt = 1; local.status !== 0; attempt += 1) {
  const pull = spawnSync("docker", ["pull", "--quiet", imageRef], {
    stdio: "inherit",
  });
  if (pull.status === 0) break;
  if (attempt === pullAttempts) {
    fail(
      `docker pull ${imageRef} failed ${String(pullAttempts)} times (Docker Hub rate limit or no network); Semgrep is never skipped`,
    );
  }
  const wait = 10 * attempt;
  console.error(
    `docker pull failed (attempt ${String(attempt)} of ${String(pullAttempts)}); retrying in ${String(wait)} s`,
  );
  await sleep(wait * 1000);
}

if (mode === "--scan") {
  const scan = spawnSync(
    "docker",
    [...dockerArgs(root), imageRef, ...scanArgs],
    {
      stdio: "inherit",
    },
  );
  if (scan.status !== 0) {
    fail(
      `Semgrep reported findings or errors (exit ${String(scan.status ?? scan.signal)}). Fix the code, or add an inline "nosemgrep: <rule-id> -- <reason>" comment that the PR lists.`,
    );
  }
  console.log(
    `semgrep --scan passed: no findings (${imageRef}, rules in tooling/semgrep/rules)`,
  );
  process.exit(0);
}

/**
 * Findings in one self-test tree, as "<rule-id> <path>:<line>".
 * @param {"bad" | "good"} tree
 */
function findings(tree) {
  const run = spawnSync(
    "docker",
    [...dockerArgs(path.join(selftestDir, tree)), imageRef, ...selftestArgs],
    { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  if (run.status !== 0) {
    process.stderr.write(run.stderr);
    fail(
      `Semgrep exited ${String(run.status ?? run.signal)} on the ${tree} tree`,
    );
  }
  /** @type {unknown} */
  const parsed = JSON.parse(run.stdout);
  const output =
    /** @type {{ results: { check_id: string, path: string, start: { line: number } }[], errors: unknown[] }} */ (
      parsed
    );
  if (output.errors.length > 0) {
    fail(
      `Semgrep reported errors on the ${tree} tree: ${JSON.stringify(output.errors)}`,
    );
  }
  // A rule loaded from a directory gets the directory as an id prefix.
  return output.results.map(
    (r) =>
      `${r.check_id.split(".").at(-1) ?? ""} ${r.path}:${String(r.start.line)}`,
  );
}

const expected = /** @type {unknown} */ (
  JSON.parse(await readFile(path.join(selftestDir, "expected.json"), "utf8"))
);
const problems = semgrepSelftestProblems(
  expected,
  findings("bad"),
  findings("good"),
);
if (problems.length > 0) fail(problems.join("\n"));
console.log(
  `semgrep --selftest passed: every rule caught exactly its known-bad lines and nothing in the known-good tree (${imageRef})`,
);
