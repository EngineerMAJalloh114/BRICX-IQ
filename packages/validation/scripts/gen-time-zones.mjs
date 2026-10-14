// Generates data/time-zones.json from data/source/tzdb-2026e.tsv, the Zone
// and Link names of IANA tzdb 2026e (public domain), and data/source/zone.tab
// (tzdb 2026e, unchanged), both pinned in data/source/source.json (P3-04,
// ADR 0047). A zone.tab name is canonical for itself.
//   node scripts/gen-time-zones.mjs                  write data/time-zones.json
//   node scripts/gen-time-zones.mjs --stdout         print it instead
//   node scripts/gen-time-zones.mjs --check          exit 1 if the file is stale
//   node scripts/gen-time-zones.mjs --from-dir DIR   re-extract the snapshot from
//       a checkout of https://github.com/eggert/tz at the pinned commit, verify
//       every file's SHA-256 (zone.tab included) and exit 1 if the committed
//       snapshot or zone.tab differs
//   node scripts/gen-time-zones.mjs --source tzdb    the same, downloading the
//       files from raw.githubusercontent.com at the pinned commit
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { extractTzLines, timeZonesJson } from "./data-lib.mjs";

const pkgDir = path.join(import.meta.dirname, "..");
/** @type {unknown} */
const parsedSource = JSON.parse(
  readFileSync(path.join(pkgDir, "data/source/source.json"), "utf8"),
);
const source = /** @type {{ tzdb: import("./data-lib.mjs").TzSource }} */ (
  parsedSource
);
const snapshotPath = path.join(pkgDir, "data/source", source.tzdb.snapshot);
const zoneTabPath = path.join(pkgDir, "data/source", source.tzdb.zoneTab.file);
const target = path.join(pkgDir, "data/time-zones.json");
/** @param {string} text */
const sha256 = (text) =>
  createHash("sha256").update(text, "utf8").digest("hex");

/**
 * Compares freshly extracted files with the committed snapshot, and the
 * upstream zone.tab with the committed copy.
 * @param {{ name: string, text: string }[]} files
 * @param {string} zoneTab
 */
function compareUpstream(files, zoneTab) {
  let problems = 0;
  if (sha256(zoneTab) !== source.tzdb.zoneTab.sha256) {
    console.error("tzdb: zone.tab does not match its recorded SHA-256");
    problems += 1;
  }
  if (zoneTab !== readFileSync(zoneTabPath, "utf8")) {
    console.error("tzdb: the committed zone.tab differs from upstream");
    problems += 1;
  }
  for (const { name, text } of files) {
    if (sha256(text) !== source.tzdb.files[name]) {
      console.error(`tzdb: ${name} does not match its recorded SHA-256`);
      problems += 1;
    }
  }
  const fresh = extractTzLines(files);
  if (fresh !== readFileSync(snapshotPath, "utf8")) {
    console.error(
      "tzdb: the committed snapshot differs from the extracted files",
    );
    problems += 1;
  }
  if (problems > 0) process.exit(1);
  console.log(
    `tzdb ${source.tzdb.release}: the committed snapshot and zone.tab match upstream (0 differences)`,
  );
}

const [arg, value] = process.argv.slice(2);
const names = Object.keys(source.tzdb.files);
if (arg === "--from-dir" && value !== undefined) {
  compareUpstream(
    names.map((name) => ({
      name,
      text: readFileSync(path.join(value, name), "utf8"),
    })),
    readFileSync(path.join(value, "zone.tab"), "utf8"),
  );
} else if (arg === "--source" && value === "tzdb") {
  const base = `https://raw.githubusercontent.com/eggert/tz/${source.tzdb.commit}`;
  /** @type {{ name: string, text: string }[]} */
  const files = [];
  for (const name of names) {
    const response = await fetch(`${base}/${name}`);
    if (!response.ok) {
      console.error(`tzdb: download of ${name} failed`);
      process.exit(1);
    }
    files.push({ name, text: await response.text() });
  }
  const zoneTabResponse = await fetch(`${base}/zone.tab`);
  if (!zoneTabResponse.ok) {
    console.error("tzdb: download of zone.tab failed");
    process.exit(1);
  }
  compareUpstream(files, await zoneTabResponse.text());
} else {
  const snapshot = readFileSync(snapshotPath, "utf8");
  if (sha256(snapshot) !== source.tzdb.snapshotSha256) {
    console.error("tzdb: the snapshot does not match its recorded SHA-256");
    process.exit(1);
  }
  const zoneTab = readFileSync(zoneTabPath, "utf8");
  if (sha256(zoneTab) !== source.tzdb.zoneTab.sha256) {
    console.error("tzdb: zone.tab does not match its recorded SHA-256");
    process.exit(1);
  }
  const out = timeZonesJson(snapshot, source.tzdb, zoneTab);
  if (arg === "--stdout") {
    process.stdout.write(out);
  } else if (arg === "--check") {
    if (readFileSync(target, "utf8") !== out) {
      console.error("tzdb: data/time-zones.json is stale; run gen:time-zones");
      process.exit(1);
    }
    console.log("tzdb: data/time-zones.json is current");
  } else if (arg === undefined) {
    writeFileSync(target, out);
    console.log("wrote data/time-zones.json");
  } else {
    console.error(
      "usage: gen-time-zones.mjs [--stdout | --check | --from-dir DIR | --source tzdb]",
    );
    process.exit(2);
  }
}
