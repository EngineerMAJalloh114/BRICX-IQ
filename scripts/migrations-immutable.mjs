// Merged migrations are immutable (P4-02, ADR 0052). CI's security job runs
//
//   node scripts/migrations-immutable.mjs --selftest
//   node scripts/migrations-immutable.mjs --check
//
// --check, on a pull_request event, diffs packages/db/migrations from the
// merge base with origin/$GITHUB_BASE_REF to HEAD and fails on any edit,
// delete or rename of an NNNN_*.sql or meta/NNNN_snapshot.json (P4-05)
// the base already has, and on any _journal.json change other than
// appended entries
// (migrationImmutabilityProblems in guards.mjs, proven by its fixtures).
// On any other event it checks nothing and says so: workflows may not use
// if: (ADR 0031), so the event test lives here.
//
// --selftest builds a throwaway git repository and proves the real git
// plumbing on one case per rule, so a broken diff parse cannot pass
// silently.
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { migrationImmutabilityProblems, migrationsDir } from "./guards.mjs";

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const git = (cwd, ...args) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * The parsed journal at `rev`, or null when it does not exist there.
 * @param {string} cwd
 * @param {string} rev
 * @returns {unknown}
 */
function journalAt(cwd, rev) {
  const spec = `${rev}:${migrationsDir}/meta/_journal.json`;
  try {
    git(cwd, "cat-file", "-e", spec);
  } catch {
    return null;
  }
  /** @type {unknown} */
  const parsed = JSON.parse(git(cwd, "show", spec));
  return parsed;
}

/**
 * Problems in HEAD's migrations relative to the merge base with `baseRef`.
 * @param {string} cwd
 * @param {string} baseRef
 * @returns {string[]}
 */
export function immutabilityCheck(cwd, baseRef) {
  const mergeBase = git(cwd, "merge-base", baseRef, "HEAD").trim();
  const fields = git(
    cwd,
    "diff",
    "--name-status",
    "-z",
    "-M",
    mergeBase,
    "HEAD",
    "--",
    migrationsDir,
  )
    .split("\0")
    .filter((f) => f !== "");
  /** @type {import("./guards.mjs").DiffEntry[]} */
  const changes = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i] ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      changes.push({
        status,
        path: fields[i + 1] ?? "",
        to: fields[i + 2] ?? "",
      });
      i += 3;
    } else {
      changes.push({ status, path: fields[i + 1] ?? "" });
      i += 2;
    }
  }
  return migrationImmutabilityProblems({
    changes,
    base: journalAt(cwd, mergeBase),
    head: journalAt(cwd, "HEAD"),
  });
}

/** @param {string[]} tags */
const journal = (tags) =>
  `${JSON.stringify(
    {
      version: "7",
      dialect: "postgresql",
      entries: tags.map((tag, idx) => ({
        idx,
        version: "7",
        when: 1_792_000_000_000 + idx,
        tag,
        breakpoints: true,
      })),
    },
    null,
    2,
  )}\n`;

/** @type {{ name: string, change: (dir: string) => Promise<void>, wanted: string[] }[]} */
const cases = [
  {
    name: "a new migration with its snapshot and appended journal entry passes",
    change: async (dir) => {
      await writeFile(path.join(dir, "0001_b.sql"), "SELECT 2;\n");
      await writeFile(
        path.join(dir, "meta/0001_snapshot.json"),
        '{ "id": "b" }\n',
      );
      await writeFile(
        path.join(dir, "meta/_journal.json"),
        journal(["0000_a", "0001_b"]),
      );
    },
    wanted: [],
  },
  {
    name: "editing a merged migration fails",
    change: (dir) => writeFile(path.join(dir, "0000_a.sql"), "SELECT 9;\n"),
    wanted: ["0000_a.sql: edits a merged migration"],
  },
  {
    name: "deleting a merged migration fails",
    change: (dir) => rm(path.join(dir, "0000_a.sql")),
    wanted: ["0000_a.sql: deletes a merged migration"],
  },
  {
    name: "renaming a merged migration fails",
    change: async (dir) => {
      await rm(path.join(dir, "0000_a.sql"));
      await writeFile(path.join(dir, "0000_renamed.sql"), "SELECT 1;\n");
    },
    wanted: ["0000_a.sql: renames a merged migration"],
  },
  {
    name: "editing a merged snapshot fails (P4-05)",
    change: (dir) =>
      writeFile(path.join(dir, "meta/0000_snapshot.json"), '{ "id": "z" }\n'),
    wanted: ["meta/0000_snapshot.json: edits a merged snapshot"],
  },
  {
    name: "deleting a merged snapshot fails (P4-05)",
    change: (dir) => rm(path.join(dir, "meta/0000_snapshot.json")),
    wanted: ["meta/0000_snapshot.json: deletes a merged snapshot"],
  },
  {
    name: "rewriting a merged journal entry fails",
    change: (dir) =>
      writeFile(path.join(dir, "meta/_journal.json"), journal(["0000_z"])),
    wanted: ["changes merged entries"],
  },
];

