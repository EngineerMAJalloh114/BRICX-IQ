// Loaded with `node --import ./dist/register.js` before main.js, as in
// apps/api (P4-01, ADR 0051). Workspace packages (@bricx/*) export
// TypeScript source with `.js` relative specifiers; Node 24 strips their
// types natively, and this hook maps a missing `./x.js` to `./x.ts` inside
// the repository's packages/ folder only (never node_modules). The worker
// itself is compiled by tsc. (P4-06; for architect review, as for the API:
// P13-02's images may bundle instead.)
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsFallbackResolver } from "./ts-resolve.js";

const here = path.dirname(fileURLToPath(import.meta.url));
registerHooks({
  resolve: tsFallbackResolver(
    path.resolve(here, "../../../packages") + path.sep,
  ),
});
