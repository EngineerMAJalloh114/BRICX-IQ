// P5-03 (ADR 0063; phase ruling D6, owner condition 7): the idle limit of
// a session. The realm's ssoSessionIdleTimeout (12 h) is the maximum; an
// organisation's value (stored by P6-03) can only shorten it, and a value
// that is not a positive integer falls back to the realm's.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  REALM_IDLE_SECONDS,
  clampIdleSeconds,
  realmSessionPolicy,
} from "../src/common/auth/session-policy.js";

const realmFile = path.resolve(
  import.meta.dirname,
  "../../../infrastructure/keycloak/realm-bricx.json",
);

describe("REALM_IDLE_SECONDS", () => {
  test("is the realm's ssoSessionIdleTimeout (12 h), read from realm-bricx.json", () => {
    const realm = JSON.parse(readFileSync(realmFile, "utf8")) as {
      ssoSessionIdleTimeout: number;
    };
    expect(realm.ssoSessionIdleTimeout).toBe(43_200);
    expect(REALM_IDLE_SECONDS).toBe(realm.ssoSessionIdleTimeout);
  });
});

describe("clampIdleSeconds(orgValue)", () => {
  test.each([
    [600, 600],
    [1, 1],
    [43_199, 43_199],
    [43_200, 43_200],
  ])(
    "a positive integer at or below the realm value is kept: %s",
    (value, expected) => {
      expect(clampIdleSeconds(value)).toBe(expected);
    },
  );

  test.each([43_201, 86_400, 1e9, Number.MAX_SAFE_INTEGER])(
    "an org value above the realm's is clamped to it (the org can only shorten): %s",
    (value) => {
      expect(clampIdleSeconds(value)).toBe(REALM_IDLE_SECONDS);
    },
  );

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a numeric string", "600"],
    ["null", null],
    ["undefined", undefined],
    ["a bigint", 600n],
    ["an object", { seconds: 600 }],
  ])(
    "a value that is not a positive integer falls back to the realm value (condition 7): %s",
    (_what, value) => {
      expect(clampIdleSeconds(value)).toBe(REALM_IDLE_SECONDS);
    },
  );
});

describe("realmSessionPolicy (production until P6-03)", () => {
  test("answers the realm value for every org", async () => {
    expect(
      await realmSessionPolicy.idleSeconds(
        "0199e1a0-0000-7000-8000-00000000000a",
      ),
    ).toBe(REALM_IDLE_SECONDS);
  });
});
