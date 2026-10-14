// Deliberately broken variants for the sabotage tests (P3 rule 1). Each is
// the real behaviour with one defect; sabotage.test.ts runs the checks in
// checks.ts against every one and requires them to fail.
import { readFileSync } from "node:fs";
import path from "node:path";
import { normalizeLocale } from "@bricx/i18n/locale";
import { z } from "zod";
import { timeZonesJson } from "../scripts/data-lib.mjs";
import { boundedString, issueMessage } from "../src/bounded.ts";
import { issueKey } from "../src/codes.ts";
import { CountryCodeSchema } from "../src/country.ts";
import { EmailSchema } from "../src/email.ts";
import { FORMATS } from "../src/formats.ts";
import { PhoneE164Schema } from "../src/phone.ts";
import type { BuildEnvelope, BuildTimeZones, ResolveLinks } from "./checks.ts";

/** Email without the lowercase step. */
export const emailNoLowercase = boundedString(
  FORMATS.email,
  issueMessage("invalid_email"),
);

/** Email that trims surrounding whitespace before checking. */
export const emailTrims = z
  .string()
  .transform((s) => s.trim())
  .pipe(EmailSchema);

/** Phone with the old 2-digit minimum. */
export const phoneTwoDigits = boundedString(
  { max: 16, check: (v) => /^\+[1-9][0-9]{1,14}$/.test(v) },
  issueMessage("invalid_phone"),
);

/** Phone that strips spaces and punctuation (normalising for the caller). */
export const phoneStrips = z
  .string()
  .transform((s) => s.replace(/[\s().-]/g, ""))
  .pipe(PhoneE164Schema);

/** Country that uppercases its input. */
export const countryUppercases = z
  .string()
  .transform((s) => s.toUpperCase())
  .pipe(CountryCodeSchema);

/** Time zone that accepts a known name but keeps the link name. */
export const zoneKeepsLink = boundedString(
  FORMATS.timeZone,
  issueMessage("invalid_time_zone"),
);

/** The old rule (architect review): zone.tab ignored, every link resolved. */
export const timeZonesOldRule: BuildTimeZones = (snapshot, source) =>
  timeZonesJson(snapshot, source, "");

/** TimeZoneSchema built from the old rule: Africa/Freetown -> Africa/Abidjan. */
const OLD_RULE_MAP = new Map(
  Object.entries(
    (
      JSON.parse(
        timeZonesOldRule(
          readFileSync(
            path.join(import.meta.dirname, "../data/source/tzdb-2026e.tsv"),
            "utf8",
          ),
          {} as never,
          "",
        ),
      ) as { links: Record<string, string> }
    ).links,
  ),
);
export const zoneOldRule = boundedString(
  FORMATS.timeZone,
  issueMessage("invalid_time_zone"),
).overwrite((name) => OLD_RULE_MAP.get(name) ?? name);

/** Link resolution that follows one hop only. */
export const resolveOneHop: ResolveLinks = (zones, links) => {
  const map = new Map<string, string>();
  const zoneSet = new Set(zones);
  for (const [target, name] of links) map.set(name, target);
  for (const target of map.values()) {
    if (!zoneSet.has(target) && !map.has(target)) throw new Error("dangling");
  }
  return map;
};

/** Format check first, length gate second: work grows with the input. */
export const emailFormatFirst = z.string().check((ctx) => {
  if (!FORMATS.email.check(ctx.value) || ctx.value.length > FORMATS.email.max) {
    ctx.issues.push({
      code: "custom",
      message: "validation:invalid_email",
      input: undefined,
    });
  }
});

const issuesOf = (schema: z.ZodType, input: unknown) => {
  const result = schema.safeParse(input);
  return result.success ? undefined : result.error.issues;
};

/** Envelope that copies zod's raw path (record keys included). */
export const envelopeRawPath: BuildEnvelope = (schema, input) => {
  const issues = issuesOf(schema, input);
  if (issues === undefined) return undefined;
  return {
    issues: issues.map((i) => ({
      path: i.path.map((s) => (typeof s === "symbol" ? "*" : s)),
      code: "invalid_value",
      key: issueKey("invalid_value"),
    })),
  };
};

/** Envelope that forwards zod's message text as the code. */
export const envelopeForwardsMessage: BuildEnvelope = (schema, input) => {
  const issues = issuesOf(schema, input);
  if (issues === undefined) return undefined;
  return {
    issues: issues.map((i) => ({
      path: i.path.length === 2 ? [String(i.path[0]), "*"] : [],
      code: i.message,
    })),
  };
};

/** Language tag schema that puts the i18n error message in the issue. */
export const localeLeaks = z.string().check((ctx) => {
  try {
    normalizeLocale(ctx.value);
  } catch (error) {
    ctx.issues.push({
      code: "custom",
      message: error instanceof Error ? error.message : "x",
      input: undefined,
    });
  }
});

/** Page limit through z.coerce. */
export const pageLimitCoerce = z.coerce
  .number()
  .int()
  .min(1)
  .max(100)
  .default(25);

/** GeoPoint with no key-count gate and no -0 normalisation. */
export const geoUngated = z.strictObject({
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
});
