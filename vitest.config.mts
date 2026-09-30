// Root Vitest config: runs every workspace package as a project, for
// whole-repo and editor runs (`pnpm exec vitest`). `pnpm test` runs each
// package's own `test` script through turbo instead, so results are cached
// per package. The presets live in @bricx/vitest-config (tooling/vitest).
import { coverageConfig } from "@bricx/vitest-config";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

export default defineConfig({
  test: {
    projects: ["{apps,packages,tooling}/*/vitest.config.mts"],
    // Project configs cannot set coverage; the root run applies the same
    // path-keyed thresholds across the whole repo.
    coverage: coverageConfig({
      root,
      workspaceRoot: root,
      include: ["{apps,packages,tooling}/*/src/**/*.{ts,tsx,mts,cts}"],
    }),
  },
});