/** @returns {Promise<string[]>} failures */
async function selftest() {
  /** @type {string[]} */
  const failures = [];
  const repo = await mkdtemp(path.join(os.tmpdir(), "bricx-immutable-"));
  try {
    const dir = path.join(repo, migrationsDir);
    await mkdir(path.join(dir, "meta"), { recursive: true });
    git(repo, "init", "--quiet", "--initial-branch=main");
    git(repo, "config", "user.email", "selftest@bricx.invalid");
    git(repo, "config", "user.name", "selftest");
    git(repo, "config", "commit.gpgsign", "false");
    await writeFile(path.join(dir, "0000_a.sql"), "SELECT 1;\n");
    await writeFile(
      path.join(dir, "meta/0000_snapshot.json"),
      '{ "id": "a" }\n',
    );
    await writeFile(path.join(dir, "meta/_journal.json"), journal(["0000_a"]));
    git(repo, "add", "-A");
    git(repo, "commit", "--quiet", "--no-verify", "-m", "base");
    for (const [i, c] of cases.entries()) {
      git(repo, "checkout", "--quiet", "-b", `case-${String(i)}`, "main");
      await c.change(dir);
      git(repo, "add", "-A");
      git(repo, "commit", "--quiet", "--no-verify", "-m", c.name);
      const found = immutabilityCheck(repo, "main");
      const ok =
        found.length === c.wanted.length &&
        c.wanted.every((w) => found.some((f) => f.includes(w)));
      console.log(`${ok ? "ok  " : "FAIL"} ${c.name}`);
      if (!ok) {
        failures.push(
          `${c.name}: expected ${JSON.stringify(c.wanted)}, got ${JSON.stringify(found)}`,
        );
      }
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
  return failures;
}

async function main() {
  const mode = process.argv[2];
  if (mode === "--selftest") {
    const failures = await selftest();
    if (failures.length > 0) {
      for (const f of failures) console.error(f);
      console.error("migrations-immutable self-test FAILED");
      process.exit(1);
    }
    console.log(
      `migrations-immutable self-test passed: ${String(cases.length)} cases through real git`,
    );
    return;
  }
  if (mode === "--check") {
    if (process.env["GITHUB_EVENT_NAME"] !== "pull_request") {
      console.log(
        "migrations-immutable: not a pull_request event; nothing to check (runs on PRs only)",
      );
      return;
    }
    const baseRef = process.env["GITHUB_BASE_REF"] ?? "";
    if (!/^[A-Za-z0-9._/-]+$/.test(baseRef) || baseRef.startsWith("-")) {
      console.error(
        "migrations-immutable: GITHUB_BASE_REF is missing or invalid",
      );
      process.exit(1);
    }
    const problems = immutabilityCheck(process.cwd(), `origin/${baseRef}`);
    if (problems.length > 0) {
      for (const p of problems) console.error(p);
      console.error(
        `migrations-immutable FAILED against origin/${baseRef}: merged migrations are never edited, deleted or renamed; add a new migration instead (docs/runbooks/migrations.md)`,
      );
      process.exit(1);
    }
    console.log(
      `migrations-immutable passed against origin/${baseRef}: merged migrations unchanged, journal only appended`,
    );
    return;
  }
  console.error(
    "usage: node scripts/migrations-immutable.mjs --selftest | --check",
  );
  process.exit(2);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
