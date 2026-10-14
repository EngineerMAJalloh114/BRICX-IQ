// Pure transforms for the generated data of @bricx/validation (P3-04, ADR
// 0047): ISO 3166-1 alpha-2 codes from the datasets/country-list snapshot,
// and IANA tzdb zone and link names from the tzdb 2026e snapshot. No I/O
// here: gen-countries.mjs and gen-time-zones.mjs read and write files, and
// test/data.test.ts runs these functions on the committed snapshots.

/**
 * @typedef {{ dataset: string, url: string, commit: string, commitDate: string,
 *   licence: string, retrieved: string, file: string, sha256: string }} CountrySource
 * @typedef {{ release: string, repository: string, commit: string,
 *   releaseDate: string, licence: string, retrieved: string, snapshot: string,
 *   snapshotSha256: string, files: Record<string, string> }} TzSource
 */

const CODE = /^[A-Z]{2}$/;

/**
 * Splits one CSV row of datasets/country-list ("Name,Code", the name quoted
 * when it holds a comma) into [name, code]. Throws on any other shape.
 * @param {string} line
 * @returns {[string, string]}
 */
function countryRow(line) {
  if (line.startsWith('"')) {
    const close = line.indexOf('",', 1);
    if (close === -1) throw new Error("countries: unterminated quoted name");
    const rest = line.slice(close + 2);
    if (rest.includes(",")) throw new Error("countries: extra field");
    return [line.slice(1, close), rest];
  }
  const fields = line.split(",");
  if (fields.length !== 2)
    throw new Error("countries: a row must have two fields");
  return [fields[0] ?? "", fields[1] ?? ""];
}

/**
 * countries.json from the snapshot CSV: the codes only (names are display
 * text and come from i18n, never from this file), sorted.
 * @param {string} csv
 * @param {CountrySource} source
 * @returns {string}
 */
export function countriesJson(csv, source) {
  const lines = csv
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((l) => l !== "");
  if (lines[0] !== "Name,Code") throw new Error("countries: unexpected header");
  /** @type {Set<string>} */
  const codes = new Set();
  for (const line of lines.slice(1)) {
    const [name, code] = countryRow(line);
    if (name === "") throw new Error("countries: empty name");
    if (!CODE.test(code))
      throw new Error("countries: a code must be two uppercase letters");
    if (codes.has(code)) throw new Error("countries: duplicate code");
    codes.add(code);
  }
  const json = { source, codes: [...codes].sort() };
  return `${JSON.stringify(json, null, 2)}\n`;
}

/**
 * The Zone and Link names of tzdb source files, one tab-separated row per
 * name: `file\tZone\tname` or `file\tLink\ttarget\tname`. Comments, Rule
 * lines and Zone continuation lines are dropped.
 * @param {readonly { name: string, text: string }[]} files
 * @returns {string}
 */
export function extractTzLines(files) {
  /** @type {string[]} */
  const out = [];
  for (const { name, text } of files) {
    for (const raw of text.split("\n")) {
      const line = raw.replace(/#.*$/, "");
      if (!/^(?:Zone|Link)\s/.test(line)) continue;
      const fields = line.trim().split(/\s+/);
      if (fields[0] === "Zone") {
        if (fields.length < 2) throw new Error("tzdb: Zone without a name");
        out.push(`${name}\tZone\t${fields[1] ?? ""}`);
      } else {
        if (fields.length !== 3)
          throw new Error("tzdb: Link needs a target and a name");
        out.push(`${name}\tLink\t${fields[1] ?? ""}\t${fields[2] ?? ""}`);
      }
    }
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}

/**
 * Resolves every link to its Zone, following chains of links of any length
 * (ruling 3a). Throws on a duplicate name, a link named like a zone, a link
 * to an unknown name, or a cycle.
 * @param {readonly string[]} zones
 * @param {readonly (readonly [string, string])[]} links [target, name] pairs
 * @returns {Map<string, string>} link name -> zone
 */
export function resolveLinks(zones, links) {
  const zoneSet = new Set(zones);
  if (zoneSet.size !== zones.length) throw new Error("tzdb: duplicate Zone");
  /** @type {Map<string, string>} */
  const direct = new Map();
  for (const [target, name] of links) {
    if (zoneSet.has(name)) throw new Error("tzdb: a Link has a Zone's name");
    if (direct.has(name)) throw new Error("tzdb: duplicate Link");
    direct.set(name, target);
  }
  /** @type {Map<string, string>} */
  const resolved = new Map();
  for (const name of direct.keys()) {
    let current = name;
    for (let hops = 0; ; hops += 1) {
      if (hops > direct.size) throw new Error("tzdb: Link cycle");
      const next = direct.get(current);
      if (next === undefined) {
        if (!zoneSet.has(current))
          throw new Error("tzdb: Link to an unknown name");
        break;
      }
      current = next;
    }
    resolved.set(name, current);
  }
  return resolved;
}

/**
 * time-zones.json from the snapshot rows: sorted canonical zones and every
 * link with its resolved zone.
 * @param {string} snapshot
 * @param {TzSource} source
 * @returns {string}
 */
export function timeZonesJson(snapshot, source) {
  /** @type {string[]} */
  const zones = [];
  /** @type {[string, string][]} */
  const links = [];
  for (const line of snapshot.split("\n")) {
    if (line === "") continue;
    const fields = line.split("\t");
    if (fields[1] === "Zone" && fields.length === 3) {
      zones.push(fields[2] ?? "");
    } else if (fields[1] === "Link" && fields.length === 4) {
      links.push([fields[2] ?? "", fields[3] ?? ""]);
    } else {
      throw new Error("tzdb: malformed snapshot row");
    }
  }
  const resolved = resolveLinks(zones, links);
  /** @type {Record<string, string>} */
  const linkObject = {};
  for (const name of [...resolved.keys()].sort()) {
    linkObject[name] = resolved.get(name) ?? "";
  }
  const json = { source, zones: [...zones].sort(), links: linkObject };
  return `${JSON.stringify(json, null, 2)}\n`;
}
