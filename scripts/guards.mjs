// Pure checks used by check-workspace-scripts.mjs (P1-06, ADR 0031). Each
// takes file contents and returns a list of problems, so the fixtures in
// scripts/guard-fixtures/ can prove every rule fails when broken.

/** Dependency fields whose entries must be exact and allow-listed. */
export const dependencyFields = /** @type {const} */ ([
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
]);

/**
 * @typedef {Partial<Record<(typeof dependencyFields)[number], Record<string, string>>>} Manifest
 */

const exactVersion = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Every dependency version must be an exact semver (`save-exact`, ADR 0023);
 * `workspace:*` links are the only exception.
 * @param {Manifest} manifest
 * @param {string} label
 * @returns {string[]}
 */
export function exactPinProblems(manifest, label) {
  /** @type {string[]} */
  const problems = [];
  for (const field of dependencyFields) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (version === "workspace:*") continue;
      if (!exactVersion.test(version)) {
        problems.push(
          `${label}: ${field} ${name} "${version}" is not an exact version (ADR 0023: pin exact versions)`,
        );
      }
    }
  }
  return problems;
}

const packageName = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

/**
 * Package names allowed by docs/DEPENDENCIES.md: every backticked npm name
 * in the first cell of a table row, before any parenthesised note.
 * @param {string} markdown
 * @returns {Set<string>}
 */
export function allowedPackageNames(markdown) {
  /** @type {Set<string>} */
  const names = new Set();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    const firstCell = line.split("|")[1] ?? "";
    const beforeNote = firstCell.split("(")[0] ?? "";
    for (const match of beforeNote.matchAll(/`([^`]+)`/g)) {
      const name = match[1] ?? "";
      if (packageName.test(name)) names.add(name);
    }
  }
  return names;
}

/**
 * Every dependency name must be listed in docs/DEPENDENCIES.md (ADR 0023);
 * internal `workspace:*` packages are exempt.
 * @param {Manifest} manifest
 * @param {string} label
 * @param {Set<string>} allowed
 * @returns {string[]}
 */
export function unlistedDependencyProblems(manifest, label, allowed) {
  /** @type {string[]} */
  const problems = [];
  for (const field of dependencyFields) {
    for (const [name, version] of Object.entries(manifest[field] ?? {})) {
      if (version === "workspace:*" || allowed.has(name)) continue;
      problems.push(
        `${label}: ${field} ${name} is not listed in docs/DEPENDENCIES.md (ADR 0023: add it there, with an ADR, first)`,
      );
    }
  }
  return problems;
}

const shaPinned =
  /^[\w.-]+\/[\w.-]+(?:\/[\w./-]+)?@[0-9a-f]{40} # v\d+\.\d+\.\d+$/;
const digestPinned = /^docker:\/\/[\w./-]+(?::[\w.-]+)?@sha256:[0-9a-f]{64}$/;
const requiredEnv = [
  'HUSKY: "0"',
  'TURBO_TELEMETRY_DISABLED: "1"',
  "TURBO_CACHE: local:rw",
];

/**
 * Security rules for a GitHub Actions workflow or composite action
 * (ADR 0031). Line-based: our workflows are written in this plain style,
 * and anything the rules cannot read is reported rather than skipped.
 * @param {string} text
 * @param {string} label
 * @param {"workflow" | "action"} kind
 * @returns {{ problems: string[], uses: number }}
 */
export function workflowProblems(text, label, kind) {
  /** @type {string[]} */
  const problems = [];
  let uses = 0;
  const lines = text.split("\n");
  /** @type {number | undefined} indentation of the open `run: |` key */
  let runIndent;
  lines.forEach((raw, index) => {
    const where = `${label}:${String(index + 1)}`;
    const indent = raw.length - raw.trimStart().length;
    const line = raw.trim();
    if (runIndent !== undefined) {
      if (line === "" || indent > runIndent) {
        if (line.includes("${{")) {
          problems.push(
            `${where}: \${{ }} inside a run: script; pass it through env: instead`,
          );
        }
        return;
      }
      runIndent = undefined;
    }
    if (line.startsWith("#")) return;
    if (/\bpull_request_target\b/.test(line)) {
      problems.push(`${where}: pull_request_target is forbidden`);
    }
    if (/^(?:- )?if:/.test(line)) {
      problems.push(
        `${where}: if: conditions are not allowed; a skipped job or step counts as passing (no job may be skipped or pass on zero work)`,
      );
    }
    if (/\bTURBO_(?:TOKEN|TEAM)\b/.test(line)) {
      problems.push(
        `${where}: Turbo remote cache is off (no TURBO_TOKEN/TURBO_TEAM)`,
      );
    }
    const run = /^(?:- )?run:\s*(.*)$/.exec(line);
    if (run) {
      const value = run[1] ?? "";
      if (/^[|>][-+]?$/.test(value)) {
        runIndent = indent + (line.startsWith("- ") ? 2 : 0);
      } else if (value.includes("${{")) {
        problems.push(
          `${where}: \${{ }} inside a run: script; pass it through env: instead`,
        );
      }
    }
    const use = /^(?:- )?uses:\s*(.*)$/.exec(line);
    if (use) {
      uses += 1;
      const target = use[1] ?? "";
      if (
        !target.startsWith("./") &&
        !shaPinned.test(target) &&
        !digestPinned.test(target)
      ) {
        problems.push(
          `${where}: "${target}" must be pinned by full commit SHA with a version comment (owner/repo@<40 hex> # vX.Y.Z)`,
        );
      }
    }
    if (/^permissions:/.test(line) && indent > 0) {
      problems.push(
        `${where}: job-level permissions are not allowed; the top-level contents: read is the only grant`,
      );
    }
  });
  if (kind === "workflow") {
    const top = lines.findIndex((l) => l.startsWith("permissions:"));
    const grant = lines
      .slice(top + 1)
      .filter((l) => l.trim() !== "" && !l.trim().startsWith("#"));
    const body = [];
    for (const l of grant) {
      if (!l.startsWith(" ")) break;
      body.push(l.trim());
    }
    if (
      top === -1 ||
      lines[top]?.trim() !== "permissions:" ||
      JSON.stringify(body) !== JSON.stringify(["contents: read"])
    ) {
      problems.push(
        `${label}: top-level permissions must be exactly "contents: read"`,
      );
    }
    for (const env of requiredEnv) {
      if (!lines.some((l) => l.trim() === env)) {
        problems.push(`${label}: must set ${env} in env`);
      }
    }
  }
  return { problems, uses };
}
