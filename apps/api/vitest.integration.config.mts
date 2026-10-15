import { integrationPreset, swcPreset } from "@bricx/vitest-config";

// Integration tests only (*.int.test.ts, Docker required), run by
// `pnpm test:integration`. Nest needs decorator metadata, so the swc
// transform from swcPreset is added to the integration preset.
export default {
  ...integrationPreset({ packageDir: import.meta.dirname }),
  plugins: swcPreset({ packageDir: import.meta.dirname }).plugins,
};
