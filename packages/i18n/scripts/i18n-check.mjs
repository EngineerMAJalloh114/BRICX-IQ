// `pnpm i18n:check` (ADR 0046): checks the catalogs, the glossary and the
// generated keys of this package (or of --root <dir>). Exit 0 when clean,
// 1 with one line per problem on stderr, 2 on a usage error.
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { checkTree } from "./i18n-check-lib.mjs";

/** @type {{ root?: string | undefined }} */
let values;
try {
  ({ values } = parseArgs({
    args: process.argv.slice(2),
    options: { root: { type: "string" } },
    strict: true,
  }));
} catch {
  process.stderr.write("usage: i18n-check.mjs [--root <dir>]\n");
  process.exit(2);
}

const root = path.resolve(values.root ?? path.join(import.meta.dirname, ".."));
const { lines, summary } = await checkTree(root);
if (lines.length === 0) {
  process.stdout.write(
    `i18n:check passed: ${String(summary.locales)} locales x ${String(summary.namespaces)} namespaces, ${String(summary.keys)} keys, ${String(summary.terms)} glossary terms\n`,
  );
} else {
  process.stderr.write(`${lines.join("\n")}\n`);
  process.stderr.write(
    `i18n:check FAILED: ${String(lines.length)} problem${lines.length === 1 ? "" : "s"}\n`,
  );
  process.exitCode = 1;
}
