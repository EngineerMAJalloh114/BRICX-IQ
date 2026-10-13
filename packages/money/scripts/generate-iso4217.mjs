// Generates packages/money/data/iso4217.json (P3-02, ADR 0045).
//
//   node scripts/generate-iso4217.mjs              download the pinned mirror
//                                                  snapshot, then regenerate
//   node scripts/generate-iso4217.mjs --offline    regenerate from the
//                                                  committed snapshot only
//   node scripts/generate-iso4217.mjs --source six [--list-one F --list-three F]
//       compare the committed file with the SIX lists (downloaded, or the
//       files given); prints every difference, writes nothing, exits 1 on
//       any difference. The owner's cross-check before merge.
//
// The SIX host is unreachable from the agent container (proxy 403), so the
// committed data comes from github.com/datasets/currency-codes pinned to a
// commit (ODC-PDDL-1.0), which builds its CSV from the same SIX files.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import {
  buildDocument,
  compareEntries,
  fromMirrorCsv,
  fromSixXml,
  serialize,
} from "./iso4217-lib.mjs";

const COMMIT = "ab9b0ae88e8bffd4ac1c468ce9c784738d3376ba";
const COMMIT_DATE = "2026-02-01T02:10:25Z";
const MIRROR_URL = `https://raw.githubusercontent.com/datasets/currency-codes/${COMMIT}/data/codes-all.csv`;
const SIX_BASE =
  "https://www.six-group.com/dam/download/financial-information/data-center/iso-currrency/lists";
const SIX_LIST_ONE = `${SIX_BASE}/list-one.xml`;
const SIX_LIST_THREE = `${SIX_BASE}/list-three.xml`;

const dataDir = path.join(import.meta.dirname, "../data");
const snapshotPath = path.join(dataDir, "source/codes-all.csv");
const sourcePath = path.join(dataDir, "source/source.json");
const outPath = path.join(dataDir, "iso4217.json");

/** @param {string} url */
async function download(url) {
  const response = await fetch(url);
  if (!response.ok)
    throw new Error(`download failed: HTTP ${String(response.status)}`);
  return response.text();
}

const { values } = parseArgs({
  options: {
    offline: { type: "boolean", default: false },
    source: { type: "string", default: "mirror" },
    "list-one": { type: "string" },
    "list-three": { type: "string" },
  },
  strict: true,
});

if (values.source === "six") {
  const listOne =
    values["list-one"] === undefined
      ? await download(SIX_LIST_ONE)
      : await readFile(values["list-one"], "utf8");
  const listThree =
    values["list-three"] === undefined
      ? await download(SIX_LIST_THREE)
      : await readFile(values["list-three"], "utf8");
  /** @type {unknown} */
  const committedJson = JSON.parse(await readFile(outPath, "utf8"));
  const committed =
    /** @type {{ currencies: import("./iso4217-lib.mjs").Entry[] }} */ (
      committedJson
    );
  const diff = compareEntries(
    committed.currencies,
    fromSixXml(listOne, listThree),
  );
  const published = /Pblshd="([^"]+)"/.exec(listOne)?.[1] ?? "unknown";
  console.log(
    `SIX list-one published ${published}; committed source: datasets/currency-codes ${COMMIT}`,
  );
  if (diff.length === 0) {
    console.log("iso4217: the committed file matches SIX (0 differences)");
  } else {
    for (const line of diff) console.log(line);
    console.log(`iso4217: ${String(diff.length)} difference(s) from SIX`);
    process.exitCode = 1;
  }
} else if (values.source === "mirror") {
  if (!values.offline) {
    const csv = await download(MIRROR_URL);
    await writeFile(snapshotPath, csv);
    const source = {
      dataset: "datasets/currency-codes (GitHub)",
      url: MIRROR_URL,
      commit: COMMIT,
      commitDate: COMMIT_DATE,
      upstream: [SIX_LIST_ONE, SIX_LIST_THREE],
      licence: "ODC-PDDL-1.0",
      retrievedAt: new Date().toISOString().slice(0, 10),
      sha256: createHash("sha256").update(csv).digest("hex"),
    };
    await writeFile(sourcePath, serialize(source));
  }
  const csv = await readFile(snapshotPath, "utf8");
  /** @type {unknown} */
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  const entries = fromMirrorCsv(csv);
  await writeFile(outPath, serialize(buildDocument(entries, source)));
  const usable = entries.filter(
    (e) => !e.historical && e.exponent !== null,
  ).length;
  console.log(
    `iso4217: wrote ${String(entries.length)} entries (${String(usable)} usable for Money) to data/iso4217.json`,
  );
} else {
  console.error("--source must be mirror or six");
  process.exitCode = 2;
}
