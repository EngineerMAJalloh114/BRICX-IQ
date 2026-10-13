// Sabotage (P3 rule 1, permanent): the property checks below pass on the
// real code and fail on each deliberately broken variant in mutants.ts. If
// a check stops catching its mutant, this file fails.
import { describe, expect, it } from "vitest";
import type { FillRandom, IdClock, UuidV7Generator } from "../src/uuid-v7.js";
import { createUuidV7Generator, parseUuidV7 } from "../src/uuid-v7.js";
import {
  expectNoSentinel,
  expectStrictlyIncreasing,
  expectVersionAndVariant,
  frozenClock,
  generate,
  seededRandom,
  sequenceClock,
  timestampField,
} from "./helpers.js";
import type { Make } from "./mutants.js";
import {
  counterNeverIncrements,
  followsBackwardsClock,
  parseAcceptsAnyVersion,
  parseAcceptsUppercase,
  parseEchoesInput,
  truncatedTimestamp,
  wrongVariant,
  wrongVersion,
} from "./mutants.js";

const real: Make = (clock: IdClock, fillRandom: FillRandom): UuidV7Generator =>
  createUuidV7Generator({ clock, fillRandom });

const MS = 0x017f22e279b0;

const checks = {
  sameMillisecondOrder: (make: Make) => {
    const ids = make(frozenClock(MS), seededRandom(11));
    expectStrictlyIncreasing(generate(() => ids.next(), 10_000));
  },
  backwardsClockOrder: (make: Make) => {
    const ids = make(
      sequenceClock([MS, MS - 1, MS - 500, 0, MS, MS + 1]),
      seededRandom(12),
    );
    expectStrictlyIncreasing(generate(() => ids.next(), 6));
  },
  timestampBits: (make: Make) => {
    for (const ms of [0, 1, 2 ** 32, MS, 2 ** 48 - 1]) {
      const id = make(frozenClock(ms), seededRandom(13)).next();
      expect(timestampField(id)).toBe(BigInt(ms));
    }
  },
  versionAndVariant: (make: Make) => {
    const ids = make(frozenClock(MS), seededRandom(14));
    expectVersionAndVariant(generate(() => ids.next(), 1_000));
  },
};

type Parse = (input: unknown) => string;
const parseChecks = {
  rejectsUppercase: (parse: Parse) => {
    expect(() => parse("017F22E2-79B0-7CC3-98C4-DC0C0C07398F")).toThrow();
  },
  rejectsOtherVersions: (parse: Parse) => {
    expect(() => parse("017f22e2-79b0-4cc3-98c4-dc0c0c07398f")).toThrow();
  },
  neverEchoesInput: (parse: Parse) => {
    let caught: unknown;
    try {
      parse("deadbeef-cafe-4abc-8def-0123456789ab");
    } catch (error) {
      caught = error;
    }
    expectNoSentinel(caught, ["deadbeef"]);
  },
};

describe("controls: the real code passes every check", () => {
  it.each(Object.entries(checks))("%s", (_name, check) => {
    check(real);
  });
  it.each(Object.entries(parseChecks))("%s", (_name, check) => {
    check(parseUuidV7);
  });
});

describe("mutants: each broken variant fails the check that targets it", () => {
  it.each([
    [
      "counter never increments",
      counterNeverIncrements,
      checks.sameMillisecondOrder,
    ],
    [
      "follows a backwards clock",
      followsBackwardsClock,
      checks.backwardsClockOrder,
    ],
    ["timestamp truncated", truncatedTimestamp, checks.timestampBits],
    ["variant 11", wrongVariant, checks.versionAndVariant],
    ["version 4", wrongVersion, checks.versionAndVariant],
  ] as const)("%s", (_name, mutant, check) => {
    expect(() => {
      check(mutant);
    }).toThrow();
  });

  it.each([
    [
      "parse accepts uppercase",
      parseAcceptsUppercase,
      parseChecks.rejectsUppercase,
    ],
    [
      "parse accepts any version",
      parseAcceptsAnyVersion,
      parseChecks.rejectsOtherVersions,
    ],
    ["parse echoes its input", parseEchoesInput, parseChecks.neverEchoesInput],
  ] as const)("%s", (_name, mutant, check) => {
    expect(() => {
      check(mutant);
    }).toThrow();
  });
});
