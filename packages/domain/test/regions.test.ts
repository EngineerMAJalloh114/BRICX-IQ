// Region unit defaults (ruling 1): generated from CLDR supplemental
// measurementData, pinned by SHA-256, byte-identical on a fresh run of the
// committed generator. CLDR "metric" -> metric, "US" -> us_customary, "UK"
// -> metric (ADR 0049). Lookups are data reads, never code branches.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { QuantityError } from "../src/errors.ts";
import {
  REGION_UNIT_DEFAULTS,
  UNIT_SLOTS,
  UNIT_SYSTEMS,
  defaultUnit,
  isUnitSystemName,
  parseUnitSystemName,
  unitSystemFor,
} from "../src/regions.ts";
import { dimensionOf } from "../src/units.ts";
import {
  extractMeasurementData,
  regionUnitsJson,
} from "../scripts/region-lib.mjs";
import type { MeasurementSource } from "../scripts/region-lib.mjs";

const pkgDir = path.join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(pkgDir, rel), "utf8");
const sha256 = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex");

const source = (
  JSON.parse(read("data/source/source.json")) as {
    measurementData: MeasurementSource;
  }
).measurementData;

const countries = (
  JSON.parse(read("../validation/data/countries.json")) as { codes: string[] }
).codes;

describe("data/region-units.json", () => {
  it("the snapshot and the licence match their recorded SHA-256 (CLDR 48.2)", () => {
    expect(sha256(read(`data/source/${source.snapshot}`))).toBe(
      source.snapshotSha256,
    );
    expect(sha256(read("data/source/UNICODE-LICENSE.txt"))).toBe(
      source.licenceSha256,
    );
    expect(source.commit).toBe("11299982335beb974c1c63c45265184e759c0f41");
  });

  it("is byte-identical to a fresh run of the generator (ruling 1)", () => {
    const fresh = execFileSync(
      process.execPath,
      ["scripts/gen-region-units.mjs", "--stdout"],
      { cwd: pkgDir },
    );
    expect(
      Buffer.compare(
        fresh,
        readFileSync(path.join(pkgDir, "data/region-units.json")),
      ),
    ).toBe(0);
  });

  it("the generator's --check passes on the committed file", () => {
    const out = execFileSync(
      process.execPath,
      ["scripts/gen-region-units.mjs", "--check"],
      { cwd: pkgDir, encoding: "utf8" },
    );
    expect(out).toContain("current");
  });

  it("the transform in-process gives the same bytes", () => {
    expect(
      regionUnitsJson(read(`data/source/${source.snapshot}`), source),
    ).toBe(read("data/region-units.json"));
  });

  it("every country code in the table is in validation's countries.json", () => {
    const codes = Object.keys(REGION_UNIT_DEFAULTS.countries);
    expect(codes.length).toBeGreaterThan(0);
    for (const c of codes) expect(countries, c).toContain(c);
  });

  it("the us_customary set is exactly LR and US (CLDR 48.2)", () => {
    const us = Object.entries(REGION_UNIT_DEFAULTS.countries)
      .filter(([, v]) => v.system === "us_customary")
      .map(([c]) => c)
      .sort();
    expect(us).toEqual(["LR", "US"]);
  });

  it("CLDR's UK system maps to metric (GB, MM)", () => {
    const uk = Object.entries(REGION_UNIT_DEFAULTS.countries)
      .filter(([, v]) => v.cldr === "UK")
      .map(([c, v]) => [c, v.system]);
    expect(uk).toEqual([
      ["GB", "metric"],
      ["MM", "metric"],
    ]);
    expect(REGION_UNIT_DEFAULTS.default).toBe("metric");
  });
});

describe("the transform", () => {
  const wrap = (body: string) =>
    `    <measurementData>\n${body}    </measurementData>\n`;
  const ms = (type: string, territories: string, category?: string) =>
    `          <measurementSystem type="${type}"${
      category === undefined ? "" : ` category="${category}"`
    }  territories="${territories}"/>\n`;

  it("ignores category rows (temperature) and paperSize", () => {
    const json = JSON.parse(
      regionUnitsJson(
        wrap(
          ms("metric", "001") +
            ms("US", "US") +
            ms("US", "BS", "temperature") +
            '          <paperSize type="A4"  territories="001"/>\n',
        ),
        source,
      ),
    ) as { countries: Record<string, unknown> };
    expect(Object.keys(json.countries)).toEqual(["US"]);
  });

  it.each([
    ["an unknown system", ms("metric", "001") + ms("SI2", "FR")],
    ["no world default", ms("US", "US")],
    ["a non-metric world default", ms("US", "001")],
    [
      "a country in two systems",
      ms("metric", "001") + ms("US", "US") + ms("UK", "US"),
    ],
    ["a lowercase territory", ms("metric", "001") + ms("US", "us")],
    [
      "a region code that is not a country",
      ms("metric", "001") + ms("US", "419"),
    ],
    ["an unexpected element", `${ms("metric", "001")}          <foo/>\n`],
  ])("rejects %s", (_name, body) => {
    expect(() => regionUnitsJson(wrap(body), source)).toThrow();
  });

  it("rejects a snapshot without the measurementData element", () => {
    expect(() => regionUnitsJson(ms("metric", "001"), source)).toThrow();
  });

  it("extractMeasurementData takes the element verbatim from the full file", () => {
    const full = `<supplementalData>\n  <x/>\n${wrap(ms("metric", "001"))}  <y/>\n</supplementalData>\n`;
    expect(extractMeasurementData(full)).toBe(wrap(ms("metric", "001")));
    expect(() => extractMeasurementData("<supplementalData/>")).toThrow();
  });
});

