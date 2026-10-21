// P5-02 (phase rulings D1 and D8, owner condition 3, ADR 0062): the API's
// token and OpenAPI keys.
// - KEYCLOAK_ISSUER: an http(s) realm URL (…/realms/<name>, no trailing
//   slash, query or fragment); production requires https and a remote
//   host, so a local test JWKS can never be trusted there.
// - OPENAPI_EXPOSURE: public | authenticated | off; unset means public in
//   development and test and off in production; public in production is
//   refused at load.
// - USERS_LAST_SEEN_THROTTLE_SECONDS: 0-86400, unset 300.
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  DEFAULT_LAST_SEEN_THROTTLE_SECONDS,
  TOKEN_AUDIENCE,
  apiKeys,
  loadApiConfig,
} from "../src/api.js";
import { devApiEnv, prodApiEnv, without } from "./env.js";

function problemsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems.map((p) => `${p.key}:${p.code}`);
  }
  return [];
}

describe("KEYCLOAK_ISSUER", () => {
  it("is declared and required", () => {
    expect(apiKeys).toContain("KEYCLOAK_ISSUER");
    expect(
      problemsOf(() => loadApiConfig(without(devApiEnv, "KEYCLOAK_ISSUER"))),
    ).toEqual(["KEYCLOAK_ISSUER:missing"]);
  });

  it("the dev value gives the issuer, the fixed audience bricx-api and the JWKS URL", () => {
    const config = loadApiConfig(devApiEnv);
    expect(config.auth).toEqual({
      issuer: "http://localhost:8080/realms/bricx",
      audience: "bricx-api",
      jwksUrl:
        "http://localhost:8080/realms/bricx/protocol/openid-connect/certs",
      lastSeenThrottleSeconds: DEFAULT_LAST_SEEN_THROTTLE_SECONDS,
    });
    expect(TOKEN_AUDIENCE).toBe("bricx-api");
    expect(DEFAULT_LAST_SEEN_THROTTLE_SECONDS).toBe(300);
  });

  it.each([
    "localhost:8080/realms/bricx",
    "ftp://localhost:8080/realms/bricx",
    "http://localhost:8080/realms/bricx/",
    "http://localhost:8080/realms/",
    "http://localhost:8080/bricx",
    "http://localhost:8080/realms/bricx?x=1",
    "http://localhost:8080/realms/bricx#f",
    "http://user:pw@localhost:8080/realms/bricx",
    `http://localhost:8080/realms/${"r".repeat(300)}`,
  ])("refuses %s", (value) => {
    expect(
      problemsOf(() => loadApiConfig({ ...devApiEnv, KEYCLOAK_ISSUER: value })),
    ).toEqual(["KEYCLOAK_ISSUER:invalid_format"]);
  });

  it("production: an https remote issuer passes", () => {
    expect(problemsOf(() => loadApiConfig(prodApiEnv))).toEqual([]);
    expect(loadApiConfig(prodApiEnv).auth.issuer).toBe(
      "https://auth.bricx.example/realms/bricx",
    );
  });

  it.each([
    ["http://auth.bricx.example/realms/bricx", "https_required_in_production"],
    ["https://localhost:8443/realms/bricx", "local_host_in_production"],
    ["https://127.0.0.1/realms/bricx", "local_host_in_production"],
  ])("production refuses %s (%s)", (value, code) => {
    expect(
      problemsOf(() =>
        loadApiConfig({ ...prodApiEnv, KEYCLOAK_ISSUER: value }),
      ),
    ).toEqual([`KEYCLOAK_ISSUER:${code}`]);
  });
});

describe("OPENAPI_EXPOSURE (D1)", () => {
  it("unset: public in development and test, off in production", () => {
    expect(loadApiConfig(devApiEnv).openApiExposure).toBe("public");
    expect(
      loadApiConfig({ ...devApiEnv, NODE_ENV: "test" }).openApiExposure,
    ).toBe("public");
    expect(loadApiConfig(prodApiEnv).openApiExposure).toBe("off");
  });

  it.each(["public", "authenticated", "off"] as const)(
    "development accepts %s",
    (mode) => {
      expect(
        loadApiConfig({ ...devApiEnv, OPENAPI_EXPOSURE: mode }).openApiExposure,
      ).toBe(mode);
    },
  );

  it.each(["authenticated", "off"] as const)(
    "production accepts %s",
    (mode) => {
      expect(
        loadApiConfig({ ...prodApiEnv, OPENAPI_EXPOSURE: mode })
          .openApiExposure,
      ).toBe(mode);
    },
  );

  it("production refuses public at load", () => {
    expect(
      problemsOf(() =>
        loadApiConfig({ ...prodApiEnv, OPENAPI_EXPOSURE: "public" }),
      ),
    ).toEqual(["OPENAPI_EXPOSURE:public_in_production"]);
  });

  it("an empty value is unset: the default", () => {
    expect(
      loadApiConfig({ ...prodApiEnv, OPENAPI_EXPOSURE: "" }).openApiExposure,
    ).toBe("off");
  });

  it.each(["PUBLIC", "on", " public"])("refuses %j", (value) => {
    expect(
      problemsOf(() =>
        loadApiConfig({ ...devApiEnv, OPENAPI_EXPOSURE: value }),
      ),
    ).toEqual(["OPENAPI_EXPOSURE:invalid_value"]);
  });
});

describe("USERS_LAST_SEEN_THROTTLE_SECONDS (condition 3)", () => {
  it.each([
    ["0", 0],
    ["60", 60],
    ["86400", 86_400],
  ])("%s gives %d", (value, seconds) => {
    expect(
      loadApiConfig({ ...devApiEnv, USERS_LAST_SEEN_THROTTLE_SECONDS: value })
        .auth.lastSeenThrottleSeconds,
    ).toBe(seconds);
  });

  it("an empty value is unset: 300", () => {
    expect(
      loadApiConfig({ ...devApiEnv, USERS_LAST_SEEN_THROTTLE_SECONDS: "" }).auth
        .lastSeenThrottleSeconds,
    ).toBe(300);
  });

  it.each(["-1", "86401", "1.5", "five", "123456"])("refuses %j", (value) => {
    expect(
      problemsOf(() =>
        loadApiConfig({
          ...devApiEnv,
          USERS_LAST_SEEN_THROTTLE_SECONDS: value,
        }),
      ),
    ).toHaveLength(1);
  });
});
