// TimeZoneSchema (P3-04 D3, ruling 3): IANA tzdb 2026e names. Zone and
// Link names are accepted; the output is always the canonical Zone, links
// resolved transitively. UTC canonicalises to Etc/UTC, which changes the
// stored string (ADR 0047).
import { describe, expect, it } from "vitest";
import {
  TIME_ZONES,
  TimeZoneSchema,
  canonicalTimeZone,
} from "../src/time-zone.ts";
import { expectRejectedWithoutEcho, messageOf, parsed } from "./helpers.ts";

const INVALID = "validation:invalid_time_zone";

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

  it.each([
    ["UTC", "Etc/UTC"],
    ["Asia/Calcutta", "Asia/Kolkata"],
    ["Europe/Kiev", "Europe/Kyiv"],
    ["US/Eastern", "America/New_York"],
    ["GMT", "Etc/GMT"],
    ["Australia/ACT", "Australia/Sydney"],
    // Sierra Leone: tzdb merged Freetown into Abidjan (same rules since
    // 1970), so a Freetown user's zone is stored as Africa/Abidjan.
    ["Africa/Freetown", "Africa/Abidjan"],
  ])("canonicalises link %s to %s", (link, zone) => {
    expect(parsed(TimeZoneSchema, link)).toBe(zone);
    expect(canonicalTimeZone(link)).toBe(zone);
  });

  it("the output always parses to itself", () => {
    for (const zone of TIME_ZONES) {
      expect(parsed(TimeZoneSchema, zone)).toBe(zone);
    }
  });

  it("lists 344 canonical zones, sorted and frozen", () => {
    expect(TIME_ZONES).toHaveLength(344);
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
