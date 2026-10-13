// Parsing is strict: lowercase RFC 9562 version 7, variant 10, canonical
// 8-4-4-4-12 form only (P3-01 ruling; ADR 0041). API boundaries lowercase
// untrusted input before calling parse.
import { describe, expect, it } from "vitest";
import {
  IdError,
  createUuidV7Generator,
  isUuidV7,
  parseUuidV7,
  safeParseUuidV7,
} from "../src/uuid-v7.js";
import { frozenClock, seededRandom } from "./helpers.js";

const RFC_VECTOR = "017f22e2-79b0-7cc3-98c4-dc0c0c07398f"; // RFC 9562 A.6
const generated = createUuidV7Generator({
  clock: frozenClock(Date.UTC(2026, 9, 13)),
  fillRandom: seededRandom(5),
}).next();

const accepted = [
  RFC_VECTOR,
  generated,
  // Each allowed variant nibble.
  "017f22e2-79b0-7cc3-88c4-dc0c0c07398f",
  "017f22e2-79b0-7cc3-a8c4-dc0c0c07398f",
  "017f22e2-79b0-7cc3-b8c4-dc0c0c07398f",
  // Extremes of the timestamp field.
  "00000000-0000-7000-8000-000000000000",
  "ffffffff-ffff-7fff-bfff-ffffffffffff",
];

const rejected: readonly (readonly [string, unknown, string])[] = [
  ["uppercase (whole)", RFC_VECTOR.toUpperCase(), "uppercase"],
  [
    "uppercase (one digit)",
    "017f22e2-79b0-7cc3-98c4-dc0c0c07398F",
    "uppercase",
  ],
  ["version 4", "017f22e2-79b0-4cc3-98c4-dc0c0c07398f", "not_v7"],
  ["version 1", "017f22e2-79b0-1cc3-98c4-dc0c0c07398f", "not_v7"],
  ["version 6", "017f22e2-79b0-6cc3-98c4-dc0c0c07398f", "not_v7"],
  ["version 8", "017f22e2-79b0-8cc3-98c4-dc0c0c07398f", "not_v7"],
  ["nil", "00000000-0000-0000-0000-000000000000", "not_v7"],
  ["max", "ffffffff-ffff-ffff-ffff-ffffffffffff", "not_v7"],
  ["variant 0 (NCS)", "017f22e2-79b0-7cc3-18c4-dc0c0c07398f", "bad_variant"],
  ["variant 0 (7)", "017f22e2-79b0-7cc3-78c4-dc0c0c07398f", "bad_variant"],
  [
    "variant 110 (Microsoft)",
    "017f22e2-79b0-7cc3-c8c4-dc0c0c07398f",
    "bad_variant",
  ],
  [
    "variant 111 (future)",
    "017f22e2-79b0-7cc3-f8c4-dc0c0c07398f",
    "bad_variant",
  ],
  ["no hyphens", "017f22e279b07cc398c4dc0c0c07398f", "bad_format"],
  ["braces", `{${RFC_VECTOR}}`, "bad_format"],
  ["urn prefix", `urn:uuid:${RFC_VECTOR}`, "bad_format"],
  ["leading space", ` ${RFC_VECTOR}`, "bad_format"],
  ["trailing newline", `${RFC_VECTOR}\n`, "bad_format"],
  ["too short", RFC_VECTOR.slice(0, -1), "bad_format"],
  ["too long", `${RFC_VECTOR}0`, "bad_format"],
  ["non-hex digit", "017f22e2-79b0-7cc3-98c4-dc0c0c07398g", "bad_format"],
  ["hyphen moved", "017f22e-279b0-7cc3-98c4-dc0c0c07398f", "bad_format"],
  ["empty", "", "bad_format"],
  ["a number", 42, "not_a_string"],
  ["null", null, "not_a_string"],
  ["undefined", undefined, "not_a_string"],
  ["an object", { id: RFC_VECTOR }, "not_a_string"],
  ["a String object", new String(RFC_VECTOR), "not_a_string"],
];

describe("parseUuidV7", () => {
  it.each(accepted)("accepts %s", (input) => {
    expect(parseUuidV7(input)).toBe(input);
    expect(isUuidV7(input)).toBe(true);
    expect(safeParseUuidV7(input)).toEqual({ ok: true, value: input });
  });

  it.each(rejected)("rejects %s with code %s", (_name, input, code) => {
    expect(() => parseUuidV7(input)).toThrow(IdError);
    expect(() => parseUuidV7(input)).toThrow(expect.objectContaining({ code }));
    expect(isUuidV7(input)).toBe(false);
    expect(safeParseUuidV7(input)).toEqual({ ok: false, code });
  });
});
