// TimeZoneSchema (P3-04 D3, ruling 3, architect review change): IANA tzdb
// 2026e names. A name listed in zone.tab is canonical for itself (the
// product is Africa-first: Africa/Freetown, Africa/Accra, Africa/Dakar...
// are stored as given, never rewritten to Africa/Abidjan). Any other Zone
// or Link name resolves through its link chain to its target: UTC becomes
// Etc/UTC and Asia/Calcutta becomes Asia/Kolkata (ADR 0047).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TIME_ZONES,
  TimeZoneSchema,
  canonicalTimeZone,
} from "../src/time-zone.ts";
import { expectRejectedWithoutEcho, messageOf, parsed } from "./helpers.ts";

const INVALID = "validation:invalid_time_zone";

// The zone.tab names, read here from the committed source file, not from
// the generated data.
const ZONE_TAB_NAMES = readFileSync(
  path.join(import.meta.dirname, "../data/source/zone.tab"),
  "utf8",
)
  .split("\n")
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => line.split("\t")[2] ?? "");

describe("TimeZoneSchema", () => {
  it.each([
    "Africa/Abidjan",
    "Africa/Lagos",
    "Europe/London",
    "America/New_York",
    "Asia/Riyadh",
    "Etc/UTC",
    "Etc/GMT+5",
    "America/Argentina/Buenos_Aires",
  ])("accepts canonical %s as itself", (zone) => {
    expect(parsed(TimeZoneSchema, zone)).toBe(zone);
  });

  // Architect review: zone.tab names are stored exactly as given. Each of
  // these is a Link to Africa/Abidjan (or Africa/Lagos) in tzdb 2026e.
  it.each([
    "Africa/Freetown",
    "Africa/Accra",
    "Africa/Dakar",
    "Africa/Conakry",
    "Africa/Banjul",
    "Africa/Bamako",
    "Africa/Lagos",
  ])("keeps the zone.tab name %s as given", (zone) => {
    expect(parsed(TimeZoneSchema, zone)).toBe(zone);
    expect(canonicalTimeZone(zone)).toBe(zone);
    expect(TIME_ZONES).toContain(zone);
  });

  it("accepts every zone.tab name as itself (418 names)", () => {
    expect(ZONE_TAB_NAMES).toHaveLength(418);
    for (const name of ZONE_TAB_NAMES) {
      expect(parsed(TimeZoneSchema, name)).toBe(name);
    }
  });

  it.each([
    ["UTC", "Etc/UTC"],
    ["Asia/Calcutta", "Asia/Kolkata"],
    ["Europe/Kiev", "Europe/Kyiv"],
    ["US/Eastern", "America/New_York"],
    ["GMT", "Etc/GMT"],
    ["Australia/ACT", "Australia/Sydney"],
    ["Africa/Timbuktu", "Africa/Abidjan"],
  ])("canonicalises link %s to %s", (link, zone) => {
    expect(parsed(TimeZoneSchema, link)).toBe(zone);
    expect(canonicalTimeZone(link)).toBe(zone);
  });

  it("the output always parses to itself", () => {
    for (const zone of TIME_ZONES) {
      expect(parsed(TimeZoneSchema, zone)).toBe(zone);
    }
  });

  // 450 = the 418 zone.tab names plus the 32 Zones that are not in
  // zone.tab (Etc/UTC, Etc/GMT+5...); no other link resolves elsewhere.
  it("lists 450 stored names, sorted and frozen", () => {
    expect(TIME_ZONES).toHaveLength(450);
    expect([...TIME_ZONES]).toEqual([...TIME_ZONES].sort());
    expect(Object.isFrozen(TIME_ZONES)).toBe(true);
  });

  it.each([
    ["lowercase", "europe/london"],
    ["unknown", "Mars/Olympus_Mons"],
    ["offset string", "+01:00"],
    ["abbreviation", "PST"],
    ["Factory (not a real zone)", "Factory"],
    ["leading space", " Europe/London"],
    ["trailing space", "Europe/London "],
    ["empty", ""],
    ["prototype key", "__proto__"],
    ["prototype key", "constructor"],
  ])("rejects %s", (_label, input) => {
    expect(expectRejectedWithoutEcho(TimeZoneSchema, input)).toEqual([INVALID]);
  });

  it("canonicalTimeZone returns undefined for an unknown name", () => {
    expect(canonicalTimeZone("Mars/Olympus_Mons")).toBeUndefined();
    expect(canonicalTimeZone("toString")).toBeUndefined();
  });

  it("rejects a non-string", () => {
    expect(messageOf(TimeZoneSchema, 0)).toBe(INVALID);
  });
});
