// Fails when a workspace package lacks a script `pnpm verify` depends on:
// every package under apps/, packages/ and tooling/ needs `typecheck` and
// `lint`; apps/ and packages/ also need `test` (tooling/ is proven by its
// smoke packages instead). Each apps/ and packages/ package must also run
// its tests through @bricx/vitest-config: exactly one vitest.config.mts or
// vitest.config.ts that calls defaultPreset or swcPreset, no other Vite or
// Vitest config file, and a `test` script that neither points Vitest at
// another config nor turns coverage off. Also fails if Vitest's pass-on-no-tests option
// appears in any package.json or Vitest/Vite config, so a package can never
// pass with zero tests. A folder without package.json is a placeholder.
// Also fails unless `@eslint/js` (in @bricx/eslint-config) has the same major
// as `eslint`, and the root `eslint` pin equals @bricx/eslint-config's peer:
// since ESLint 10 the two packages version separately (ADR 0029).
// Also fails unless the git hooks still fail closed (ADR 0030): .husky/pre-commit
// and .husky/commit-msg hold exactly their expected commands in order (so no
// `|| true`, `exit 0` or skipped step), `prepare` installs husky, `.tools/`
// is gitignored, and docs/DEPENDENCIES.md names the pinned gitleaks version.
// Also (P1-06, ADR 0031) fails if any package.json dependency is not an
// exact version or its name is not listed in docs/DEPENDENCIES.md (ADR 0023),
// or if a GitHub Actions workflow or composite action breaks the CI
// security rules in guards.mjs (including: no if: anywhere, so no job or
// step is ever skipped), or if the real pr-title step, run against simulated
// push and pull_request events, does not lint the squash title on push, the
// PR title on a PR, and execute no title. Also (P2-01, ADR 0034) fails if
// infrastructure/docker/compose.yml has an image not pinned as
// repo:tag@sha256 (or tagged latest, or not listed in DEPENDENCIES.md), a
// port not bound to 127.0.0.1, a service without a healthcheck, build:,
// network_mode: host, or YAML the line-based guard cannot read; and the
// dev:reset refusal rules are proven on fixtures. Also (P2-02, ADR 0035) fails if
// the bootstrap superuser variables appear outside compose.yml's postgres
// service (any tracked file but .env.example, Markdown and the fixtures);
// if Testcontainers' Ryuk image (RYUK_IMAGE in @bricx/vitest-config) is not
// digest-pinned and listed in DEPENDENCIES.md; if a package has *.int.test.*
// files without a `test:integration` script using integrationPreset (or the
// script without such files); unless at least one package defines
// `test:integration`, the root script runs it through turbo, and turbo never
// caches it; and the dev:up .env merge, the stale-volume detection and the
// PowerSync healthcheck's decision logic are proven on fixtures. Also (P1-06b,
// ADR 0037) fails unless every ignored audit advisory is a GHSA id in
// pnpm-workspace.yaml (or package.json's pnpm.auditConfig, never both),
// recorded in an Accepted ADR naming its package and a "Revisit by" date that
// has not passed (it warns in the last 30 days), with that package outside the
// production closure of every apps/ and packages/ importer; no audit level is
// ever set. Every rule is first proven against the
// fixtures in scripts/guard-fixtures/: an unexpected outcome fails the run.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { RYUK_IMAGE } from "@bricx/vitest-config";
import { replicationProblems } from "../infrastructure/docker/powersync/healthcheck.mjs";
import { repoAuditIgnores } from "./audit-ignores.mjs";
import { gitleaks } from "./gitleaks-pin.mjs";
import {
  allowedImageRefs,
  allowedPackageNames,
  auditIgnoreProblems,
  composeProblems,
  devResetRefusals,
  exactPinProblems,
  integrationScriptProblems,
  missingBootstrapObjects,
  missingEnvEntries,
  pinnedImageProblems,
  superuserReferenceProblems,
  unlistedDependencyProblems,
  workflowProblems,
} from "./guards.mjs";
import { prTitleStepProblems } from "./pr-title-step.mjs";

