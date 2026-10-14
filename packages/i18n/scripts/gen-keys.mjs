// Writes src/generated/keys.ts from the en catalogs (ADR 0046 D6). Run
// `pnpm --filter @bricx/i18n gen:keys` after changing an en message;
// i18n:check fails while the committed file is stale.
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { generateKeysModule } from "../src/keys-gen.ts";
import { NAMESPACES } from "../src/locale.ts";

const pkgDir = path.join(import.meta.dirname, "..");
/** @type {Record<string, Record<string, unknown>>} */
const en = {};
for (const ns of NAMESPACES) {
  /** @type {unknown} */
  const parsed = JSON.parse(
    await readFile(path.join(pkgDir, "locales/en", `${ns}.json`), "utf8"),
  );
  en[ns] = /** @type {Record<string, unknown>} */ (parsed);
}
const out = path.join(pkgDir, "src/generated/keys.ts");
await writeFile(out, generateKeysModule(en));
process.stdout.write(`wrote ${path.relative(pkgDir, out)}\n`);
