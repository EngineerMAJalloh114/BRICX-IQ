// TimeZoneSchema (P3-04 D3, ruling 3): an IANA tzdb 2026e Zone or Link name,
// output as its canonical Zone with links resolved transitively at
// generation time (data/time-zones.json). UTC becomes Etc/UTC and
// Asia/Calcutta becomes Asia/Kolkata: the stored string is always the
// canonical zone (ADR 0047). Offsets ("+01:00"), abbreviations ("PST") and
// lowercase names are rejected; nothing is trimmed.
import type { z } from "zod";
import timeZones from "../data/time-zones.json";
import { boundedString, issueMessage } from "./bounded.ts";
import { FORMATS, ZONE_OF } from "./formats.ts";

/** The canonical zones of tzdb 2026e, sorted. */
export const TIME_ZONES: readonly string[] = Object.freeze([
  ...timeZones.zones,
]);

/** The canonical zone for a zone or link name; undefined if unknown. */
export const canonicalTimeZone = (name: string): string | undefined =>
  ZONE_OF.get(name);

export const TimeZoneSchema = boundedString(
  FORMATS.timeZone,
  issueMessage("invalid_time_zone"),
)
  .overwrite((name) => ZONE_OF.get(name) ?? name)
  .brand<"TimeZone">();

export type TimeZone = z.output<typeof TimeZoneSchema>;
