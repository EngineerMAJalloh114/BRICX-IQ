// Pure transforms for data/region-units.json (P3-06 ruling 1, ADR 0049):
// the per-country unit system from CLDR supplemental measurementData. No
// I/O here: gen-region-units.mjs reads and writes files, and
// test/regions.test.ts runs these functions on the committed snapshot.
//
// CLDR systems map to this package's two: "metric" -> metric, "US" ->
// us_customary, "UK" -> metric (UK construction is metric). Rows with a
// category (temperature) and paperSize rows are not unit-system defaults
// and are skipped. The world row (territories="001") is the default and
// must be metric.

/**
 * @typedef {{ dataset: string, release: string, repository: string,
 *   commit: string, url: string, fileSha256: string, licence: string,
 *   licenceSha256: string, retrieved: string, snapshot: string,
 *   snapshotSha256: string }} MeasurementSource
 */

const SYSTEMS = Object.freeze({
  metric: "metric",
  US: "us_customary",
  UK: "metric",
});

const WORLD = "001";
const COUNTRY = /^[A-Z]{2}$/;
const ELEMENT =
  /^\s*<measurementSystem\s+type="([^"]*)"(?:\s+category="([^"]*)")?\s+territories="([^"]*)"\s*\/>\s*$/;

/**
 * The <measurementData> element of supplementalData.xml, verbatim, lines
 * from the opening tag to the closing tag inclusive.
 * @param {string} xml
 * @returns {string}
 */
export function extractMeasurementData(xml) {
  const lines = xml.split("\n");
  const start = lines.findIndex((l) => l.trim() === "<measurementData>");
  const end = lines.findIndex((l) => l.trim() === "</measurementData>");
  if (start === -1 || end === -1 || end < start)
    throw new Error("measurementData: element not found");
  return `${lines.slice(start, end + 1).join("\n")}\n`;
}

/**
 * region-units.json from the snapshot: the default system and one row per
 * country CLDR lists explicitly, sorted by code.
 * @param {string} snapshot the text of measurement-data.xml
 * @param {MeasurementSource} source
 * @returns {string}
 */
export function regionUnitsJson(snapshot, source) {
  const lines = snapshot.split("\n");
  if (lines[0]?.trim() !== "<measurementData>")
    throw new Error("measurementData: snapshot must start with the element");
  /** @type {string | undefined} */
  let world;
  /** @type {Map<string, { cldr: string, system: string }>} */
  const countries = new Map();
  for (const line of lines.slice(1)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed === "</measurementData>") continue;
    if (trimmed.startsWith("<!--") && trimmed.endsWith("-->")) continue;
    if (/^<paperSize\s[^<>]*\/>$/.test(trimmed)) continue;
    const m = ELEMENT.exec(line);
    if (m === null) throw new Error("measurementData: unexpected element");
    const [, type = "", category, territories = ""] = m;
    if (category !== undefined) continue;
    if (!Object.hasOwn(SYSTEMS, type))
      throw new Error("measurementData: unknown measurement system");
    const system = SYSTEMS[/** @type {keyof typeof SYSTEMS} */ (type)];
    for (const territory of territories.split(/\s+/).filter((t) => t !== "")) {
      if (territory === WORLD) {
        if (world !== undefined)
          throw new Error("measurementData: two world rows");
        if (system !== "metric")
          throw new Error("measurementData: the world default must be metric");
        world = system;
        continue;
      }
      if (!COUNTRY.test(territory))
        throw new Error(
          "measurementData: a territory must be a two-letter country code",
        );
      if (countries.has(territory))
        throw new Error("measurementData: a country in two systems");
      countries.set(territory, { cldr: type, system });
    }
  }
  if (world === undefined) throw new Error("measurementData: no world default");
  /** @type {Record<string, { cldr: string, system: string }>} */
  const sorted = {};
  for (const code of [...countries.keys()].sort()) {
    const row = countries.get(code);
    if (row !== undefined) sorted[code] = row;
  }
  const json = { source, default: world, countries: sorted };
  return `${JSON.stringify(json, null, 2)}\n`;
}