const root = path.resolve(import.meta.dirname, "..");
/** @type {Record<string, string[]>} */
const requiredByGroup = {
  apps: ["typecheck", "lint", "test"],
  packages: ["typecheck", "lint", "test"],
  tooling: ["typecheck", "lint"],
};
// Built from parts so this file does not match its own search.
const noTestsOption = ["pass", "With", "No", "Tests"].join("");
const configFile =
  /^(?:package\.json|vite(?:st)?\.(?:config|workspace)\.[cm]?[jt]s)$/;
const skippedDirs = new Set([
  ".git",
  ".turbo",
  "node_modules",
  "coverage",
  "dist",
  "build",
]);

const presetGroups = new Set(["apps", "packages"]);
const allowedConfigs = ["vitest.config.mts", "vitest.config.ts"];
const anyViteConfig = /^vite(?:st)?\.(?:config|workspace)\.[cm]?[jt]s$/;
const importsPreset = /from\s+["']@bricx\/vitest-config["']/;
const callsPreset = /\b(?:defaultPreset|swcPreset)\s*\(/;
// `--config`/`-c` swaps the preset out; the rest turn coverage off.
const bypassFlag =
  /(?:^|\s)(?:--config|-c|--dir|--root|-r|--no-coverage|--coverage\.enabled(?:=|\s+)false|--coverage=false)(?:[=\s]|$)/;

/**
 * Problems with how a package under apps/ or packages/ runs Vitest.
 * @param {string} dir
 * @param {string | undefined} testScript
 * @returns {Promise<string[]>}
 */
async function presetProblems(dir, testScript) {
  /** @type {string[]} */
  const problems = [];
  const names = (await readdir(dir)).filter((n) => anyViteConfig.test(n));
  const configs = names.filter((n) => allowedConfigs.includes(n));
  const others = names.filter((n) => !allowedConfigs.includes(n));
  if (others.length > 0) {
    problems.push(
      `has ${others.join(", ")}; use only vitest.config.mts or vitest.config.ts`,
    );
  }
  if (configs.length !== 1) {
    problems.push(
      configs.length === 0
        ? "has no vitest.config.mts or vitest.config.ts"
        : `has both ${configs.join(" and ")}`,
    );
  }
  for (const config of configs) {
    const source = await readFile(path.join(dir, config), "utf8");
    if (!importsPreset.test(source) || !callsPreset.test(source)) {
      problems.push(
        `${config} must import @bricx/vitest-config and call defaultPreset or swcPreset`,
      );
    }
  }
  if (testScript && bypassFlag.test(testScript)) {
    problems.push(
      `test script "${testScript}" bypasses the preset (another config or coverage off)`,
    );
  }
  return problems;
}

/**
 * @typedef {{
 *   name?: string,
 *   scripts?: Record<string, string>,
 *   dependencies?: Record<string, string>,
 *   devDependencies?: Record<string, string>,
 *   peerDependencies?: Record<string, string>,
 * }} PackageJson
 */

/** @type {string[]} */
const failures = [];
let checked = 0;
for (const [group, required] of Object.entries(requiredByGroup)) {
  const entries = await readdir(path.join(root, group), {
    withFileTypes: true,
  });
  for (const entry of entries.filter((e) => e.isDirectory())) {
    const manifest = path.join(root, group, entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    /** @type {unknown} */
    const parsed = JSON.parse(await readFile(manifest, "utf8"));
    const pkg = /** @type {PackageJson} */ (parsed);
    checked += 1;
    const missing = required.filter((script) => !pkg.scripts?.[script]?.trim());
    const label = `${group}/${entry.name} (${pkg.name ?? "unnamed"})`;
    if (missing.length > 0) {
      failures.push(`${label}: missing ${missing.join(", ")}`);
    }
    if (presetGroups.has(group)) {
      const dir = path.join(root, group, entry.name);
      for (const problem of await presetProblems(dir, pkg.scripts?.test)) {
        failures.push(`${label}: ${problem}`);
      }
    }
  }
}

/**
 * package.json and Vitest/Vite config files at any depth, outside
 * node_modules and build output.
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* configFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirs.has(entry.name)) {
        yield* configFiles(path.join(dir, entry.name));
      }
    } else if (configFile.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}

let scanned = 0;
for await (const file of configFiles(root)) {
  scanned += 1;
  if ((await readFile(file, "utf8")).includes(noTestsOption)) {
    failures.push(
      `${path.relative(root, file)}: uses ${noTestsOption}; a test run must fail when it finds no tests`,
    );
  }
}

/**
 * @param {string} file
 * @returns {Promise<PackageJson>}
 */
async function readManifest(file) {
  /** @type {unknown} */
  const parsed = JSON.parse(await readFile(path.join(root, file), "utf8"));
  return /** @type {PackageJson} */ (parsed);
}

/** @param {string} version */
const majorOf = (version) => /^(\d+)\./.exec(version)?.[1];

const eslintPin = (await readManifest("package.json")).devDependencies?.eslint;
const eslintConfig = await readManifest("tooling/eslint/package.json");
const eslintPeer = eslintConfig.peerDependencies?.eslint;
const eslintJsPin = eslintConfig.dependencies?.["@eslint/js"];
if (!eslintPin || !eslintPeer || !eslintJsPin) {
  failures.push(
    "eslint pins: need root devDependency eslint, and in tooling/eslint a peer eslint and a dependency @eslint/js",
  );
} else {
  if (eslintPeer !== eslintPin) {
    failures.push(
      `eslint pins: tooling/eslint peer eslint ${eslintPeer} differs from root eslint ${eslintPin}`,
    );
  }
  const eslintMajor = majorOf(eslintPin);
  if (eslintMajor === undefined || majorOf(eslintJsPin) !== eslintMajor) {
    failures.push(
      `eslint pins: @eslint/js ${eslintJsPin} must have the same major as eslint ${eslintPin} (ADR 0029)`,
    );
  }
}

// Every non-blank, non-comment line of each hook, in order (ADR 0030).
/** @type {Record<string, string[]>} */
const expectedHooks = {
  ".husky/pre-commit": [
    "set -e",
    "node scripts/gitleaks-staged.mjs --check",
    "lint-staged",
    "node scripts/gitleaks-staged.mjs --scan",
  ],
  ".husky/commit-msg": ["set -e", 'commitlint --edit "$1"'],
};
for (const [hook, expectedLines] of Object.entries(expectedHooks)) {
  const file = path.join(root, hook);
  if (!existsSync(file)) {
    failures.push(
      `${hook}: missing; the git hooks must fail closed (ADR 0030)`,
    );
    continue;
  }
  const lines = (await readFile(file, "utf8"))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("#"));
  if (JSON.stringify(lines) !== JSON.stringify(expectedLines)) {
    failures.push(
      `${hook}: commands must be exactly ${JSON.stringify(expectedLines)}, found ${JSON.stringify(lines)} (ADR 0030)`,
    );
  }
}
const rootScripts = (await readManifest("package.json")).scripts ?? {};
if (rootScripts.prepare !== "husky") {
  failures.push(
    'package.json: "prepare" must be "husky" so hooks install (ADR 0030)',
  );
}
const gitignore = (await readFile(path.join(root, ".gitignore"), "utf8")).split(
  "\n",
);
if (!gitignore.includes(".tools/")) {
  failures.push(".gitignore: must ignore .tools/ (gitleaks binary; ADR 0030)");
}
const gitleaksRow = (
  await readFile(path.join(root, "docs/DEPENDENCIES.md"), "utf8")
)
  .split("\n")
  .find((line) => line.startsWith("| gitleaks"));
if (!gitleaksRow?.includes(gitleaks.version)) {
  failures.push(
    `docs/DEPENDENCIES.md: the gitleaks row must name the pinned version ${gitleaks.version} (scripts/gitleaks-pin.mjs)`,
  );
}

// Guard self-test: each fixture must produce exactly its expected problems.
const fixtureDir = path.join(root, "scripts/guard-fixtures");
/** @type {unknown} */
const expectedParsed = JSON.parse(
  await readFile(path.join(fixtureDir, "expected.json"), "utf8"),
);
const expected = /** @type {Record<string, Record<string, string[]>>} */ (
  expectedParsed
);
const fixtureAllowed = allowedPackageNames(
  await readFile(path.join(fixtureDir, "DEPENDENCIES.md"), "utf8"),
);
/**
 * @param {string} group
 * @param {(file: string) => Promise<string[]>} run
 */
async function proveFixtures(group, run) {
  const cases = Object.entries(expected[group] ?? {});
  if (cases.length === 0) failures.push(`guard fixtures: no ${group} cases`);
  for (const [file, wanted] of cases) {
    const found = await run(file);
    const matches =
      found.length === wanted.length &&
      wanted.every((w) => found.some((f) => f.includes(w)));
    if (!matches) {
      failures.push(
        `guard fixtures: ${group}/${file} expected ${JSON.stringify(wanted)}, got ${JSON.stringify(found)}`,
      );
    }
  }
  return cases.length;
}
/** @param {string} file */
const fixtureManifest = async (file) => {
  /** @type {unknown} */
  const parsed = JSON.parse(
    await readFile(path.join(fixtureDir, "manifests", file), "utf8"),
  );
  return /** @type {import("./guards.mjs").Manifest} */ (parsed);
};
let fixtureCases = 0;
for (const kind of /** @type {const} */ (["workflows", "actions"])) {
  fixtureCases += await proveFixtures(kind, async (file) => {
    const text = await readFile(path.join(fixtureDir, kind, file), "utf8");
    return workflowProblems(
      text,
      file,
      kind === "workflows" ? "workflow" : "action",
    ).problems;
  });
}
fixtureCases += await proveFixtures("exactPins", async (file) =>
  exactPinProblems(await fixtureManifest(file), file),
);
fixtureCases += await proveFixtures("allowList", async (file) =>
  unlistedDependencyProblems(await fixtureManifest(file), file, fixtureAllowed),
);

const fixtureImages = allowedImageRefs(
  await readFile(path.join(fixtureDir, "DEPENDENCIES.md"), "utf8"),
);
fixtureCases += await proveFixtures(
  "compose",
  async (file) =>
    composeProblems(
      await readFile(path.join(fixtureDir, "compose", file), "utf8"),
      file,
      fixtureImages,
    ).problems,
);
fixtureCases += await proveFixtures("devReset", async (file) => {
  /** @type {unknown} */
  const parsed = JSON.parse(
    await readFile(path.join(fixtureDir, "dev-reset", file), "utf8"),
  );
  return devResetRefusals(
    /** @type {import("./guards.mjs").DevResetState} */ (parsed),
  );
});

/**
 * @param {string} group
 * @param {string} file
 * @returns {Promise<unknown>}
 */
const fixtureJson = async (group, file) => {
  /** @type {unknown} */
  const parsed = JSON.parse(
    await readFile(path.join(fixtureDir, group, file), "utf8"),
  );
  return parsed;
};
fixtureCases += await proveFixtures("superuserRefs", async (file) =>
  superuserReferenceProblems(
    /** @type {{ file: string, text: string }[]} */ (
      await fixtureJson("superuser-refs", file)
    ),
  ),
);
fixtureCases += await proveFixtures("envMerge", async (file) => {
  const { example, current } =
    /** @type {{ example: string, current: string }} */ (
      await fixtureJson("env-merge", file)
    );
  return missingEnvEntries(example, current).map((entry) => entry.key);
});
fixtureCases += await proveFixtures("devBootstrap", async (file) =>
  missingBootstrapObjects(
    /** @type {{ roles: string[], schemas: string[], publications: string[] }} */ (
      await fixtureJson("dev-bootstrap", file)
    ),
  ),
);
fixtureCases += await proveFixtures("images", async (file) =>
  pinnedImageProblems(
    await readFile(path.join(fixtureDir, "images", file), "utf8"),
    file,
    fixtureImages,
  ),
);
fixtureCases += await proveFixtures("diagnostics", async (file) =>
  replicationProblems(
    /** @type {import("../infrastructure/docker/powersync/healthcheck.mjs").Diagnostics} */ (
      await fixtureJson("diagnostics", file)
    ),
  ),
);
fixtureCases += await proveFixtures("integration", async (file) =>
  integrationScriptProblems(
    /** @type {import("./guards.mjs").IntegrationPackage} */ (
      await fixtureJson("integration", file)
    ),
  ),
);
fixtureCases += await proveFixtures("auditIgnores", async (file) => {
  const { problems, warnings } = auditIgnoreProblems(
    /** @type {Parameters<typeof auditIgnoreProblems>[0]} */ (
      await fixtureJson("audit-ignores", file)
    ),
  );
  return [...problems, ...warnings.map((w) => `WARNING ${w}`)];
});

// Real manifests: exact pins and the DEPENDENCIES.md allow-list (ADR 0023).
const allowed = allowedPackageNames(
  await readFile(path.join(root, "docs/DEPENDENCIES.md"), "utf8"),
);
let manifests = 0;
let dependencies = 0;
for await (const file of configFiles(root)) {
  if (path.basename(file) !== "package.json") continue;
  manifests += 1;
  const manifest = /** @type {import("./guards.mjs").Manifest} */ (
    await readManifest(path.relative(root, file))
  );
  const label = path.relative(root, file);
  for (const field of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    dependencies += Object.keys(
      manifest[/** @type {keyof import("./guards.mjs").Manifest} */ (field)] ??
        {},
    ).length;
  }
  failures.push(
    ...exactPinProblems(manifest, label),
    ...unlistedDependencyProblems(manifest, label, allowed),
  );
}
if (dependencies === 0) {
  failures.push(
    "package.json: no dependencies found; the allow-list check did no work",
  );
}

// Real workflows and composite actions (ADR 0031).
/** @type {[string, "workflow" | "action"][]} */
const workflowFiles = [];
const workflowsDir = path.join(root, ".github/workflows");
if (existsSync(workflowsDir)) {
  for (const name of await readdir(workflowsDir)) {
    if (/\.ya?ml$/.test(name)) {
      workflowFiles.push([path.join(workflowsDir, name), "workflow"]);
    }
  }
}
const actionsDir = path.join(root, ".github/actions");
if (existsSync(actionsDir)) {
  for (const name of await readdir(actionsDir)) {
    for (const file of ["action.yml", "action.yaml"]) {
      const full = path.join(actionsDir, name, file);
      if (existsSync(full)) workflowFiles.push([full, "action"]);
    }
  }
}
// The local Docker Compose stack (P2-01, ADR 0034).
const composeFile = "infrastructure/docker/compose.yml";
const compose = existsSync(path.join(root, composeFile))
  ? composeProblems(
      await readFile(path.join(root, composeFile), "utf8"),
      composeFile,
      allowedImageRefs(
        await readFile(path.join(root, "docs/DEPENDENCIES.md"), "utf8"),
      ),
    )
  : { problems: [`${composeFile}: missing (P2-01)`], services: 0 };
failures.push(...compose.problems);

// The bootstrap superuser is bootstrap-only (P2-02, ADR 0035): every tracked
// or new (not ignored) file, outside compose.yml's postgres service.
const repoFiles = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
  { cwd: root, encoding: "utf8" },
)
  .split("\0")
  .filter((file) => file !== "" && existsSync(path.join(root, file)));
const superuserProblems = superuserReferenceProblems(
  await Promise.all(
    repoFiles.map(async (file) => ({
      file,
      text: await readFile(path.join(root, file), "utf8"),
    })),
  ),
);
failures.push(...superuserProblems);
if (repoFiles.length === 0) {
  failures.push("git ls-files: no files; the superuser scan did no work");
}

// Testcontainers' Ryuk image: pinned and allow-listed like compose images.
failures.push(
  ...pinnedImageProblems(
    RYUK_IMAGE,
    "tooling/vitest/index.mjs RYUK_IMAGE",
    allowedImageRefs(
      await readFile(path.join(root, "docs/DEPENDENCIES.md"), "utf8"),
    ),
  ),
);

// Integration tests (P2-02, ADR 0035). Smoke packages' fixtures/ are
// excluded: they are run by those packages' own checks.
/**
 * @param {string} dir
 * @returns {AsyncGenerator<string>}
 */
async function* intTestFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!skippedDirs.has(entry.name) && entry.name !== "fixtures") {
        yield* intTestFiles(path.join(dir, entry.name));
      }
    } else if (/\.int\.test\.[cm]?[jt]sx?$/.test(entry.name)) {
      yield path.join(dir, entry.name);
    }
  }
}
let integrationPackages = 0;
let integrationFiles = 0;
for (const group of Object.keys(requiredByGroup)) {
  for (const entry of await readdir(path.join(root, group), {
    withFileTypes: true,
  })) {
    const dir = path.join(root, group, entry.name);
    if (!entry.isDirectory() || !existsSync(path.join(dir, "package.json"))) {
      continue;
    }
    const pkg = await readManifest(
      path.relative(root, path.join(dir, "package.json")),
    );
    /** @type {string[]} */
    const intTests = [];
    for await (const file of intTestFiles(dir)) {
      intTests.push(path.relative(dir, file));
    }
    const configPath = path.join(dir, "vitest.integration.config.mts");
    const scripts = pkg.scripts ?? {};
    if (scripts["test:integration"] !== undefined) integrationPackages += 1;
    integrationFiles += intTests.length;
    failures.push(
      ...integrationScriptProblems({
        label: `${group}/${entry.name}`,
        scripts,
        intTests,
        ...(existsSync(configPath)
          ? { config: await readFile(configPath, "utf8") }
          : {}),
      }),
    );
  }
}
if (integrationPackages === 0) {
  failures.push(
    "test:integration: no package defines it, so `pnpm test:integration` would run nothing (ADR 0035)",
  );
}
if (rootScripts["test:integration"] !== "turbo run test:integration") {
  failures.push(
    'package.json: "test:integration" must be "turbo run test:integration" (ADR 0035)',
  );
}
/** @type {unknown} */
const turboParsed = JSON.parse(
  await readFile(path.join(root, "turbo.json"), "utf8"),
);
const turbo = /** @type {{ tasks?: Record<string, { cache?: boolean }> }} */ (
  turboParsed
);
if (turbo.tasks?.["test:integration"]?.cache !== false) {
  failures.push(
    'turbo.json: "test:integration" must set "cache": false; integration results are never cached (ADR 0035)',
  );
}

