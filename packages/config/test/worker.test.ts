// P4-06 (ADR 0056): the worker reads the outbox relay's bricx_relay URL
// (a Secret, held to the production guards) and the dead-letter threshold
// (default 10). The API never reads either.
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  Secret,
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
