import { describe, expect, it } from "vitest";
import { ConfigError, apiKeys, loadApiConfig } from "../src/api.js";
import { loadClientPublicConfig } from "../src/client-public.js";
import { loadWorkerConfig, workerKeys } from "../src/worker.js";
import { devApiEnv, devClientEnv, devWorkerEnv, without } from "./env.js";

function problemsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems.map((p) => `${p.key}:${p.code}`);
  }
  throw new Error("expected a ConfigError");
}

describe("fail fast with a readable message", () => {
  it("a missing DATABASE_URL throws, naming the key", () => {
    expect(() => loadApiConfig(without(devApiEnv, "DATABASE_URL"))).toThrow(
      /api config is invalid[\s\S]*DATABASE_URL: missing/,
    );
    expect(() =>
      loadWorkerConfig(without(devWorkerEnv, "DATABASE_URL")),
    ).toThrow(/worker config is invalid[\s\S]*DATABASE_URL: missing/);
  });

  it("reports every invalid key at once", () => {
    const env = {
      ...without(devApiEnv, "DATABASE_URL"),
      API_PORT: "0",
      LOG_LEVEL: "loud",
      S3_ENDPOINT: "not a url",
    };
    expect(problemsOf(() => loadApiConfig(env)).sort()).toEqual([
      "API_PORT:too_small",
      "DATABASE_URL:missing",
      "LOG_LEVEL:invalid_value",
      "S3_ENDPOINT:invalid_format",
    ]);
  });

  it("an empty string counts as missing", () => {
    expect(
      problemsOf(() => loadApiConfig({ ...devApiEnv, VALKEY_URL: "" })),
    ).toEqual(["VALKEY_URL:missing"]);
    expect(
      problemsOf(() => loadClientPublicConfig({ EXPO_PUBLIC_API_URL: "" })),
    ).toEqual(["EXPO_PUBLIC_API_URL:missing"]);
  });

  it("an empty environment reports every declared key as missing", () => {
    expect(problemsOf(() => loadApiConfig({})).sort()).toEqual(
      [...apiKeys].map((k) => `${k}:missing`).sort(),
    );
  });
});

describe("only the declared keys are read", () => {
  it("reads nothing but the declared keys and ignores other variables", () => {
    const read: (string | symbol)[] = [];
    const env = new Proxy(
      { ...devApiEnv, UNRELATED: "x", npm_config_foo: "y" },
      {
        get(target, key, receiver) {
          read.push(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
        ownKeys() {
          throw new Error("the loader must not enumerate the environment");
        },
        has() {
          throw new Error("the loader must not probe the environment");
        },
        getOwnPropertyDescriptor() {
          throw new Error("the loader must not probe the environment");
        },
      },
    );
    expect(() => loadApiConfig(env)).not.toThrow();
    expect([...new Set(read)].sort()).toEqual([...apiKeys].sort());
  });

  it("the worker declares the shared keys, the relay URL and the dead-letter threshold (P4-06)", () => {
    expect([...workerKeys].sort()).toEqual(
      [
        ...apiKeys.filter((k) => k !== "API_PORT" && k !== "CORS_ORIGINS"),
        "RELAY_DATABASE_URL",
        "OUTBOX_DEAD_LETTER_AFTER",
      ].sort(),
    );
  });
});

describe("API_PORT", () => {
  it.each([
    ["1", 1],
    ["4000", 4000],
    ["65535", 65535],
  ])("accepts %s", (value, port) => {
    expect(loadApiConfig({ ...devApiEnv, API_PORT: value }).http.port).toBe(
      port,
    );
  });

  it.each([
    ["0", "too_small"],
    ["65536", "too_big"],
    ["99999", "too_big"],
    ["-1", "invalid_format"],
    ["40.5", "invalid_format"],
    ["4e3", "invalid_format"],
    [" 4000", "invalid_format"],
    ["abc", "invalid_format"],
  ])("rejects %j (%s)", (value, code) => {
    expect(
      problemsOf(() => loadApiConfig({ ...devApiEnv, API_PORT: value })),
    ).toEqual([`API_PORT:${code}`]);
  });
});

describe("CORS_ORIGINS", () => {
  it("parses a comma list of exact origins", () => {
    const config = loadApiConfig({
      ...devApiEnv,
      CORS_ORIGINS: "https://app.bricx.example, http://localhost:8081",
    });
    expect(config.http.corsOrigins).toEqual([
      "https://app.bricx.example",
      "http://localhost:8081",
    ]);
  });

  it.each([
    "https://app.bricx.example/",
    "https://app.bricx.example/path",
    "https://app.bricx.example?x=1",
    "app.bricx.example",
    "ftp://app.bricx.example",
    "https://app.bricx.example,,https://b.example",
    "https://user@app.bricx.example",
    "https://APP.bricx.example",
  ])("rejects %j", (value) => {
    expect(
      problemsOf(() => loadApiConfig({ ...devApiEnv, CORS_ORIGINS: value })),
    ).toEqual(["CORS_ORIGINS:invalid_format"]);
  });
});

describe("returned config", () => {
  it("is typed and frozen", () => {
    const config = loadApiConfig(devApiEnv);
    expect(config.nodeEnv).toBe("development");
    expect(config.logLevel).toBe("debug");
    expect(config.s3).toMatchObject({
      endpoint: "http://127.0.0.1:8333",
      region: "us-east-1",
      bucket: "bricx-dev",
      accessKeyId: "test-access-key-id-1",
    });
    expect(config.otel.endpoint).toBe("http://127.0.0.1:4318");
    expect(config.database.url.reveal()).toBe(devApiEnv.DATABASE_URL);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.http.corsOrigins)).toBe(true);
    expect(Object.isFrozen(config.s3)).toBe(true);
  });

  it("client-public returns its URL", () => {
    expect(loadClientPublicConfig(devClientEnv).apiUrl).toBe(
      "http://127.0.0.1:4000",
    );
  });

  it("rejects a client API URL that is not http(s)", () => {
    expect(
      problemsOf(() =>
        loadClientPublicConfig({ EXPO_PUBLIC_API_URL: "javascript:alert(1)" }),
      ),
    ).toEqual(["EXPO_PUBLIC_API_URL:invalid_format"]);
  });

  it("rejects URLs with the wrong scheme for each service", () => {
    expect(
      problemsOf(() =>
        loadApiConfig({
          ...devApiEnv,
          DATABASE_URL: "mysql://u:p@db.example/x",
          VALKEY_URL: "http://cache.example",
        }),
      ).sort(),
    ).toEqual(["DATABASE_URL:invalid_format", "VALKEY_URL:invalid_format"]);
  });
});
