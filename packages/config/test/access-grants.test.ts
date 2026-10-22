// P5-06 (ADR 0067, D-C): ACCESS_GRANTS_MAX_PER_USER caps the open
// temporary elevations one user may hold per organisation (the next POST
// /v1/access-grants is 409; 1-1000, unset 20) and ACCESS_GRANT_MAX_SECONDS
// the length of one elevation (60-2592000 s, unset 86400 = 24 h).
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_ACCESS_GRANT_MAX_SECONDS,
  DEFAULT_MAX_ACCESS_GRANTS_PER_USER,
  apiKeys,
  loadApiConfig,
} from "../src/api.js";
import { devApiEnv, prodApiEnv } from "./env.js";

function problemsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems.map((p) => `${p.key}:${p.code}`);
  }
  return [];
}

describe("ACCESS_GRANTS_MAX_PER_USER and ACCESS_GRANT_MAX_SECONDS", () => {
  it("are declared and optional: unset gives 20 open grants and 86400 s, in development and production", () => {
    expect(apiKeys).toContain("ACCESS_GRANTS_MAX_PER_USER");
    expect(apiKeys).toContain("ACCESS_GRANT_MAX_SECONDS");
    expect(DEFAULT_MAX_ACCESS_GRANTS_PER_USER).toBe(20);
    expect(DEFAULT_ACCESS_GRANT_MAX_SECONDS).toBe(86_400);
    for (const env of [devApiEnv, prodApiEnv]) {
      expect("ACCESS_GRANTS_MAX_PER_USER" in env).toBe(false);
      expect("ACCESS_GRANT_MAX_SECONDS" in env).toBe(false);
      expect(loadApiConfig(env).accessGrants).toEqual({
        maxPerUser: DEFAULT_MAX_ACCESS_GRANTS_PER_USER,
        maxSeconds: DEFAULT_ACCESS_GRANT_MAX_SECONDS,
      });
    }
  });

  it.each([
    ["1", 1],
    ["20", 20],
    ["1000", 1000],
  ])("ACCESS_GRANTS_MAX_PER_USER=%s gives %d", (value, max) => {
    expect(
      loadApiConfig({ ...devApiEnv, ACCESS_GRANTS_MAX_PER_USER: value })
        .accessGrants.maxPerUser,
    ).toBe(max);
  });

  it.each([
    ["60", 60],
    ["3600", 3600],
    ["86400", 86_400],
    ["2592000", 2_592_000],
  ])("ACCESS_GRANT_MAX_SECONDS=%s gives %d", (value, max) => {
    expect(
      loadApiConfig({ ...devApiEnv, ACCESS_GRANT_MAX_SECONDS: value })
        .accessGrants.maxSeconds,
    ).toBe(max);
  });

  it("an empty value is unset", () => {
    expect(
      loadApiConfig({
        ...devApiEnv,
        ACCESS_GRANTS_MAX_PER_USER: "",
        ACCESS_GRANT_MAX_SECONDS: "",
      }).accessGrants,
    ).toEqual({ maxPerUser: 20, maxSeconds: 86_400 });
  });

  it.each(["0", "-1", "1001", "1.5", "twenty", "20 ", "0x14"])(
    "ACCESS_GRANTS_MAX_PER_USER refuses %j (one problem naming the key, never the value)",
    (value) => {
      const problems = problemsOf(() =>
        loadApiConfig({ ...devApiEnv, ACCESS_GRANTS_MAX_PER_USER: value }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^ACCESS_GRANTS_MAX_PER_USER:/);
      expect(problems[0]).not.toContain(value.trim());
    },
  );

  it.each(["0", "59", "2592001", "-60", "1e3", "a day", "60 ", "0x3c"])(
    "ACCESS_GRANT_MAX_SECONDS refuses %j (one problem naming the key, never the value)",
    (value) => {
      const problems = problemsOf(() =>
        loadApiConfig({ ...devApiEnv, ACCESS_GRANT_MAX_SECONDS: value }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^ACCESS_GRANT_MAX_SECONDS:/);
      expect(problems[0]).not.toContain(value.trim());
    },
  );

  it("the config is frozen", () => {
    expect(Object.isFrozen(loadApiConfig(devApiEnv).accessGrants)).toBe(true);
  });
});
