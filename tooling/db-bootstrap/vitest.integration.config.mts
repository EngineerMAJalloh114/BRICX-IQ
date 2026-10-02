import { integrationPreset } from "@bricx/vitest-config";

// Integration tests only (*.int.test.ts, Docker required), run by
// `pnpm test:integration`. Not a vitest.config.mts, so the root project
// run and unit runs never pick them up.
export default integrationPreset({ packageDir: import.meta.dirname });
