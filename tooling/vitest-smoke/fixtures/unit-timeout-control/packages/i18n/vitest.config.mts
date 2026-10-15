import path from "node:path";
import { defaultPreset } from "@bricx/vitest-config";

// The same 5.5 s test as unit-timeout-default with Vitest's 5000 ms default
// put back, so the passing cases pass because of the preset's timeout.
const preset = defaultPreset({
  packageDir: import.meta.dirname,
  workspaceRoot: path.resolve(import.meta.dirname, "../.."),
});

export default { ...preset, test: { ...preset.test, testTimeout: 5_000 } };
