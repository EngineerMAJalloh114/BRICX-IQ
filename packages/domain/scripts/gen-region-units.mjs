// Generates data/region-units.json from data/source/measurement-data.xml, the
// <measurementData> element of CLDR's supplementalData.xml pinned in
// data/source/source.json (P3-06 ruling 1, ADR 0049).
//   node scripts/gen-region-units.mjs            write data/region-units.json
//   node scripts/gen-region-units.mjs --stdout   print it instead
//   node scripts/gen-region-units.mjs --check    exit 1 if the file is stale
//   node scripts/gen-region-units.mjs --extract <supplementalData.xml>
//       print the element to snapshot from a downloaded CLDR file
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { extractMeasurementData, regionUnitsJson } from "./region-lib.mjs";

const pkgDir = path.join(import.meta.dirname, "..");
const arg = process.argv[2];

if (arg === "--extract") {
  const file = process.argv[3];
  if (file === undefined) {
    console.error(
      "usage: gen-region-units.mjs --extract <supplementalData.xml>",
    );
    process.exit(2);
  }
  process.stdout.write(extractMeasurementData(readFileSync(file, "utf8")));
  process.exit(0);
}

/** @type {unknown} */
const parsedSource = JSON.parse(
  readFileSync(path.join(pkgDir, "data/source/source.json"), "utf8"),
);
const source =
  /** @type {{ measurementData: import("./region-lib.mjs").MeasurementSource }} */ (
    parsedSource
  ).measurementData;
const snapshot = readFileSync(
  path.join(pkgDir, "data/source", source.snapshot),
  "utf8",
);
const sha = createHash("sha256").update(snapshot, "utf8").digest("hex");
if (sha !== source.snapshotSha256) {
  console.error(
    "region-units: the snapshot does not match its recorded SHA-256",
  );
  process.exit(1);
}
const out = regionUnitsJson(snapshot, source);
const target = path.join(pkgDir, "data/region-units.json");
if (arg === "--stdout") {
  process.stdout.write(out);
} else if (arg === "--check") {
  const current = readFileSync(target, "utf8");
  if (current !== out) {
    console.error(
      "region-units: data/region-units.json is stale; run gen:region-units",
    );
    process.exit(1);
  }
  console.log("region-units: data/region-units.json is current");
} else if (arg === undefined) {
  writeFileSync(target, out);
  console.log("wrote data/region-units.json");
} else {
  console.error(
    "usage: gen-region-units.mjs [--stdout | --check | --extract <file>]",
  );
  process.exit(2);
}
