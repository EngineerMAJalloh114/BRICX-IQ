// P5-03 review (owner, 2026-10-21, fix 2): DEVICES_MAX_PER_USER caps the
// non-revoked devices one user may register (POST /v1/devices over the cap
// is 409). 1-1000, unset 20.
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_MAX_DEVICES_PER_USER,
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

describe("DEVICES_MAX_PER_USER", () => {
  it("is declared and optional: unset gives the default 20, in development and production", () => {
    expect(apiKeys).toContain("DEVICES_MAX_PER_USER");
    expect(DEFAULT_MAX_DEVICES_PER_USER).toBe(20);
    // Neither fixture sets the key.
    for (const env of [devApiEnv, prodApiEnv]) {
      expect("DEVICES_MAX_PER_USER" in env).toBe(false);
      expect(loadApiConfig(env).devices).toEqual({
        maxPerUser: DEFAULT_MAX_DEVICES_PER_USER,
      });
    }
  });

  it.each([
    ["1", 1],
    ["20", 20],
    ["1000", 1000],
  ])("%s gives %d", (value, max) => {
    expect(
      loadApiConfig({ ...devApiEnv, DEVICES_MAX_PER_USER: value }).devices
        .maxPerUser,
    ).toBe(max);
  });

  it("an empty value is unset: 20", () => {
    expect(
      loadApiConfig({ ...devApiEnv, DEVICES_MAX_PER_USER: "" }).devices
        .maxPerUser,
    ).toBe(20);
  });

  it.each(["0", "-1", "1001", "1.5", "twenty", "20 ", "0x14"])(
    "refuses %j (one problem naming the key, never the value)",
    (value) => {
      const problems = problemsOf(() =>
        loadApiConfig({ ...devApiEnv, DEVICES_MAX_PER_USER: value }),
      );
      expect(problems).toHaveLength(1);
      expect(problems[0]).toMatch(/^DEVICES_MAX_PER_USER:/);
      expect(problems[0]).not.toContain(value.trim());
    },
  );

  it("the config is frozen", () => {
    const config = loadApiConfig(devApiEnv);
    expect(Object.isFrozen(config.devices)).toBe(true);
  });
});
