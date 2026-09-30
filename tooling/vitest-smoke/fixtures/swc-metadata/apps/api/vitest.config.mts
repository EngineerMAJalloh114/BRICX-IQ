import path from "node:path";
import { swcPreset } from "@bricx/vitest-config";

// workspaceRoot is this fixture case's own directory, so the strict paths
// resolve inside the fixture instead of against the real repo.
export default swcPreset({
  packageDir: import.meta.dirname,
  workspaceRoot: path.resolve(import.meta.dirname, "../.."),
});
