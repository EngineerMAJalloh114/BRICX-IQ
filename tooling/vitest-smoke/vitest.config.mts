import { defaultPreset } from "@bricx/vitest-config";

// Runs src/ only; fixtures/ are separate workspaces run by check.mjs.
export default defaultPreset({ packageDir: import.meta.dirname });
