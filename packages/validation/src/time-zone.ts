// TimeZoneSchema (P3-04 D3, ruling 3, architect review of PR #38): an IANA
// tzdb 2026e Zone or Link name. A name listed in tzdb's zone.tab is
// canonical for itself (Africa/Freetown, Africa/Accra and Africa/Dakar are
// stored as given, never rewritten to Africa/Abidjan); any other name
// resolves through its link chain to its target at generation time
// (data/time-zones.json): UTC becomes Etc/UTC and Asia/Calcutta becomes
// Asia/Kolkata (ADR 0047). Offsets ("+01:00"), abbreviations ("PST") and
// lowercase names are rejected; nothing is trimmed.
import type { z } from "zod";
import timeZones from "../data/time-zones.json" with { type: "json" };
import { boundedString, issueMessage } from "./bounded.ts";
import { FORMATS, ZONE_OF } from "./formats.ts";

/** The stored names: the zone.tab names plus resolved targets, sorted. */
export const TIME_ZONES: readonly string[] = Object.freeze([
  ...timeZones.zones,
]);

/** The stored name for a zone or link name; undefined if unknown. */
export const canonicalTimeZone = (name: string): string | undefined =>
  ZONE_OF.get(name);

export const TimeZoneSchema = boundedString(
  FORMATS.timeZone,
  issueMessage("invalid_time_zone"),
)
  .overwrite((name) => ZONE_OF.get(name) ?? name)
  .brand<"TimeZone">();

export type TimeZone = z.output<typeof TimeZoneSchema>;
