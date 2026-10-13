// Error messages never include input values (P3 rule 9): every failure mode
// puts a sentinel into the input and checks no rendering of the error
// carries it.
import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { parseOrgId } from "../src/branded.js";
import { IdError, createUuidV7Generator, parseUuidV7 } from "../src/uuid-v7.js";
import { expectNoSentinel, seededRandom } from "./helpers.js";

const parseCases: readonly (readonly [string, unknown, readonly string[]])[] = [
  ["bad_format", "SENTINEL-bad-format-0000", ["SENTINEL"]],
  [
    "uppercase",
    "DEADBEEF-CAFE-7ABC-8DEF-0123456789AB",
    ["DEADBEEF", "deadbeef", "CAFE-7ABC"],
  ],
  [
    "not_v7",
    "deadbeef-cafe-4abc-8def-0123456789ab",
    ["deadbeef", "cafe-4abc", "0123456789ab"],
  ],
  [
    "bad_variant",
    "deadbeef-cafe-7abc-cdef-0123456789ab",
    ["deadbeef", "cdef", "0123456789ab"],
  ],
  ["not_a_string", { secret: "SENTINEL-object" }, ["SENTINEL"]],
  ["not_a_string", 987654321, ["987654321"]],
];

describe("parse errors carry a code, never the input", () => {
  it.each(parseCases)("%s", (code, input, sentinels) => {
    for (const parse of [parseUuidV7, parseOrgId]) {
      let caught: unknown;
      try {
        parse(input);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(IdError);
      expect(caught).toMatchObject({ code, name: "IdError" });
      expectNoSentinel(caught, sentinels);
    }
  });
});

describe("clock errors carry a code, never the clock value", () => {
  it.each([98765.4321, -98765, 2 ** 48 + 98765])("%d", (value) => {
    const ids = createUuidV7Generator({
      clock: { now: () => value },
      fillRandom: seededRandom(1),
    });
    let caught: unknown;
    try {
      ids.next();
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: "invalid_clock" });
    expectNoSentinel(caught, ["98765"]);
  });
});

describe("error shape", () => {
  it("own properties are only the fixed message, the code and the stack", () => {
    let caught: unknown;
    try {
      parseUuidV7("x");
    } catch (error) {
      caught = error;
    }
    expect(Object.getOwnPropertyNames(caught).sort()).toEqual([
      "code",
      "message",
      "stack",
    ]);
    expect(String(caught)).toBe(
      "IdError: bad_format: not a canonical 8-4-4-4-12 UUID string",
    );
    expect(inspect(caught)).toContain("bad_format");
  });
});
