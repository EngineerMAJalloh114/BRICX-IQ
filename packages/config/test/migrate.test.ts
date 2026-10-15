// Migration config (P4-02, ADR 0052): the bricx_owner URL lives only here,
// so the api and worker never read it.
import { describe, expect, it } from "vitest";
import { apiKeys } from "../src/api.js";
import {
  ConfigError,
  Secret,
  loadMigrateConfig,
  migrateKeys,
} from "../src/migrate.js";
import { workerKeys } from "../src/worker.js";

const devMigrateEnv = {
  NODE_ENV: "development",
  MIGRATION_DATABASE_URL:
    "postgres://bricx_owner:test-password-123@127.0.0.1:5432/bricx_dev",
} as const;

const prodMigrateEnv = {
  NODE_ENV: "production",
  MIGRATION_DATABASE_URL:
    "postgres://bricx_owner:prod-password-789@db.internal.example:5432/bricx",
} as const;

function problemsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems.map((p) => `${p.key}:${p.code}`);
  }
  return [];
}

describe("loadMigrateConfig", () => {
  it("declares exactly NODE_ENV and MIGRATION_DATABASE_URL", () => {
    expect([...migrateKeys]).toEqual(["NODE_ENV", "MIGRATION_DATABASE_URL"]);
  });

  it("reads only its declared keys", () => {
    const read: string[] = [];
    const env = new Proxy(
      { ...devMigrateEnv, DATABASE_URL: "postgres://x@y/z" },
      {
        get(target, key, receiver) {
          if (typeof key === "string") read.push(key);
          return Reflect.get(target, key, receiver) as unknown;
        },
        ownKeys() {
          throw new Error("the loader must not enumerate the environment");
        },
      },
    );
    loadMigrateConfig(env);
    expect(read.sort()).toEqual(["MIGRATION_DATABASE_URL", "NODE_ENV"]);
  });

  it("returns a frozen config with the URL as a Secret", () => {
    const config = loadMigrateConfig(devMigrateEnv);
    expect(config.nodeEnv).toBe("development");
    expect(config.migrationDatabase.url).toBeInstanceOf(Secret);
    expect(config.migrationDatabase.url.reveal()).toBe(
      devMigrateEnv.MIGRATION_DATABASE_URL,
    );
    expect(JSON.stringify(config)).not.toContain("test-password-123");
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.migrationDatabase)).toBe(true);
  });

  it("a missing or empty URL is reported by key only", () => {
    expect(
      problemsOf(() => loadMigrateConfig({ NODE_ENV: "development" })),
    ).toEqual(["MIGRATION_DATABASE_URL:missing"]);
    expect(
      problemsOf(() =>
        loadMigrateConfig({ ...devMigrateEnv, MIGRATION_DATABASE_URL: "" }),
      ),
    ).toEqual(["MIGRATION_DATABASE_URL:missing"]);
  });

  it("rejects a non-postgres URL without echoing it", () => {
    const value = "mysql://bricx_owner:secret-value-42@127.0.0.1/bricx";
    let message = "";
    try {
      loadMigrateConfig({ ...devMigrateEnv, MIGRATION_DATABASE_URL: value });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("MIGRATION_DATABASE_URL");
    expect(message).not.toContain("secret-value-42");
  });

  it("accepts a clean production environment", () => {
    expect(problemsOf(() => loadMigrateConfig(prodMigrateEnv))).toEqual([]);
  });

  it("production rejects a dev-only value and a local host", () => {
    expect(
      problemsOf(() =>
        loadMigrateConfig({
          ...prodMigrateEnv,
          MIGRATION_DATABASE_URL:
            "postgres://bricx_owner:dev-only-pw@db.internal.example/bricx",
        }),
      ),
    ).toEqual(["MIGRATION_DATABASE_URL:dev_only_value_in_production"]);
    expect(
      problemsOf(() =>
        loadMigrateConfig({
          ...prodMigrateEnv,
          MIGRATION_DATABASE_URL:
            "postgres://bricx_owner:pw-0123456789@127.0.0.1:5432/bricx",
        }),
      ),
    ).toEqual(["MIGRATION_DATABASE_URL:local_host_in_production"]);
  });
});

describe("the owner URL stays out of the api and the worker", () => {
  it("api and worker keys never include MIGRATION_DATABASE_URL", () => {
    expect(apiKeys).not.toContain("MIGRATION_DATABASE_URL");
    expect(workerKeys).not.toContain("MIGRATION_DATABASE_URL");
  });
});
