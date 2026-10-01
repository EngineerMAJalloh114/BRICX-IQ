// `pnpm audit:prod` (CI security job, ADR 0031): `pnpm audit --prod`, but
// fails first if the workspace has no production dependencies, so the audit
// can never pass on zero work.
import { execFileSync, spawnSync } from "node:child_process";
import process from "node:process";

/** @type {unknown} */
const parsed = JSON.parse(
  execFileSync("pnpm", ["ls", "-r", "--prod", "--depth", "0", "--json"], {
    encoding: "utf8",
  }),
);
const projects =
  /** @type {{ dependencies?: Record<string, { version?: string }> }[]} */ (
    parsed
  );
const external = new Set(
  projects.flatMap((p) =>
    Object.entries(p.dependencies ?? {})
      .filter(([, d]) => !d.version?.startsWith("link:"))
      .map(([name]) => name),
  ),
);
if (external.size === 0) {
  console.error("audit:prod FAILED: no production dependencies to audit");
  process.exit(1);
}
console.log(
  `audit:prod: auditing ${String(external.size)} direct production dependencies (${[...external].sort().join(", ")})`,
);
const result = spawnSync("pnpm", ["audit", "--prod"], { stdio: "inherit" });
process.exit(result.status ?? 1);
