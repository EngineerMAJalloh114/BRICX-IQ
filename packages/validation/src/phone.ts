// PhoneE164Schema (P3-04 D1 = A, ruling 1): "+", a first digit 1-9, then 6
// to 14 more digits (7 to 15 digits in all). No whitespace or punctuation
// is accepted and nothing is trimmed: callers normalise. This is a FORMAT
// check only: it knows no country's length or numbering plan, so an
// unassigned country code or a number too short for its country passes
// (ADR 0047 lists the false-accept classes). libphonenumber-js is deferred
// to P7 input formatting.
import type { z } from "zod";
import { boundedString, issueMessage } from "./bounded.ts";
import { FORMATS } from "./formats.ts";
import { LIMITS } from "./limits.ts";

export const PHONE_MAX = LIMITS.phone;

export const PhoneE164Schema = boundedString(
  FORMATS.phone,
  issueMessage("invalid_phone"),
).brand<"PhoneE164">();

export type PhoneE164 = z.output<typeof PhoneE164Schema>;
