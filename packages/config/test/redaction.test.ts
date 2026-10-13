import { format, inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { ConfigError, Secret, loadApiConfig } from "../src/api.js";
import { loadClientPublicConfig } from "../src/client-public.js";
import { loadWorkerConfig } from "../src/worker.js";
import { devApiEnv, devWorkerEnv, prodApiEnv } from "./env.js";

/** Every way an error or a config object could reach a log or a response. */
function renderings(value: unknown): string[] {
  const out = [
    JSON.stringify(value),
    inspect(value),
    inspect(value, { depth: Infinity, showHidden: true }),
    inspect(value, { depth: Infinity, showHidden: true, customInspect: false }),
    format("%s %o %O %j", value, value, value, value),
    String(value),
  ];
  if (value instanceof Error) {
    out.push(
      value.message,
      value.stack ?? "",
      JSON.stringify(value, Object.getOwnPropertyNames(value)),
    );
  }
  return out;
}

function errorFrom(run: () => unknown): ConfigError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected a ConfigError");
}

// Each case puts a unique sentinel into the failing value. The sentinel
// must never reach the error in any rendering.
const sentinelCases: {
  mode: string;
  code: string;
  run: (sentinel: string) => unknown;
}[] = [
  {
    mode: "wrong type",
    code: "invalid_type",
    run: (s) =>
      loadApiConfig({
        ...devApiEnv,
        S3_REGION: { secret: s, toString: () => s },
      }),
  },
  {
    mode: "wrong type (array)",
    code: "invalid_type",
    run: (s) => loadApiConfig({ ...devApiEnv, S3_SECRET_ACCESS_KEY: [s, s] }),
  },
  {
    mode: "invalid URL",
    code: "invalid_format",
    run: (s) => loadApiConfig({ ...devApiEnv, DATABASE_URL: `not a url ${s}` }),
  },
  {
    mode: "invalid URL scheme",
    code: "invalid_format",
    run: (s) =>
      loadApiConfig({
        ...devApiEnv,
        DATABASE_URL: `mysql://u:${s}@db.example/x`,
      }),
  },
  {
    mode: "invalid client URL",
    code: "invalid_format",
    run: (s) => loadClientPublicConfig({ EXPO_PUBLIC_API_URL: `nope ${s}` }),
  },
  {
    mode: "too short",
    code: "too_small",
    run: (s) =>
      loadApiConfig({ ...devApiEnv, S3_SECRET_ACCESS_KEY: s.slice(0, 12) }),
  },
  {
    mode: "enum mismatch",
    code: "invalid_value",
    run: (s) => loadApiConfig({ ...devApiEnv, NODE_ENV: s }),
  },
  {
    mode: "out of range",
    code: "too_big",
    run: (s) => loadApiConfig({ ...devApiEnv, API_PORT: s }),
  },
  {
    mode: "bad origin",
    code: "invalid_format",
    run: (s) =>
      loadApiConfig({
        ...devApiEnv,
        CORS_ORIGINS: `https://${s}.example/path`,
      }),
  },
  {
    mode: "production dev-only value",
    code: "dev_only_value_in_production",
    run: (s) =>
      loadApiConfig({ ...prodApiEnv, S3_SECRET_ACCESS_KEY: `dev-only-${s}` }),
  },
  {
    mode: "production bricx-dev value",
    code: "bricx_dev_value_in_production",
    run: (s) => loadApiConfig({ ...prodApiEnv, S3_BUCKET: `bricx-dev-${s}` }),
  },
  {
    mode: "production local cache",
    code: "local_host_in_production",
    run: (s) =>
      loadApiConfig({
        ...prodApiEnv,
        VALKEY_URL: `redis://default:${s}@127.0.0.1:6379`,
      }),
  },
  {
    mode: "production local database",
    code: "local_host_in_production",
    run: (s) =>
      loadWorkerConfig({
        ...devWorkerEnv,
        ...prodApiEnv,
        DATABASE_URL: `postgres://bricx_app:${s}@localhost:5432/bricx`,
      }),
  },
];

