// PhoneE164Schema (P3-04 D1 = A, ruling 1): "+", a first digit 1-9, then 6
// to 14 more digits (7 to 15 digits in total). No whitespace or punctuation,
// nothing trimmed: callers normalise. A FORMAT check only: no per-country
// length, no allocation check. libphonenumber-js is deferred to P7 input
// formatting. The false-accept classes below are accepted on purpose and
// documented in ADR 0047.
import { describe, expect, it } from "vitest";
import { PHONE_MAX, PhoneE164Schema } from "../src/phone.ts";
import { expectRejectedWithoutEcho, messageOf, parsed } from "./helpers.ts";

const INVALID = "validation:invalid_phone";

describe("PhoneE164Schema: the 7-digit minimum (ruling 1)", () => {
  it('"+12" is rejected (2 digits)', () => {
    expect(expectRejectedWithoutEcho(PhoneE164Schema, "+12")).toEqual([
      INVALID,
    ]);
  });

  it('"+1234567" is accepted (7 digits)', () => {
    expect(parsed(PhoneE164Schema, "+1234567")).toBe("+1234567");
  });

  it('"+123456" is rejected (6 digits)', () => {
    expect(expectRejectedWithoutEcho(PhoneE164Schema, "+123456")).toEqual([
      INVALID,
    ]);
  });

  it("15 digits is accepted, 16 rejected", () => {
    expect(parsed(PhoneE164Schema, "+123456789012345")).toBe(
      "+123456789012345",
    );
    expect(
      expectRejectedWithoutEcho(PhoneE164Schema, "+1234567890123456"),
    ).toEqual([INVALID]);
  });
});

describe("PhoneE164Schema accepts real E.164 numbers", () => {
  it.each([
    ["Sierra Leone mobile", "+23276123456"],
    ["UK London", "+442071234567"],
    ["US", "+12025550123"],
    ["France", "+33123456789"],
    ["Saudi Arabia", "+966501234567"],
  ])("%s", (_label, input) => {
    expect(parsed(PhoneE164Schema, input)).toBe(input);
  });
});

// False accepts: a format check cannot know country plans. Each class is
// accepted here, by design, and listed in ADR 0047.
describe("PhoneE164Schema false accepts (format only, by design)", () => {
  it.each([
    ["unassigned country code +999", "+9991234567"],
    ["too short for its country (US needs 11 digits)", "+1202555"],
    ["too long for its country (Sierra Leone needs 11)", "+232761234567890"],
    ["national trunk prefix kept (+44 0 ...)", "+4402071234567"],
    ["unallocated national range", "+10001234567"],
    ["fictional 555 range", "+12025550199"],
    ["shared-cost or premium number", "+449001234567"],
  ])("%s", (_label, input) => {
    expect(parsed(PhoneE164Schema, input)).toBe(input);
  });
});

// False rejects: inputs a person might type, rejected because the caller
// must normalise to E.164 before this schema.
describe("PhoneE164Schema rejects unnormalised input (callers normalise)", () => {
  it.each([
    ["spaces", "+232 76 123456"],
    ["dashes", "+1-202-555-0123"],
    ["parentheses", "+1 (202) 5550123"],
    ["dots", "+33.1.23.45.67.89"],
    ["00 international prefix", "0023276123456"],
    ["national format, no +", "076123456"],
    ["leading whitespace", " +23276123456"],
    ["trailing whitespace", "+23276123456 "],
    ["trailing newline", "+23276123456\n"],
    ["extension", "+12025550123x45"],
    ["Arabic-Indic digits", "+٢٣٢٧٦١٢٣٤٥٦"],
    ["full-width plus", "＋23276123456"],
    ["first digit 0", "+0123456789"],
    ["plus only", "+"],
    ["empty", ""],
    ["two plus signs", "++23276123456"],
  ])("%s", (_label, input) => {
    expect(expectRejectedWithoutEcho(PhoneE164Schema, input)).toEqual([
      INVALID,
    ]);
  });

  it("a number type", () => {
    expect(messageOf(PhoneE164Schema, 23276123456)).toBe(INVALID);
  });

  it("the cap is 16 characters", () => {
    expect(PHONE_MAX).toBe(16);
  });
});
