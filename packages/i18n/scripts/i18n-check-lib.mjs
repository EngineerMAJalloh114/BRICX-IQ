// The loader behind `pnpm i18n:check` (ADR 0046): reads a package tree's
// locales/<locale>/<namespace>.json files and glossary.json, bounds each
// file's size before JSON.parse, runs checkCatalogs on the parsed values,
// and compares src/generated/keys.ts with the generator's output. Lines name
// the file, the problem code and the key, never message text.
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { checkCatalogs } from "../src/check.ts";
import { generateKeysModule } from "../src/keys-gen.ts";
import { LIMITS } from "../src/limits.ts";
import { NAMESPACES, SUPPORTED_LOCALES } from "../src/locale.ts";

/** @typedef {import("../src/check.ts").Problem} Problem */

/**
 * Reads a JSON file with the size cap applied first.
 * @param {string} file
 * @returns {Promise<{ ok: true, value: unknown } | { ok: false, code: "missing_file" | "file_too_large" | "invalid_json" }>}
 */
async function readJson(file) {
  let size;
  try {
    size = (await stat(file)).size;
  } catch {
    return { ok: false, code: "missing_file" };
  }
  if (size > LIMITS.catalogBytes) return { ok: false, code: "file_too_large" };
  try {
    return { ok: true, value: JSON.parse(await readFile(file, "utf8")) };
  } catch {
    return { ok: false, code: "invalid_json" };
  }
}

/** @param {string} dir */
async function entries(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** @param {Problem} p */
function fileOf(p) {
  if (p.code === "stale_generated") return "src/generated/keys.ts";
  if (p.namespace === undefined) return "glossary.json";
  return `locales/${p.locale ?? ""}/${p.namespace}.json`;
}

/**
 * @param {string} file
 * @param {string} code
 * @param {string | undefined} key
 */
const line = (file, code, key) =>
  `${file}: ${code}${key === undefined ? "" : ` ${key}`}`;

/**
 * Checks the i18n package tree at `root`.
 * @param {string} root
 * @returns {Promise<{ lines: string[], summary: { locales: number, namespaces: number, keys: number, terms: number } }>}
 */
export async function checkTree(root) {
  /** @type {string[]} */
  const lines = [];
  /** @type {Record<string, Record<string, unknown>>} */
  const catalogs = {};
  /** @type {Set<string>} */
  const unreadable = new Set();
  const localesDir = path.join(root, "locales");

  for (const dirent of await entries(localesDir)) {
    if (!SUPPORTED_LOCALES.includes(/** @type {never} */ (dirent.name))) {
      lines.push(line(`locales/${dirent.name}`, "unexpected_file", undefined));
    }
  }
  for (const locale of SUPPORTED_LOCALES) {
    /** @type {Record<string, unknown>} */
    const byNamespace = {};
    catalogs[locale] = byNamespace;
    const expected = new Set(NAMESPACES.map((ns) => `${ns}.json`));
    for (const dirent of await entries(path.join(localesDir, locale))) {
      if (!dirent.isFile() || !expected.has(dirent.name)) {
        lines.push(
          line(
            `locales/${locale}/${dirent.name}`,
            "unexpected_file",
            undefined,
          ),
        );
      }
    }
    for (const namespace of NAMESPACES) {
      const result = await readJson(
        path.join(localesDir, locale, `${namespace}.json`),
      );
      if (result.ok) {
        byNamespace[namespace] = result.value;
      } else if (result.code !== "missing_file") {
        // checkCatalogs reports missing files itself.
        unreadable.add(`${locale}/${namespace}`);
        lines.push(
          line(`locales/${locale}/${namespace}.json`, result.code, undefined),
        );
      }
    }
  }

  const glossaryRead = await readJson(path.join(root, "glossary.json"));
  /** @type {unknown} */
  let glossary;
  if (glossaryRead.ok) glossary = glossaryRead.value;
  else if (glossaryRead.code !== "missing_file")
    lines.push(line("glossary.json", glossaryRead.code, undefined));

  /** @type {Problem[]} */
  const problems = checkCatalogs({ catalogs, glossary, unreadable });
  if (!glossaryRead.ok && glossaryRead.code !== "missing_file") {
    // Already reported as file_too_large or invalid_json.
    const i = problems.findIndex(
      (p) => p.code === "glossary_invalid" && p.key === undefined,
    );
    if (i !== -1) problems.splice(i, 1);
  }
  for (const p of problems) {
    const key =
      p.namespace === undefined && p.locale !== undefined && p.key !== undefined
        ? `${p.key} ${p.locale}`
        : p.key;
    lines.push(line(fileOf(p), p.code, key));
  }

  // The generated keys: compared only when every en catalog was read and
  // has no problem of its own. An en problem is reported above; comparing
  // too would add a second line for the same mistake (the generator leaves
  // out a message the checker rejects).
  const enClean =
    NAMESPACES.every(
      (ns) => !unreadable.has(`en/${ns}`) && catalogs["en"]?.[ns] !== undefined,
    ) && !problems.some((p) => p.locale === "en" && p.namespace !== undefined);
  if (enClean) {
    const generated = generateKeysModule(
      /** @type {Record<string, Record<string, unknown>>} */ (catalogs["en"]),
    );
    /** @type {string | undefined} */
    let committed;
    try {
      committed = await readFile(
        path.join(root, "src/generated/keys.ts"),
        "utf8",
      );
    } catch {
      committed = undefined;
    }
    if (committed !== generated)
      lines.push(line("src/generated/keys.ts", "stale_generated", undefined));
  }

  const en = catalogs["en"] ?? {};
  const keys = NAMESPACES.reduce((n, ns) => {
    const c = en[ns];
    return (
      n + (typeof c === "object" && c !== null ? Object.keys(c).length : 0)
    );
  }, 0);
  const terms =
    typeof glossary === "object" &&
    glossary !== null &&
    "terms" in glossary &&
    typeof glossary.terms === "object" &&
    glossary.terms !== null
      ? Object.keys(glossary.terms).length
      : 0;
  return {
    lines,
    summary: {
      locales: SUPPORTED_LOCALES.length,
      namespaces: NAMESPACES.length,
      keys,
      terms,
    },
  };
}
