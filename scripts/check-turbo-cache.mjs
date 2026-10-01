// `pnpm check:turbo-cache` (CI, after `pnpm verify`; ADR 0031). Asks turbo,
// without running anything, whether every cacheable task of `pnpm verify`
// would now be a cache hit. A miss means a task's inputs changed while
// verify ran (P1-06 found Vitest's results.json under node_modules busting
// the typecheck and lint caches), so the cache cannot be trusted. Also fails
// if no cacheable task exists, so the check can never pass on zero work.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = path.resolve(import.meta.dirname, "..");
/** @type {unknown} */
const pkgParsed = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
const verify =
  /** @type {{ scripts?: Record<string, string> }} */ (pkgParsed).scripts
    ?.verify ?? "";
const match = /^turbo run (.+)$/.exec(verify);
if (!match?.[1]) {
  console.error(
    `check:turbo-cache: cannot read the tasks of "verify": ${verify}`,
  );
  process.exit(1);
}
const tasks = match[1].split(/\s+/);

const output = execFileSync(
  path.join(root, "node_modules/.bin/turbo"),
  ["run", ...tasks, "--dry=json"],
  { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
);
/** @type {unknown} */
const dryParsed = JSON.parse(output);
const dry =
  /** @type {{ tasks: { taskId: string, command: string, cache: { status: string }, resolvedTaskDefinition: { cache: boolean } }[] }} */ (
    dryParsed
  );
const cacheable = dry.tasks.filter(
  (t) => t.command !== "<NONEXISTENT>" && t.resolvedTaskDefinition.cache,
);
const misses = cacheable.filter((t) => t.cache.status !== "HIT");
if (cacheable.length === 0 || misses.length > 0) {
  for (const t of misses) {
    console.error(`cache miss after verify: ${t.taskId} (${t.command})`);
  }
  console.error(
    cacheable.length === 0
      ? "check:turbo-cache FAILED: verify has no cacheable tasks, so this check did no work"
      : "check:turbo-cache FAILED: a task's inputs changed while verify ran; fix its turbo.json inputs",
  );
  process.exit(1);
}
console.log(
  `check:turbo-cache passed: all ${String(cacheable.length)} cacheable verify tasks are cache hits after verify`,
);
