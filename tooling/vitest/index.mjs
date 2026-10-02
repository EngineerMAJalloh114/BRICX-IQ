// @bricx/vitest-config: shared Vitest presets for BRICX IQ (ROADMAP P1-04).
// Every package's vitest.config.mts calls defaultPreset or swcPreset; the
// root vitest.config.mts runs all packages as projects with coverageConfig.
// Every behaviour below is proven by a fixture in tooling/vitest-smoke.
import { existsSync } from "node:fs";
import path from "node:path";
import swc from "unplugin-swc";

/** Workspace-relative directories that need 95% line coverage. */
export const STRICT_PATHS = [
  "packages/money",
  "packages/permissions",
  "apps/api/src/modules/ledger",
];
export const STRICT_LINES = 95;
export const DEFAULT_LINES = 70;

const SOURCE = "{ts,tsx,mts,cts}";

/**
 * Nearest directory at or above `fromDir` that holds pnpm-workspace.yaml.
 * @param {string} fromDir
 * @returns {string}
 */
export function findWorkspaceRoot(fromDir) {
  let dir = path.resolve(fromDir);
  for (;;) {
    if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error(`No pnpm-workspace.yaml at or above ${fromDir}`);
    }
    dir = parent;
  }
}

/**
 * Line thresholds for a Vitest run rooted at `root`. Vitest matches glob
 * thresholds against paths relative to its root, so each strict path is
 * rewritten relative to `root`: `**` inside packages/money,
 * `src/modules/ledger/**` inside apps/api, `packages/money/**` at the repo
 * root. Strict paths outside `root` are left out.
 * @param {{ root: string, workspaceRoot: string }} options
 * @returns {Record<string, number | { lines: number }>}
 */
export function coverageThresholds({ root, workspaceRoot }) {
  /** @type {Record<string, number | { lines: number }>} */
  const thresholds = { lines: DEFAULT_LINES };
  for (const strict of STRICT_PATHS) {
    const rel = path
      .relative(root, path.join(workspaceRoot, strict))
      .split(path.sep)
      .join("/");
    if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) {
      continue;
    }
    thresholds[rel === "" ? "**" : `${rel}/**`] = { lines: STRICT_LINES };
  }
  return thresholds;
}

/**
 * v8 coverage over every source file under `include`, tested or not.
 * `enabled: true` runs coverage and its thresholds on every run, so a plain
 * `vitest run` without --coverage cannot skip them.
 * @param {{ root: string, workspaceRoot: string, include?: string[] }} options
 */
export function coverageConfig({
  root,
  workspaceRoot,
  include = [`src/**/*.${SOURCE}`],
}) {
  return {
    enabled: true,
    provider: /** @type {const} */ ("v8"),
    include,
    exclude: [`**/*.{test,spec}.${SOURCE}`, "**/*.d.ts"],
    reporter: ["text", "json-summary"],
    thresholds: coverageThresholds({ root, workspaceRoot }),
  };
}

/**
 * @typedef {object} PresetOptions
 * @property {string} packageDir The package's directory (import.meta.dirname).
 * @property {string} [workspaceRoot] Defaults to the nearest pnpm workspace
 *   root; vitest-smoke fixtures pass their own.
 */

/**
 * Default preset: tests in src/ and test/, v8 coverage with path thresholds.
 * @param {PresetOptions} options
 */
export function defaultPreset({
  packageDir,
  workspaceRoot = findWorkspaceRoot(packageDir),
}) {
  return {
    root: packageDir,
    test: {
      include: [`{src,test}/**/*.{test,spec}.${SOURCE}`],
      // Integration tests need Docker; they run only through integrationPreset.
      exclude: [`**/*.int.test.${SOURCE}`, "**/node_modules/**"],
      coverage: coverageConfig({ root: packageDir, workspaceRoot }),
    },
  };
}

/**
 * swc preset for NestJS (apps/api, apps/worker at P4): swc compiles
 * TypeScript with legacy decorators and emits decorator metadata
 * (`design:paramtypes`), which Vite's default transform does not.
 * @param {PresetOptions} options
 */
export function swcPreset(options) {
  return {
    ...defaultPreset(options),
    plugins: [
      swc.vite({
        tsconfigFile: false,
        include: /\.[cm]?tsx?$/,
        jsc: {
          target: "es2022",
          keepClassNames: true,
          parser: { syntax: "typescript", decorators: true },
          transform: { legacyDecorator: true, decoratorMetadata: true },
        },
      }),
    ],
  };
}

/**
 * Testcontainers' cleanup container (Ryuk), pinned by digest and listed in
 * docs/DEPENDENCIES.md section 8 (ADR 0035); check:workspace fails if it
 * is not, and db-bootstrap's integration tests prove it is the image used.
 */
export const RYUK_IMAGE =
  "testcontainers/ryuk:0.14.0@sha256:7c1a8a9a47c780ed0f983770a662f80deb115d95cce3e2daa3d12115b8cd28f0";

/**
 * Integration preset (P2-02, ADR 0035): `*.int.test.*` files only, against
 * real containers (Testcontainers), run by a package's `test:integration`
 * script from a `vitest.integration.config.mts`, so the root and unit runs
 * never pick them up. No coverage (the code under test is SQL and
 * container config), no retries, files one at a time (each starts its own
 * containers). Zero test files fail, as everywhere.
 * @param {{ packageDir: string }} options
 */
export function integrationPreset({ packageDir }) {
  return {
    root: packageDir,
    test: {
      include: [`{src,test}/**/*.int.test.${SOURCE}`],
      coverage: { enabled: false },
      retry: 0,
      fileParallelism: false,
      testTimeout: 120_000,
      hookTimeout: 300_000,
      // testcontainers 12 reads RYUK_CONTAINER_IMAGE (not the TESTCONTAINERS_-prefixed
      // name some docs give); db-bootstrap proves the pinned image runs.
      env: { RYUK_CONTAINER_IMAGE: RYUK_IMAGE },
    },
  };
}
