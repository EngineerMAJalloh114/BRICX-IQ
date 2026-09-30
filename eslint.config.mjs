// Root ESLint config: every workspace package's `eslint .` resolves to this
// file. The rules live in @bricx/eslint-config (tooling/eslint).
import { bricxConfig } from "@bricx/eslint-config";

export default bricxConfig({
  rootDir: import.meta.dirname,
  // Deliberate violations; linted by tooling/eslint-smoke/check.mjs instead.
  ignores: ["tooling/eslint-smoke/fixtures/**"],
});
