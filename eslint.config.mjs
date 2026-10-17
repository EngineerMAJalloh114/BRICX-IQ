// Root ESLint config: every workspace package's `eslint .` resolves to this
// file. The rules live in @bricx/eslint-config (tooling/eslint).
import { bricxConfig } from "@bricx/eslint-config";

export default bricxConfig({
  rootDir: import.meta.dirname,
  // Deliberate violations: linted by tooling/eslint-smoke/check.mjs, and
  // Semgrep's known-bad/known-good fixtures, scanned by
  // `node scripts/semgrep.mjs --selftest` (ADR 0043). @bricx/i18n's
  // generated files belong to its generators, and its i18n:check fixtures are
  // data trees (ADR 0046). @bricx/api-client's generated client belongs to
  // orval (ADR 0058).
  ignores: [
    "tooling/eslint-smoke/fixtures/**",
    "tooling/semgrep/selftest/**",
    "packages/i18n/src/generated/**",
    "packages/i18n/test/fixtures/**",
    "packages/api-client/src/generated/**",
  ],
});
