// Runs the real `pr-title` step script from .github/workflows/ci.yml
// against simulated events (P1-06 addition 2, ADR 0031): on `push` it must
// lint the head commit subject (the squash title), on `pull_request` the PR
// title from env, and no title may execute as shell code. Used by
// check-workspace-scripts.mjs, so the proof re-runs on every verify.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const stepName = "- name: commitlint on the PR title or the squash title";

/**
 * The step's `run: |` block, dedented.
 * @param {string} workflow
 * @returns {string | undefined}
 */
export function prTitleScript(workflow) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((l) => l.trim() === stepName);
  if (start === -1) return undefined;
  const runAt = lines.findIndex((l, i) => i > start && /^\s+run: \|$/.test(l));
  if (runAt === -1) return undefined;
  const runIndent = (lines[runAt] ?? "").search(/\S/);
  /** @type {string[]} */
  const body = [];
  for (const line of lines.slice(runAt + 1)) {
    if (line.trim() !== "" && line.search(/\S/) <= runIndent) break;
    body.push(line);
  }
  const indent = Math.min(
    ...body.filter((l) => l.trim() !== "").map((l) => l.search(/\S/)),
  );
  return body.map((l) => l.slice(indent)).join("\n");
}

/**
 * @param {string} root repository root (pnpm exec commitlint runs here)
 * @returns {Promise<{ problems: string[], cases: number }>}
 */
export async function prTitleStepProblems(root) {
  /** @type {string[]} */
  const problems = [];
  const workflowFile = path.join(root, ".github/workflows/ci.yml");
  const script = prTitleScript(await readFile(workflowFile, "utf8"));
  if (!script) {
    return {
      problems: [
        `.github/workflows/ci.yml: pr-title step "${stepName}" with a run: | block not found`,
      ],
      cases: 0,
    };
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), "bricx-pr-title-"));
  const canary = path.join(temp, "canary");
  /**
   * @param {string[]} args
   */
  const git = (...args) =>
    spawnSync("git", args, { cwd: temp, encoding: "utf8" });
  /** @type {{ name: string, event: string, subject: string, ok: boolean }[]} */
  const cases = [
    {
      name: "push: conventional squash title passes",
      event: "push",
      subject: "ci: add CI skeleton (P1-06) (#14)",
      ok: true,
    },
    {
      name: "push: non-conventional squash title fails (main's P0-01 title)",
      event: "push",
      subject: "P0-01: record architecture decisions as ADRs (#4)",
      ok: false,
    },
    {
      name: "pull_request: conventional title passes",
      event: "pull_request",
      subject: "ci: add CI skeleton (P1-06)",
      ok: true,
    },
    {
      name: "pull_request: conventional title with shell metacharacters passes and runs nothing",
      event: "pull_request",
      subject: `ci: probe $(touch $CANARY) \`touch $CANARY\` "; touch $CANARY; #`,
      ok: true,
    },
    {
      name: "pull_request: non-conventional title with shell metacharacters fails and runs nothing",
      event: "pull_request",
      subject: `Bad $(touch $CANARY) && touch $CANARY`,
      ok: false,
    },
    {
      name: "push: squash title with shell metacharacters runs nothing",
      event: "push",
      subject: `ci: probe $(touch $CANARY) \`touch $CANARY\``,
      ok: true,
    },
  ];
  try {
    git("init", "-q");
    for (const c of cases) {
      const commit = git(
        "-c",
        "user.name=pr-title-check",
        "-c",
        "user.email=pr-title-check@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "--allow-empty",
        "-m",
        c.event === "push" ? c.subject : "ci: unrelated head commit",
      );
      if (commit.status !== 0) {
        problems.push(
          `pr-title simulation: git commit failed: ${commit.stderr}`,
        );
        continue;
      }
      // GitHub's default shell for run: is `bash -e {0}`.
      const result = spawnSync("bash", ["-e", "-c", script], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_DIR: path.join(temp, ".git"),
          GITHUB_EVENT_NAME: c.event,
          PR_TITLE: c.event === "pull_request" ? c.subject : "",
          // Any title that ran as shell code would create this file.
          CANARY: canary,
        },
      });
      const passed = result.status === 0;
      const echoed = result.stdout.includes(`Checking: ${c.subject}`);
      if (passed !== c.ok || !echoed || existsSync(canary)) {
        problems.push(
          `pr-title simulation: "${c.name}" expected ${c.ok ? "pass" : "fail"}, got exit ${String(result.status)}; subject echoed literally: ${String(echoed)}; title executed: ${String(existsSync(canary))}`,
        );
      }
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
  return { problems, cases: cases.length };
}
