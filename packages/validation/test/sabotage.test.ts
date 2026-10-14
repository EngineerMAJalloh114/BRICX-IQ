// Sabotage (P3 rule 1, permanent): every check in checks.ts passes on the
// real code and fails on its deliberately broken variant in mutants.ts. If a
// check stops catching its mutant, this file fails.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { resolveLinks } from "../scripts/data-lib.mjs";
import { CountryCodeSchema } from "../src/country.ts";
import { EmailSchema } from "../src/email.ts";
import { parseAtBoundary } from "../src/error-envelope.ts";
import { FORMATS } from "../src/formats.ts";
import { GeoPointSchema } from "../src/geo.ts";
import { LanguageTagSchema } from "../src/locale.ts";
import { PageLimitSchema } from "../src/pagination.ts";
import { PhoneE164Schema } from "../src/phone.ts";
import { TimeZoneSchema } from "../src/time-zone.ts";
import {
  checkCountry,
  checkEmail,
  checkEnvelope,
  checkGeo,
  checkLinkResolution,
  checkLocaleNoText,
  checkPageLimit,
  checkPhone,
  checkTimeZone,
  checkWorkDone,
} from "./checks.ts";
import type { BuildEnvelope } from "./checks.ts";
import {
  countryUppercases,
  emailFormatFirst,
  emailNoLowercase,
  emailTrims,
  envelopeForwardsMessage,
  envelopeRawPath,
  geoUngated,
  localeLeaks,
  pageLimitCoerce,
  phoneStrips,
  phoneTwoDigits,
  resolveOneHop,
  zoneKeepsLink,
} from "./mutants.ts";

/** Fails (throws) when `check` passes. */
function expectCaught(check: () => void): void {
  expect(check).toThrow();
}

const recordSchema = z.strictObject({
  labels: z.record(z.string(), z.string()),
});

const realEnvelope: BuildEnvelope = (schema, input) => {
  const result = parseAtBoundary(schema, input);
  return result.success ? undefined : result.envelope;
};

describe("the checks pass on the real code", () => {
  it("all of them", () => {
    checkEmail(EmailSchema);
    checkPhone(PhoneE164Schema);
    checkCountry(CountryCodeSchema);
    checkTimeZone(TimeZoneSchema);
    checkLinkResolution(resolveLinks);
    checkEnvelope(realEnvelope, recordSchema);
    checkWorkDone(EmailSchema, FORMATS.email);
    checkLocaleNoText(LanguageTagSchema);
    checkPageLimit(PageLimitSchema);
    checkGeo(GeoPointSchema);
  });
});

describe("each mutant is caught", () => {
  it.each([
    [
      "email without lowercase",
      () => {
        checkEmail(emailNoLowercase);
      },
    ],
    [
      "email that trims",
      () => {
        checkEmail(emailTrims);
      },
    ],
    [
      "phone with a 2-digit minimum",
      () => {
        checkPhone(phoneTwoDigits);
      },
    ],
    [
      "phone that strips punctuation",
      () => {
        checkPhone(phoneStrips);
      },
    ],
    [
      "country that uppercases",
      () => {
        checkCountry(countryUppercases);
      },
    ],
    [
      "time zone that keeps the link name",
      () => {
        checkTimeZone(zoneKeepsLink);
      },
    ],
    [
      "link resolution with one hop",
      () => {
        checkLinkResolution(resolveOneHop);
      },
    ],
    [
      "envelope with raw paths",
      () => {
        checkEnvelope(envelopeRawPath, recordSchema);
      },
    ],
    [
      "envelope forwarding message text",
      () => {
        checkEnvelope(envelopeForwardsMessage, recordSchema);
      },
    ],
    [
      "format check before the length gate",
      () => {
        checkWorkDone(emailFormatFirst, FORMATS.email);
      },
    ],
    [
      "i18n error text in the issue",
      () => {
        checkLocaleNoText(localeLeaks);
      },
    ],
    [
      "page limit through z.coerce",
      () => {
        checkPageLimit(pageLimitCoerce);
      },
    ],
    [
      "GeoPoint without the key gate or -0 rule",
      () => {
        checkGeo(geoUngated);
      },
    ],
  ])("%s", (_name, check) => {
    expectCaught(check);
  });
});
