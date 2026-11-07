// P5-03 (ADR 0063; phase ruling D6, owner condition 7): the idle limit of
// a session. The realm's ssoSessionIdleTimeout (12 h) is the maximum; an
// organisation's value (stored by P6-03) can only shorten it, and a value
// that is not a positive integer falls back to the realm's.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { Database } from "@bricx/db/database";
import { SESSION_IDLE_SECONDS } from "@bricx/domain/limits";
import {
  DbOrgSessionPolicy,
  REALM_IDLE_SECONDS,
  clampIdleSeconds,
  realmSessionPolicy,
  touchSeconds,
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

describe("realmSessionPolicy (tests only since P6-03)", () => {
  test("answers the realm value for every org", async () => {
    expect(
      await realmSessionPolicy.idleSeconds(
        "0199e1a0-0000-7000-8000-00000000000a",
        "0199e1a0-0000-7000-8000-000000000001",
      ),
    ).toBe(REALM_IDLE_SECONDS);
  });
});

describe("the 12 h is one named constant (P6-03, owner condition C2)", () => {
  test("REALM_IDLE_SECONDS is @bricx/domain's SESSION_IDLE_SECONDS.max; the source has no 43_200 literal", () => {
    expect(REALM_IDLE_SECONDS).toBe(SESSION_IDLE_SECONDS.max);
    const source = readFileSync(
      path.resolve(import.meta.dirname, "../src/common/auth/session-policy.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/43[_]?200/);
  });
});

describe("DbOrgSessionPolicy (production, P6-03 D13)", () => {
  const ORG = "0199e1a0-0000-7000-8000-00000000000a";
  const USER = "0199e1a0-0000-7000-8000-000000000001";

  test("reads the org row in its own withTx() as the user in the org, on every call (no cache)", async () => {
    const contexts: unknown[] = [];
    let stored: number | null = 900;
    const database = {
      withTx: (context: unknown, fn: (tx: unknown) => Promise<unknown>) => {
        contexts.push(context);
        return fn({
          select: () => ({
            from: () => ({
              where: () =>
                Promise.resolve(stored === null ? [] : [{ seconds: stored }]),
            }),
          }),
        });
      },
    } as unknown as Database;
    const policy = new DbOrgSessionPolicy(database);
    expect(await policy.idleSeconds(ORG, USER)).toBe(900);
    stored = 600;
    expect(await policy.idleSeconds(ORG, USER)).toBe(600);
    stored = null;
    expect(await policy.idleSeconds(ORG, USER)).toBeNull();
    expect(clampIdleSeconds(await policy.idleSeconds(ORG, USER))).toBe(
      REALM_IDLE_SECONDS,
    );
    expect(contexts).toHaveLength(4);
    expect(contexts[0]).toEqual({ orgId: ORG, userId: USER, projectIds: [] });
  });
});

describe("touchSeconds(throttle, idle) (P6-03)", () => {
  test.each([
    [300, 43_200, 300],
    [300, 3_000, 300],
    [300, 600, 60],
    [300, 60, 6],
    [0, 600, 0],
    [86_400, 43_200, 4_320],
  ])(
    "throttle %s s, idle %s s: last_seen_at moves after %s s",
    (throttle, idle, expected) => {
      expect(touchSeconds(throttle, idle)).toBe(expected);
    },
  );
});