// Audit ignores (P1-06b, ADR 0037), on the real workspace and today's date.
const audit = await repoAuditIgnores(
  root,
  new Date().toISOString().slice(0, 10),
);
failures.push(...audit.problems);
for (const warning of audit.warnings) console.warn(`WARNING: ${warning}`);

const prTitle = await prTitleStepProblems(root);
failures.push(...prTitle.problems);
let workflowUses = 0;
for (const [file, kind] of workflowFiles) {
  const { problems, uses } = workflowProblems(
    await readFile(file, "utf8"),
    path.relative(root, file),
    kind,
  );
  workflowUses += uses;
  failures.push(...problems);
}
if (
  !workflowFiles.some(([, kind]) => kind === "workflow") ||
  workflowUses === 0
) {
  failures.push(
    ".github/workflows: no workflow with pinned actions found; CI is the gate (ADR 0030, ADR 0031)",
  );
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  console.error(
    "\ncheck:workspace FAILED: apps/ and packages/ need typecheck, lint and test scripts and a vitest config using @bricx/vitest-config; tooling/ needs typecheck and lint; no pass-on-no-tests anywhere; @eslint/js shares eslint's major; git hooks fail closed; dependencies exact and allow-listed; workflows follow ADR 0031; the compose stack pins images, binds ports to 127.0.0.1 and has healthchecks; the bootstrap superuser stays in the postgres service; integration tests run through test:integration, uncached; audit ignores follow ADR 0037",
  );
  process.exit(1);
}
console.log(
  `check:workspace passed: ${String(checked)} packages have their required scripts (apps/ and packages/ also run tests through @bricx/vitest-config); ${String(scanned)} config files free of ${noTestsOption}; eslint ${eslintPin ?? ""} and @eslint/js ${eslintJsPin ?? ""} share a major; git hooks fail closed with gitleaks ${gitleaks.version}; ${String(dependencies)} dependencies in ${String(manifests)} package.json files are exact and listed in docs/DEPENDENCIES.md; ${String(workflowFiles.length)} workflow/action files (${String(workflowUses)} uses) follow ADR 0031; ${String(compose.services)} compose services are digest-pinned, allow-listed, bound to 127.0.0.1 and health-checked; ${String(repoFiles.length)} files keep the bootstrap superuser in the postgres service; the Ryuk image is pinned and listed; ${String(integrationFiles)} integration test files in ${String(integrationPackages)} package(s) run through uncached test:integration; ${String(audit.ignores.length)} audit ignore(s) recorded in Accepted ADRs, unexpired and unreachable from apps/ and packages/ (${audit.ignores.map((i) => `${i.id} ${i.package} until ${i.revisitBy}`).join(", ")}); ${String(fixtureCases)} guard fixtures behave as expected; the pr-title step passes ${String(prTitle.cases)} simulated push/pull_request cases`,
);
