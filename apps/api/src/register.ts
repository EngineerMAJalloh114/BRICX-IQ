// Loaded with `node --import ./dist/register.js` before main.js. Workspace
// packages (@bricx/*) export TypeScript source with `.js` relative
// specifiers (bundler resolution) and erasable syntax only; Node 24 strips
// their types natively, and this hook maps a missing `./x.js` to `./x.ts`
// inside the repository's packages/ folder only (never node_modules).
// apps/api itself is compiled by tsc (decorator metadata), so its own
// imports never need the hook. (P4-01; for architect review: P13-02's
// images may bundle instead.)
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tsFallbackResolver } from "./common/ts-resolve.js";

const here = path.dirname(fileURLToPath(import.meta.url));
registerHooks({
  resolve: tsFallbackResolver(
    path.resolve(here, "../../../packages") + path.sep,
  ),
});