describe("unitSystemFor and defaultUnit", () => {
  it.each(["SL", "GH", "NG", "KE", "ZA", "GB", "FR", "MM", "PR", "CA"])(
    "%s resolves to metric",
    (country) => {
      expect(unitSystemFor(country)).toEqual({ ok: true, value: "metric" });
    },
  );

  it.each(["US", "LR"])("%s resolves to us_customary", (country) => {
    expect(unitSystemFor(country)).toEqual({ ok: true, value: "us_customary" });
  });

  it("a well-formed country with no CLDR row gets the default", () => {
    expect(unitSystemFor("ZZ")).toEqual({ ok: true, value: "metric" });
  });

  it.each(["us", "U", "USA", "", "U1", "__proto__", "constructor", "toString"])(
    "%j is invalid_country",
    (country) => {
      const result = unitSystemFor(country);
      expect(!result.ok && result.error.code).toBe("invalid_country");
    },
  );

  it("a non-string country is invalid_country", () => {
    const lookup = unitSystemFor as (
      c: unknown,
    ) => ReturnType<typeof unitSystemFor>;
    for (const c of [1, null, undefined, {}, ["US"]]) {
      const result = lookup(c);
      expect(!result.ok && result.error.code).toBe("invalid_country");
    }
  });

  it("the slots and each system's default unit per slot", () => {
    expect(UNIT_SLOTS).toEqual(["length", "area", "volume", "mass", "liquid"]);
    expect(UNIT_SYSTEMS).toEqual({
      metric: {
        length: "m",
        area: "m2",
        volume: "m3",
        mass: "kg",
        liquid: "l",
      },
      us_customary: {
        length: "ft",
        area: "ft2",
        volume: "yd3",
        mass: "lb",
        liquid: "us_gal",
      },
    });
  });

  it("each slot names a unit of the right dimension in every system", () => {
    const expected = {
      length: "length",
      area: "area",
      volume: "volume",
      mass: "mass",
      liquid: "volume",
    } as const;
    for (const system of Object.values(UNIT_SYSTEMS)) {
      for (const slot of UNIT_SLOTS) {
        expect(dimensionOf(system[slot])).toBe(expected[slot]);
      }
    }
  });

  it("defaultUnit reads the system's slot", () => {
    expect(defaultUnit("SL", "length")).toEqual({ ok: true, value: "m" });
    expect(defaultUnit("US", "volume")).toEqual({ ok: true, value: "yd3" });
    expect(defaultUnit("LR", "liquid")).toEqual({ ok: true, value: "us_gal" });
    expect(defaultUnit("GB", "mass")).toEqual({ ok: true, value: "kg" });
    const bad = defaultUnit("us", "length");
    expect(!bad.ok && bad.error.code).toBe("invalid_country");
    const slot = defaultUnit as (
      c: unknown,
      s: unknown,
    ) => ReturnType<typeof defaultUnit>;
    for (const s of ["width", "constructor", "__proto__", 1]) {
      const result = slot("US", s);
      expect(!result.ok && result.error.code).toBe("invalid_slot");
    }
  });

  it("parseUnitSystemName accepts the two systems and rejects anything else", () => {
    expect(parseUnitSystemName("metric")).toBe("metric");
    expect(parseUnitSystemName("us_customary")).toBe("us_customary");
    expect(isUnitSystemName("imperial")).toBe(false);
    expect(() => parseUnitSystemName("imperial")).toThrow(QuantityError);
    expect(() => parseUnitSystemName("constructor")).toThrow(QuantityError);
  });

  it("the data is frozen", () => {
    expect(Object.isFrozen(REGION_UNIT_DEFAULTS)).toBe(true);
    expect(Object.isFrozen(REGION_UNIT_DEFAULTS.countries)).toBe(true);
    expect(Object.isFrozen(UNIT_SYSTEMS)).toBe(true);
    expect(Object.isFrozen(UNIT_SYSTEMS.metric)).toBe(true);
  });
});

describe("no code branches on countries (design constraint 3)", () => {
  it("src/regions.ts names no country code", () => {
    const code = read("src/regions.ts").replace(/\/\/.*$/gm, "");
    const literals = [...code.matchAll(/["'`]([A-Z]{2})["'`]/g)].map(
      (m) => m[1],
    );
    expect(literals).toEqual([]);
  });
});
