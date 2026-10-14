// Generates data/countries.json from data/source/country-list.csv, a
// snapshot of datasets/country-list (PDDL) pinned in data/source/source.json
// (P3-04, ADR 0047).
//   node scripts/gen-countries.mjs            write data/countries.json
//   node scripts/gen-countries.mjs --stdout   print it instead
//   node scripts/gen-countries.mjs --check    exit 1 if the file is stale
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { countriesJson } from "./data-lib.mjs";

const pkgDir = path.join(import.meta.dirname, "..");
/** @type {unknown} */
const parsedSource = JSON.parse(
  readFileSync(path.join(pkgDir, "data/source/source.json"), "utf8"),
);
const source =
  /** @type {{ countries: import("./data-lib.mjs").CountrySource }} */ (
    parsedSource
  );
const csv = readFileSync(
  path.join(pkgDir, "data/source", source.countries.file),
  "utf8",
);
const sha = createHash("sha256").update(csv, "utf8").digest("hex");
if (sha !== source.countries.sha256) {
  console.error("countries: the snapshot does not match its recorded SHA-256");
  process.exit(1);
}
const out = countriesJson(csv, source.countries);
const target = path.join(pkgDir, "data/countries.json");
const arg = process.argv[2];
if (arg === "--stdout") {
  process.stdout.write(out);
} else if (arg === "--check") {
  const current = readFileSync(target, "utf8");
  if (current !== out) {
    console.error("countries: data/countries.json is stale; run gen:countries");
    process.exit(1);
  }
  console.log("countries: data/countries.json is current");
} else if (arg === undefined) {
  writeFileSync(target, out);
  console.log("wrote data/countries.json");
} else {
  console.error("usage: gen-countries.mjs [--stdout | --check]");
  process.exit(2);
}