const sentinels: Record<string, string> = {
  // Numeric so it reaches the range check; unique enough to never occur by chance.
  "out of range": "987654321",
  // Lower case: S3 bucket names allow only lower case.
  "production bricx-dev value": "sntbdvq7x9z2kv",
};
const sentinelFor = (mode: string) =>
  sentinels[mode] ?? `snt${mode.replaceAll(/\W/g, "")}Q7x9Z2kV`.slice(0, 40);

describe("error messages never contain a value", () => {
  it.each(sentinelCases)(
    "$mode: reports $code without the value",
    ({ mode, code, run }) => {
      const sentinel = sentinelFor(mode);
      const error = errorFrom(() => run(sentinel));
      expect(error.problems.map((p) => p.code)).toContain(code);
      for (const rendering of renderings(error)) {
        expect(rendering).not.toContain(sentinel);
      }
      // Shorter fragments too: a partial echo is still a leak.
      for (const rendering of renderings(error)) {
        expect(rendering).not.toContain(sentinel.slice(0, 8));
      }
    },
  );

  it("carries no cause, no zod error and no input", () => {
    const error = errorFrom(() =>
      loadApiConfig({ ...devApiEnv, NODE_ENV: "nope" }),
    );
    expect(error.cause).toBeUndefined();
    expect(Object.keys(error).sort()).toEqual(["app", "problems"]);
    for (const problem of error.problems) {
      expect(Object.keys(problem).sort()).toEqual(["code", "key"]);
    }
  });
});

describe("Secret", () => {
  const value = "sntSecretValueX81kQ";
  const secret = new Secret(value);

  it("reveals the value only through reveal()", () => {
    expect(secret.reveal()).toBe(value);
    expect(String(secret)).toBe("[redacted]");
    expect([secret].join("")).toBe("[redacted]");
    expect(secret.toString()).toBe("[redacted]");
    expect(JSON.stringify(secret)).toBe('"[redacted]"');
    expect(inspect(secret)).toBe("[redacted]");
    expect(Object.keys(secret)).toEqual([]);
    expect(Object.isFrozen(secret)).toBe(true);
    for (const rendering of renderings(secret)) {
      expect(rendering).not.toContain(value);
    }
    expect(JSON.stringify(structuredClone(secret))).not.toContain(value);
  });

  it("wraps DATABASE_URL, VALKEY_URL and S3_SECRET_ACCESS_KEY", () => {
    const config = loadApiConfig(devApiEnv);
    expect(config.database.url).toBeInstanceOf(Secret);
    expect(config.valkey.url).toBeInstanceOf(Secret);
    expect(config.s3.secretAccessKey).toBeInstanceOf(Secret);
    expect(config.valkey.url.reveal()).toBe(devApiEnv.VALKEY_URL);
    expect(config.s3.secretAccessKey.reveal()).toBe(
      devApiEnv.S3_SECRET_ACCESS_KEY,
    );
  });
});

describe("logging the whole config leaks nothing", () => {
  const secrets = [
    devApiEnv.DATABASE_URL,
    "test-password-123",
    devApiEnv.VALKEY_URL,
    "test-password-456",
    devApiEnv.S3_SECRET_ACCESS_KEY,
  ];

  it.each([
    ["api", () => loadApiConfig(devApiEnv)],
    ["worker", () => loadWorkerConfig(devWorkerEnv)],
  ])("%s", (_app, load) => {
    const config = load();
    const logged: string[] = [];
    const spy = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => {
        logged.push(format(...args));
      });
    try {
      console.log(config);
      console.log("%o", config);
      console.log(JSON.stringify(config));
    } finally {
      spy.mockRestore();
    }
    expect(logged).toHaveLength(3);
    for (const line of logged) expect(line).toContain("[redacted]");
    for (const rendering of [...logged, ...renderings(config)]) {
      for (const secret of secrets) expect(rendering).not.toContain(secret);
    }
  });
});
