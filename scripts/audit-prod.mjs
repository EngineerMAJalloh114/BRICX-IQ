// `pnpm audit:prod` (CI security job, ADR 0031): `pnpm audit --prod`, but
// fails first if the workspace has no production dependencies, so the audit
// can never pass on zero work. Every ignored advisory (ADR 0037) is checked
// as check:workspace checks it and printed with its ADR before the audit, so
// no ignore is ever silent.
import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { repoAuditIgnores } from "./audit-ignores.mjs";

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
const root = path.resolve(import.meta.dirname, "..");
const { ignores, problems, warnings } = await repoAuditIgnores(
  root,
  new Date().toISOString().slice(0, 10),
);
for (const warning of warnings) console.warn(`audit:prod WARNING: ${warning}`);
if (problems.length > 0) {
  for (const problem of problems) console.error(problem);
  console.error("audit:prod FAILED: an audit ignore breaks ADR 0037");
  process.exit(1);
}
for (const ignore of ignores) {
  console.log(
    `audit:prod: IGNORING ${ignore.id} (${ignore.package}) per ${ignore.adr}, revisit by ${ignore.revisitBy}`,
  );
}
const result = spawnSync("pnpm", ["audit", "--prod"], { stdio: "inherit" });
process.exit(result.status ?? 1);
