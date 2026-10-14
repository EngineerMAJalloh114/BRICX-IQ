// Sabotage (P3 rule 1, permanent): every check in checks.ts passes on the
// real code and fails on its deliberately broken variant in mutants.ts. If
// a check stops catching its mutant, this file fails. Compiler sabotages
// live in types-sabotage.test.ts.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fixedClock, manualClock } from "../src/clock.ts";
import {
  defineMachine,
  toXStateConfig,
  transitionInput,
} from "../src/machine.ts";
import { convert, parseQuantity } from "../src/units.ts";
import {
  checkAdvanceBounded,
  checkBoundsBeforeRead,
  checkClockRejectsFraction,
  checkConvertDirection,
  checkConvertRounds,
  checkDeadEndRejected,
  checkGuardsEnforced,
  checkNoInputInErrors,
  checkParseBoundFirst,
  checkParseStrict,
  checkPrototypeNames,
  checkRegionDataDriven,
  checkStateLimit,
  checkUndeclaredTargetRejected,
  checkUnreachableRejected,
  checkXStateKeepsGuards,
} from "./checks.ts";
import type { Define, Step } from "./checks.ts";
import {
  convertInverted,
  convertTruncating,
  defineAutoDeclaringTargets,
  defineReadsFirst,
  defineWithoutDeadEnds,
  defineWithoutReachability,
  fixedClockLoose,
  manualClockWrapping,
  parseAcceptingExponent,
  parseRegexFirst,
  regionsBranchingSource,
  stepEchoingInput,
  stepIgnoringGuards,
  stepObjectLookup,
  toXStateConfigDroppingGuards,
} from "./mutants.ts";

const realDefine = defineMachine as Define;
const realStep = transitionInput as Step;
const regionsSource = readFileSync(
  path.join(import.meta.dirname, "../src/regions.ts"),
  "utf8",
);

describe("the checks pass on the real code", () => {
  it("all of them", () => {
    checkGuardsEnforced(realStep);
    checkPrototypeNames(realStep);
    checkUndeclaredTargetRejected(realDefine);
    checkUnreachableRejected(realDefine);
    checkDeadEndRejected(realDefine);
    checkBoundsBeforeRead(realDefine);
    checkStateLimit(realDefine);
    checkConvertRounds(convert);
    checkConvertDirection(convert);
    checkParseStrict(parseQuantity);
    checkParseBoundFirst(parseQuantity);
    checkNoInputInErrors(realStep);
    checkRegionDataDriven(regionsSource);
    checkXStateKeepsGuards(toXStateConfig);
    checkClockRejectsFraction(fixedClock);
    checkClockRejectsFraction(manualClock);
    checkAdvanceBounded(manualClock);
  });
});

describe("each mutant is caught", () => {
  it.each([
    [
      "1 guard ignored",
      () => {
        checkGuardsEnforced(stepIgnoringGuards);
      },
    ],
    [
      "2 transition to an undeclared state accepted",
      () => {
        checkUndeclaredTargetRejected(defineAutoDeclaringTargets);
      },
    ],
    [
      "3 reachability check skipped",
      () => {
        checkUnreachableRejected(defineWithoutReachability);
      },
    ],
    [
      "4 bounds checked after reading",
      () => {
        checkBoundsBeforeRead(defineReadsFirst);
      },
    ],
    [
      "5 dead-end check skipped",
      () => {
        checkDeadEndRejected(defineWithoutDeadEnds);
      },
    ],
    [
      "6 convert always truncates",
      () => {
        checkConvertRounds(convertTruncating);
      },
    ],
    [
      "7 convert inverts the factor",
      () => {
        checkConvertDirection(convertInverted);
      },
    ],
    [
      "8 parse accepts an exponent",
      () => {
        checkParseStrict(parseAcceptingExponent);
      },
    ],
    [
      "9 parse length bound skipped",
      () => {
        checkParseBoundFirst(parseRegexFirst);
      },
    ],
    [
      "10 error echoes the input",
      () => {
        checkNoInputInErrors(stepEchoingInput);
      },
    ],
    [
      "11 region chosen by a code branch",
      () => {
        checkRegionDataDriven(regionsBranchingSource);
      },
    ],
    [
      "12 toXStateConfig drops guards",
      () => {
        checkXStateKeepsGuards(toXStateConfigDroppingGuards);
      },
    ],
    [
      "13 clock accepts a fraction (constructor)",
      () => {
        checkClockRejectsFraction(fixedClockLoose);
      },
    ],
    [
      "14 advance accepts a fraction and wraps",
      () => {
        checkAdvanceBounded(manualClockWrapping);
      },
    ],
    [
      "15 plain object lookup instead of a Map (ruling 3)",
      () => {
        checkPrototypeNames(stepObjectLookup);
      },
    ],
  ] as const)("%s", (_name, run) => {
    expect(run).toThrow();
  });

  it("the mutants that stay silent on valid input (controls)", () => {
    // These mutants are wrong only where their check looks, so a happy-path
    // call still works: the checks are what catch them, not a crash.
    expect(
      defineWithoutReachability({
        id: "m",
        initial: "a",
        states: ["a", "b"],
        events: ["go"],
        final: ["b"],
        transitions: [{ from: "a", event: "go", to: "b" }],
      }).initial,
    ).toBe("a");
    expect(fixedClockLoose(5).now()).toBe(5);
    expect(parseAcceptingExponent("12.5", "m").ok).toBe(true);
  });
});
