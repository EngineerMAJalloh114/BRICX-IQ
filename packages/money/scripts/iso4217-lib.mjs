// Pure transforms behind generate-iso4217.mjs (P3-02, ADR 0045). No I/O
// here, so test/iso4217-data.test.ts can rerun them offline on the
// committed snapshot and require a byte-identical data/iso4217.json.

/**
 * @typedef {{
 *   code: string,
 *   numeric: string | null,
 *   name: string,
 *   exponent: number | null,
 *   historical: boolean,
 *   withdrawn: string | null,
 * }} Entry
 */

const CODE = /^[A-Z]{3}$/;
const NUMERIC = /^\d{3}$/;
const MINOR = /^\d$/;
const MIRROR_HEADER =
  "Entity,Currency,AlphabeticCode,NumericCode,MinorUnit,WithdrawalDate";

/**
 * RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charAt(i);
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') {
        quoted = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  if (quoted) throw new Error("CSV: unterminated quoted field");
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * A currency name with leading and trailing whitespace removed and every
 * internal whitespace run (including U+00A0) collapsed to one U+0020. Both
 * sources go through merge(), so the generator and the --source six
 * comparison normalise names the same way (KMF "Comorian Franc " in the
 * mirror, ZWL's no-break space).
 * @param {string} name
 */
export const normalizeName = (name) => name.trim().replace(/\s+/gu, " ");

/**
 * @param {string} code
 * @param {string} numeric
 * @param {number} line
 */
function checkCodes(code, numeric, line) {
  if (!CODE.test(code))
    throw new Error(`row ${String(line)}: bad alphabetic code`);
  if (numeric !== "" && !NUMERIC.test(numeric)) {
    throw new Error(`row ${String(line)}: bad numeric code`);
  }
}

/**
 * Merges current and withdrawn rows into one entry per code, sorted by
 * code. Current rows win; rows for one current code must agree. A code that
 * is only withdrawn keeps its latest withdrawal row.
 * @param {{ code: string, numeric: string, name: string, minor: string, withdrawn: string, line: number }[]} rows
 * @returns {Entry[]}
 */
function merge(rows) {
  /** @type {Map<string, Entry>} */
  const current = new Map();
  /** @type {Map<string, Entry>} */
  const withdrawn = new Map();
  for (const raw of rows) {
    if (raw.code === "") continue; // "No universal currency"
    const r = { ...raw, name: normalizeName(raw.name) };
    checkCodes(r.code, r.numeric, r.line);
    const numeric = r.numeric === "" ? null : r.numeric;
    if (r.withdrawn === "") {
      /** @type {number | null} */
      let exponent = null;
      if (MINOR.test(r.minor)) exponent = Number.parseInt(r.minor, 10);
      else if (r.minor !== "-" && r.minor !== "N.A.") {
        throw new Error(`row ${String(r.line)}: bad minor unit`);
      }
      /** @type {Entry} */
      const entry = {
        code: r.code,
        numeric,
        name: r.name,
        exponent,
        historical: false,
        withdrawn: null,
      };
      const seen = current.get(r.code);
      if (
        seen !== undefined &&
        (seen.numeric !== entry.numeric ||
          seen.name !== entry.name ||
          seen.exponent !== entry.exponent)
      ) {
        throw new Error(
          `row ${String(r.line)}: conflicting current entries for one code`,
        );
      }
      current.set(r.code, entry);
    } else {
      const seen = withdrawn.get(r.code);
      if (seen === undefined || (seen.withdrawn ?? "") <= r.withdrawn) {
        withdrawn.set(r.code, {
          code: r.code,
          numeric,
          name: r.name,
          exponent: null,
          historical: true,
          withdrawn: r.withdrawn,
        });
      }
    }
  }
  for (const [code, entry] of withdrawn) {
    if (!current.has(code)) current.set(code, entry);
  }
  return [...current.values()].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  );
}

/**
 * Entries from datasets/currency-codes data/codes-all.csv (built from the
 * SIX list-one and list-three files).
 * @param {string} csvText
 * @returns {Entry[]}
 */
