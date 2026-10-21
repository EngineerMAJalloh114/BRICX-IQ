// P4-06 (ADR 0056): the worker reads the outbox relay's bricx_relay URL
// (a Secret, held to the production guards) and the dead-letter threshold
// (default 10). The API never reads either.
// P5-04 (ADR 0065): the revocation consumer reads the Keycloak issuer (the
// api's rules: production requires https and a remote host), the
// bricx-worker client secret (a Secret; production rejects the dev-only
// value) and REVOCATION_TTL_SECONDS (305-3600, unset 330: the realm's
// 300 s access token lifespan plus the guard's 5 s clock tolerance, with
// a margin).
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { apiKeys } from "../src/api.js";
import {
  ConfigError,
  DEFAULT_REVOCATION_TTL_SECONDS,
  MAX_REVOCATION_TTL_SECONDS,
  MIN_REVOCATION_TTL_SECONDS,
  Secret,
  WORKER_CLIENT_ID,
  loadWorkerConfig,
  workerKeys,
} from "../src/worker.js";
import { devWorkerEnv, prodWorkerEnv, without } from "./env.js";

function problemsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems.map((p) => `${p.key}:${p.code}`);
  }
  return [];
}

describe("RELAY_DATABASE_URL", () => {
  it("is a Secret holding the bricx_relay URL, never rendered", () => {
    const config = loadWorkerConfig(devWorkerEnv);
    expect(config.relayDatabase.url).toBeInstanceOf(Secret);
    expect(config.relayDatabase.url.reveal()).toBe(
      devWorkerEnv.RELAY_DATABASE_URL,
    );
    expect(JSON.stringify(config)).not.toContain("test-password-321");
    expect(Object.isFrozen(config.relayDatabase)).toBe(true);
  });

  it("missing or empty: reported by key only", () => {
    expect(
      problemsOf(() =>
        loadWorkerConfig(without(devWorkerEnv, "RELAY_DATABASE_URL")),
      ),
    ).toEqual(["RELAY_DATABASE_URL:missing"]);
    expect(
      problemsOf(() =>
        loadWorkerConfig({ ...devWorkerEnv, RELAY_DATABASE_URL: "" }),
      ),
    ).toEqual(["RELAY_DATABASE_URL:missing"]);
  });

  it("a non-postgres URL is invalid_format, without echoing it", () => {
    const value = "redis://bricx_relay:secret-value-42@127.0.0.1/0";
    let message = "";
    try {
      loadWorkerConfig({ ...devWorkerEnv, RELAY_DATABASE_URL: value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("RELAY_DATABASE_URL: invalid_format");
    expect(message).not.toContain("secret-value-42");
  });

  it("production rejects a dev-only value and a local host", () => {
    expect(problemsOf(() => loadWorkerConfig(prodWorkerEnv))).toEqual([]);
    expect(
      problemsOf(() =>
        loadWorkerConfig({
          ...prodWorkerEnv,
          RELAY_DATABASE_URL:
            "postgres://bricx_relay:dev-only-pw@db.internal.example/bricx",
        }),
      ),
    ).toEqual(["RELAY_DATABASE_URL:dev_only_value_in_production"]);
    expect(
      problemsOf(() =>
        loadWorkerConfig({
          ...prodWorkerEnv,
          RELAY_DATABASE_URL:
            "postgres://bricx_relay:pw-0123456789@localhost:5432/bricx",
        }),
      ),
    ).toEqual(["RELAY_DATABASE_URL:local_host_in_production"]);
  });
});

describe("OUTBOX_DEAD_LETTER_AFTER (condition 1)", () => {
  it("defaults to 10 when unset or empty", () => {
    expect(loadWorkerConfig(devWorkerEnv).outbox.deadLetterAfter).toBe(10);
    expect(
      loadWorkerConfig({ ...devWorkerEnv, OUTBOX_DEAD_LETTER_AFTER: "" }).outbox
        .deadLetterAfter,
    ).toBe(10);
  });

  it.each([
    ["1", 1],
    ["10", 10],
    ["100", 100],
  ])("accepts %s", (value, n) => {
    expect(
      loadWorkerConfig({ ...devWorkerEnv, OUTBOX_DEAD_LETTER_AFTER: value })
        .outbox.deadLetterAfter,
    ).toBe(n);
  });

  it.each([
    ["0", "too_small"],
    ["101", "too_big"],
    ["-1", "invalid_format"],
    ["2.5", "invalid_format"],
    ["1e1", "invalid_format"],
    [" 10", "invalid_format"],
    ["ten", "invalid_format"],
  ])("rejects %j (%s)", (value, code) => {
    expect(
      problemsOf(() =>
        loadWorkerConfig({ ...devWorkerEnv, OUTBOX_DEAD_LETTER_AFTER: value }),
      ),
    ).toEqual([`OUTBOX_DEAD_LETTER_AFTER:${code}`]);
  });
});

describe("the worker's keys", () => {
  it("are read one property each, nothing enumerated", () => {
    const read: (string | symbol)[] = [];
    const env = new Proxy(
      { ...devWorkerEnv, UNRELATED: "x" },
      {
        get(target, key, receiver) {
          read.push(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
        ownKeys() {
          throw new Error("the loader must not enumerate the environment");
        },
      },
    );
    loadWorkerConfig(env);
    expect([...new Set(read)].sort()).toEqual([...workerKeys].sort());
  });
});

describe("KEYCLOAK_ISSUER (P5-04)", () => {
  it("is declared, required, and the same rule as the api's", () => {
    expect(workerKeys).toContain("KEYCLOAK_ISSUER");
    expect(apiKeys).toContain("KEYCLOAK_ISSUER");
    expect(
      problemsOf(() =>
        loadWorkerConfig(without(devWorkerEnv, "KEYCLOAK_ISSUER")),
      ),
    ).toEqual(["KEYCLOAK_ISSUER:missing"]);
    expect(loadWorkerConfig(devWorkerEnv).keycloak.issuer).toBe(
      "http://localhost:8080/realms/bricx",
    );
  });

  it.each([
    "localhost:8080/realms/bricx",
    "http://localhost:8080/realms/bricx/",
    "http://localhost:8080/realms/bricx?x=1",
    "http://user:pw@localhost:8080/realms/bricx",
  ])("refuses %s", (value) => {
    expect(
      problemsOf(() =>
        loadWorkerConfig({ ...devWorkerEnv, KEYCLOAK_ISSUER: value }),
      ),
    ).toEqual(["KEYCLOAK_ISSUER:invalid_format"]);
  });

  it.each([
    ["http://auth.bricx.example/realms/bricx", "https_required_in_production"],
    ["https://localhost:8443/realms/bricx", "local_host_in_production"],
    ["https://127.0.0.1/realms/bricx", "local_host_in_production"],
  ])("production refuses %s (%s)", (value, code) => {
    expect(
      problemsOf(() =>
        loadWorkerConfig({ ...prodWorkerEnv, KEYCLOAK_ISSUER: value }),
      ),
    ).toEqual([`KEYCLOAK_ISSUER:${code}`]);
  });
});

describe("KEYCLOAK_WORKER_CLIENT_SECRET (P5-04)", () => {
  it("is a Secret for the fixed client id bricx-worker, never rendered", () => {
    const config = loadWorkerConfig(devWorkerEnv);
    expect(WORKER_CLIENT_ID).toBe("bricx-worker");
    expect(config.keycloak.workerClientId).toBe("bricx-worker");
    expect(config.keycloak.workerClientSecret).toBeInstanceOf(Secret);
    expect(config.keycloak.workerClientSecret.reveal()).toBe(
      "test-worker-client-secret-1",
    );
    expect(JSON.stringify(config)).not.toContain("test-worker-client-secret");
    expect(String(config.keycloak.workerClientSecret)).toBe("[redacted]");
    expect(Object.isFrozen(config.keycloak)).toBe(true);
  });

  it("the api never declares it", () => {
    expect(apiKeys).not.toContain("KEYCLOAK_WORKER_CLIENT_SECRET");
  });

  it("missing or empty: reported by key only", () => {
    expect(
      problemsOf(() =>
        loadWorkerConfig(
          without(devWorkerEnv, "KEYCLOAK_WORKER_CLIENT_SECRET"),
        ),
      ),
    ).toEqual(["KEYCLOAK_WORKER_CLIENT_SECRET:missing"]);
    expect(
      problemsOf(() =>
        loadWorkerConfig({
          ...devWorkerEnv,
          KEYCLOAK_WORKER_CLIENT_SECRET: "",
        }),
      ),
    ).toEqual(["KEYCLOAK_WORKER_CLIENT_SECRET:missing"]);
  });

  it("is 16 to 256 characters, without echoing the value", () => {
    expect(
      problemsOf(() =>
        loadWorkerConfig({
          ...devWorkerEnv,
          KEYCLOAK_WORKER_CLIENT_SECRET: "short-secret-15",
        }),
      ),
    ).toEqual(["KEYCLOAK_WORKER_CLIENT_SECRET:too_small"]);
    let message = "";
    try {
      loadWorkerConfig({
        ...devWorkerEnv,
        KEYCLOAK_WORKER_CLIENT_SECRET: `${"x".repeat(250)}leaked-257`,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("KEYCLOAK_WORKER_CLIENT_SECRET: too_big");
    expect(message).not.toContain("leaked-257");
  });

  it("production rejects the dev-only value", () => {
    expect(problemsOf(() => loadWorkerConfig(prodWorkerEnv))).toEqual([]);
    expect(
      problemsOf(() =>
        loadWorkerConfig({
          ...prodWorkerEnv,
          KEYCLOAK_WORKER_CLIENT_SECRET:
            "dev-only-keycloak-worker-client-secret",
        }),
      ),
    ).toEqual(["KEYCLOAK_WORKER_CLIENT_SECRET:dev_only_value_in_production"]);
  });
});

describe("REVOCATION_TTL_SECONDS (P5-04, plan decision 3)", () => {
  it("defaults to 330 when unset or empty", () => {
    expect(DEFAULT_REVOCATION_TTL_SECONDS).toBe(330);
    expect(loadWorkerConfig(devWorkerEnv).revocation.ttlSeconds).toBe(330);
    expect(
      loadWorkerConfig({ ...devWorkerEnv, REVOCATION_TTL_SECONDS: "" })
        .revocation.ttlSeconds,
    ).toBe(330);
  });

  it("the floor covers the realm's access token lifespan plus the guard's clock tolerance", () => {
    // infrastructure/keycloak/realm-bricx.json accessTokenLifespan (300)
    // + apps/api/src/common/auth/token-verifier.ts CLOCK_TOLERANCE_SECONDS
    // (5; apps/api's revocation test asserts the same against the
    // constant): a key must outlive every access token minted before
    // the revoke, with a 25 s default margin for relay and clock drift.
    const realm = JSON.parse(
      readFileSync(
        path.join(
          import.meta.dirname,
          "../../../infrastructure/keycloak/realm-bricx.json",
        ),
        "utf8",
      ),
    ) as { accessTokenLifespan: number };
    expect(realm.accessTokenLifespan).toBe(300);
    expect(MIN_REVOCATION_TTL_SECONDS).toBe(realm.accessTokenLifespan + 5);
    expect(DEFAULT_REVOCATION_TTL_SECONDS).toBeGreaterThanOrEqual(
      MIN_REVOCATION_TTL_SECONDS + 25,
    );
    expect(MAX_REVOCATION_TTL_SECONDS).toBe(3600);
  });

  it.each([
    ["305", 305],
    ["330", 330],
    ["3600", 3600],
  ])("accepts %s", (value, n) => {
    expect(
      loadWorkerConfig({ ...devWorkerEnv, REVOCATION_TTL_SECONDS: value })
        .revocation.ttlSeconds,
    ).toBe(n);
  });

  it.each([
    ["304", "too_small"],
    ["300", "too_small"],
    ["0", "too_small"],
    ["3601", "too_big"],
    ["-330", "invalid_format"],
    ["330.5", "invalid_format"],
    ["3e2", "invalid_format"],
    [" 330", "invalid_format"],
    ["forever", "invalid_format"],
  ])("rejects %j (%s)", (value, code) => {
    expect(
      problemsOf(() =>
        loadWorkerConfig({ ...devWorkerEnv, REVOCATION_TTL_SECONDS: value }),
      ),
    ).toEqual([`REVOCATION_TTL_SECONDS:${code}`]);
  });
});
