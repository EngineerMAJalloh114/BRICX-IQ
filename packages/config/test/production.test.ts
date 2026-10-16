import { describe, expect, it } from "vitest";
import { ConfigError, loadApiConfig } from "../src/api.js";
import { loadWorkerConfig } from "../src/worker.js";
import { devApiEnv, prodApiEnv, prodWorkerEnv } from "./env.js";

function problemsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems.map((p) => `${p.key}:${p.code}`);
  }
  return [];
}

describe("production guards (NODE_ENV=production)", () => {
  it("accepts a clean production environment", () => {
    expect(problemsOf(() => loadApiConfig(prodApiEnv))).toEqual([]);
  });

  it.each([
    "DATABASE_URL",
    "VALKEY_URL",
    "S3_ACCESS_KEY_ID",
    "S3_SECRET_ACCESS_KEY",
    "S3_BUCKET",
  ] as const)("rejects a value containing dev-only in %s", (key) => {
    const value =
      key === "DATABASE_URL"
        ? "postgres://bricx_app:dev-only-pw-123456@db.internal.example/bricx"
        : key === "VALKEY_URL"
          ? "rediss://default:dev-only-pw@cache.internal.example:6379"
          : key === "S3_BUCKET"
            ? "dev-only-bucket"
            : "dev-only-0123456789abcdef";
    expect(
      problemsOf(() => loadApiConfig({ ...prodApiEnv, [key]: value })),
    ).toEqual([`${key}:dev_only_value_in_production`]);
  });

  it.each([
    "postgres://bricx_app:pw-0123456789@localhost:5432/bricx",
    "postgres://bricx_app:pw-0123456789@LOCALHOST:5432/bricx",
    "postgres://bricx_app:pw-0123456789@db.localhost:5432/bricx",
    "postgres://bricx_app:pw-0123456789@127.0.0.1:5432/bricx",
    "postgres://bricx_app:pw-0123456789@127.10.0.5:5432/bricx",
    "postgresql://bricx_app:pw-0123456789@[::1]:5432/bricx",
    "postgres://bricx_app:pw-0123456789@0.0.0.0:5432/bricx",
  ])("rejects a local DATABASE_URL host: %s", (url) => {
    expect(
      problemsOf(() => loadApiConfig({ ...prodApiEnv, DATABASE_URL: url })),
    ).toEqual(["DATABASE_URL:local_host_in_production"]);
    expect(
      problemsOf(() =>
        loadWorkerConfig({ ...prodWorkerEnv, DATABASE_URL: url }),
      ),
    ).toEqual(["DATABASE_URL:local_host_in_production"]);
  });

  it.each([
    "redis://default:pw-0123456789@localhost:6379",
    "rediss://default:pw-0123456789@127.0.0.1:6379",
    "redis://default:pw-0123456789@[::1]:6379",
    "redis://default:pw-0123456789@0.0.0.0:6379",
    "redis://default:pw-0123456789@cache.localhost:6379",
  ])("rejects a local VALKEY_URL host: %s", (url) => {
    expect(
      problemsOf(() => loadApiConfig({ ...prodApiEnv, VALKEY_URL: url })),
    ).toEqual(["VALKEY_URL:local_host_in_production"]);
    expect(
      problemsOf(() => loadWorkerConfig({ ...prodWorkerEnv, VALKEY_URL: url })),
    ).toEqual(["VALKEY_URL:local_host_in_production"]);
  });

  it.each([
    "http://localhost:8333",
    "http://127.0.0.1:8333",
    "https://127.1.2.3",
    "http://[::1]:9000",
    "http://0.0.0.0:9000",
  ])("rejects a local S3_ENDPOINT host: %s", (endpoint) => {
    expect(
      problemsOf(() => loadApiConfig({ ...prodApiEnv, S3_ENDPOINT: endpoint })),
    ).toEqual(["S3_ENDPOINT:local_host_in_production"]);
    expect(
      problemsOf(() =>
        loadWorkerConfig({ ...prodWorkerEnv, S3_ENDPOINT: endpoint }),
      ),
    ).toEqual(["S3_ENDPOINT:local_host_in_production"]);
  });

  it.each([
    "http://127.0.0.1:4318",
    "http://localhost:4318",
    "http://0.0.0.0:4318",
  ])(
    "allows a local OTEL_EXPORTER_OTLP_ENDPOINT (collector sidecar): %s",
    (endpoint) => {
      expect(
        problemsOf(() =>
          loadApiConfig({
            ...prodApiEnv,
            OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
          }),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    ["S3_ACCESS_KEY_ID", "bricx-dev-access-key"],
    ["S3_BUCKET", "bricx-dev"],
    ["S3_BUCKET", "bricx-dev-uploads"],
    ["S3_SECRET_ACCESS_KEY", "BRICX-DEV-0123456789abcdef"],
    [
      "DATABASE_URL",
      "postgres://bricx_app:pw-0123456789@bricx-dev.db.example/bricx",
    ],
    ["S3_ENDPOINT", "https://bricx-dev.s3.example"],
  ] as const)(
    "rejects a value containing bricx-dev in %s (%s)",
    (key, value) => {
      expect(
        problemsOf(() => loadApiConfig({ ...prodApiEnv, [key]: value })),
      ).toEqual([`${key}:bricx_dev_value_in_production`]);
    },
  );

  it("accepts a normal production config, with a local OTel sidecar", () => {
    const env = {
      ...prodApiEnv,
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
    };
    expect(problemsOf(() => loadApiConfig(env))).toEqual([]);
    expect(
      problemsOf(() =>
        loadWorkerConfig({
          ...prodWorkerEnv,
          OTEL_EXPORTER_OTLP_ENDPOINT: "http://127.0.0.1:4318",
        }),
      ),
    ).toEqual([]);
    const config = loadApiConfig(env);
    expect(config.nodeEnv).toBe("production");
    expect(config.s3.bucket).toBe("bricx-prod");
  });

  it.each(["*", "https://*.bricx.example", "https://app.bricx.example,*"])(
    "rejects a wildcard in CORS_ORIGINS: %j",
    (origins) => {
      expect(
        problemsOf(() =>
          loadApiConfig({ ...prodApiEnv, CORS_ORIGINS: origins }),
        ),
      ).toEqual(["CORS_ORIGINS:wildcard_in_production"]);
    },
  );

  it("reports production problems together with field problems", () => {
    expect(
      problemsOf(() =>
        loadApiConfig({
          ...prodApiEnv,
          API_PORT: "70000",
          DATABASE_URL: "postgres://u:dev-only-x@127.0.0.1/db",
        }),
      ).sort(),
    ).toEqual([
      "API_PORT:too_big",
      "DATABASE_URL:dev_only_value_in_production",
      "DATABASE_URL:local_host_in_production",
    ]);
  });
});

describe("development and test allow them", () => {
  it.each(["development", "test"])("NODE_ENV=%s", (nodeEnv) => {
    const env = {
      ...devApiEnv,
      NODE_ENV: nodeEnv,
      DATABASE_URL:
        "postgres://bricx_app:dev-only-bricx-app-password@localhost:5432/bricx_dev",
      S3_SECRET_ACCESS_KEY: "dev-only-s3-secret-key",
      CORS_ORIGINS: "*,https://*.bricx.example,http://localhost:8081",
      VALKEY_URL: "redis://default:pw@localhost:6379",
      S3_ENDPOINT: "http://localhost:8333",
      S3_BUCKET: "bricx-dev",
      S3_ACCESS_KEY_ID: "bricx-dev-access-key",
    };
    const config = loadApiConfig(env);
    expect(config.http.corsOrigins).toEqual([
      "*",
      "https://*.bricx.example",
      "http://localhost:8081",
    ]);
  });
});