export function fromMirrorCsv(csvText) {
  const [head, ...body] = parseCsv(csvText);
  if (head === undefined || head.join(",") !== MIRROR_HEADER) {
    throw new Error("CSV: unexpected header");
  }
  return merge(
    body.map((cells, i) => ({
      name: cells[1] ?? "",
      code: cells[2] ?? "",
      numeric: cells[3] ?? "",
      minor: cells[4] ?? "",
      withdrawn: cells[5] ?? "",
      line: i + 2,
    })),
  );
}

/** @param {string} s */
const decodeXml = (s) =>
  s
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");

/**
 * Text of the first <tag ...>...</tag> inside `block`, or "".
 * @param {string} block
 * @param {"CcyNm" | "Ccy" | "CcyNbr" | "CcyMnrUnts" | "WthdrwlDt"} tag
 */
function textOf(block, tag) {
  const open = block.indexOf(`<${tag}`);
  if (open === -1) return "";
  const after = block[open + tag.length + 1];
  if (after !== ">" && after !== " ")
    return textOf(block.slice(open + tag.length + 1), tag);
  const start = block.indexOf(">", open) + 1;
  const end = block.indexOf(`</${tag}>`, start);
  return end === -1 ? "" : decodeXml(block.slice(start, end).trim());
}

/**
 * The <entry>...</entry> blocks of an XML document.
 * @param {string} xml
 * @param {"CcyNtry" | "HstrcCcyNtry"} entry
 */
function blocks(xml, entry) {
  /** @type {string[]} */
  const found = [];
  let from = 0;
  for (;;) {
    const start = xml.indexOf(`<${entry}>`, from);
    if (start === -1) return found;
    const end = xml.indexOf(`</${entry}>`, start);
    if (end === -1) throw new Error("XML: unterminated entry");
    found.push(xml.slice(start, end));
    from = end;
  }
}

/**
 * Entries from the SIX files themselves: list-one.xml (current, Table A.1)
 * and list-three.xml (historic, Table A.3). For the owner's cross-check.
 * @param {string} listOne
 * @param {string} listThree
 * @returns {Entry[]}
 */
export function fromSixXml(listOne, listThree) {
  const current = blocks(listOne, "CcyNtry");
  if (current.length === 0) throw new Error("list-one.xml: no entries");
  let line = 0;
  const rows = [
    ...current.map((b) => ({
      name: textOf(b, "CcyNm"),
      code: textOf(b, "Ccy"),
      numeric: textOf(b, "CcyNbr"),
      minor: textOf(b, "CcyMnrUnts"),
      withdrawn: "",
      line: (line += 1),
    })),
    ...blocks(listThree, "HstrcCcyNtry").map((b) => ({
      name: textOf(b, "CcyNm"),
      code: textOf(b, "Ccy"),
      numeric: textOf(b, "CcyNbr"),
      minor: "",
      withdrawn: textOf(b, "WthdrwlDt"),
      line: (line += 1),
    })),
  ];
  return merge(rows);
}

/**
 * The committed document: source metadata, then the entries.
 * @param {Entry[]} entries
 * @param {unknown} source
 */
export function buildDocument(entries, source) {
  return {
    $comment:
      "GENERATED by packages/money/scripts/generate-iso4217.mjs from data/source/codes-all.csv; do not edit (ADR 0045).",
    source,
    currencies: entries,
  };
}

/** @param {unknown} doc */
export const serialize = (doc) => `${JSON.stringify(doc, null, 2)}\n`;

/**
 * Differences between the committed entries and a new source, one line each.
 * @param {Entry[]} committed
 * @param {Entry[]} fresh
 * @returns {string[]}
 */
export function compareEntries(committed, fresh) {
  const a = new Map(committed.map((e) => [e.code, e]));
  const b = new Map(fresh.map((e) => [e.code, e]));
  /** @type {string[]} */
  const out = [];
  const codes = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const code of codes) {
    const x = a.get(code);
    const y = b.get(code);
    if (y === undefined) out.push(`${code}: only in the committed file`);
    else if (x === undefined) out.push(`${code}: only in the new source`);
    else {
      for (const key of /** @type {const} */ ([
        "numeric",
        "name",
        "exponent",
        "historical",
        "withdrawn",
      ])) {
        if (x[key] !== y[key])
          out.push(`${code}: ${key} ${String(x[key])} -> ${String(y[key])}`);
      }
    }
  }
  return out;
}
