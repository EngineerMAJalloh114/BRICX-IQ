// P6-01 (ADR 0071; owner condition C4): the global directory's config.
// - @bricx/config/directory reads NODE_ENV, LOG_LEVEL and
//   DIRECTORY_DATABASE_URL (directory_reader) and nothing else, so the
//   directory module's DI graph can be built from it alone;
// - the API reads DIRECTORY_DATABASE_URL as an optional key: absent, the
//   API has no directory route (a cell deployment);
// - the migrator reads DIRECTORY_MIGRATION_DATABASE_URL (directory_owner)
//   as an optional key;
// - the client's public config carries EXPO_PUBLIC_DIRECTORY_URL;
// - production refuses a dev-only value and a local database host in the
//   new URL keys.
import { describe, expect, it } from "vitest";
import { apiKeys, loadApiConfig } from "../src/api.js";
import {
  clientPublicKeys,
  loadClientPublicConfig,
} from "../src/client-public.js";
import {
  ConfigError,
  Secret,
  directoryKeys,
  loadDirectoryConfig,
} from "../src/directory.js";
import { loadMigrateConfig, migrateKeys } from "../src/migrate.js";
import { workerKeys } from "../src/worker.js";
import { devApiEnv } from "./env.js";

const DIRECTORY_URL =
  "postgres://directory_reader:test-password-123@127.0.0.1:5432/bricx_directory";
const PROD_DIRECTORY_URL =
  "postgres://directory_reader:prod-password-789@directory.internal.example:5432/bricx_directory";

function problemsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems.map((p) => `${p.key}:${p.code}`);
  }
  return [];
}

describe("loadDirectoryConfig (C4)", () => {
  it("declares exactly NODE_ENV, LOG_LEVEL and DIRECTORY_DATABASE_URL", () => {
    expect([...directoryKeys]).toEqual([
      "NODE_ENV",
      "LOG_LEVEL",
      "DIRECTORY_DATABASE_URL",
    ]);
  });

  it("builds from the directory environment alone and reads nothing else", () => {
    const read: string[] = [];
    const env = new Proxy(
      {
        NODE_ENV: "development",
        LOG_LEVEL: "info",
        DIRECTORY_DATABASE_URL: DIRECTORY_URL,
        DATABASE_URL: "postgres://bricx_app:x@127.0.0.1:5432/bricx_dev",
      },
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
    const config = loadDirectoryConfig(env);
    expect(config.nodeEnv).toBe("development");
    expect(config.logLevel).toBe("info");
    expect(config.directory.url).toBeInstanceOf(Secret);
    expect(config.directory.url.reveal()).toBe(DIRECTORY_URL);
    expect(JSON.stringify(config)).not.toContain("test-password-123");
    expect([...new Set(read)].sort()).toEqual([...directoryKeys].sort());
    expect(Object.isFrozen(config)).toBe(true);
  });

  it("requires DIRECTORY_DATABASE_URL, a postgres URL", () => {
    expect(
      problemsOf(() =>
        loadDirectoryConfig({ NODE_ENV: "development", LOG_LEVEL: "info" }),
      ),
    ).toEqual(["DIRECTORY_DATABASE_URL:missing"]);
    expect(
      problemsOf(() =>
        loadDirectoryConfig({
          NODE_ENV: "development",
          LOG_LEVEL: "info",
          DIRECTORY_DATABASE_URL: "https://directory.example",
        }),
      ),
    ).toEqual(["DIRECTORY_DATABASE_URL:invalid_format"]);
  });

  it("production refuses a dev-only value and a local host", () => {
    expect(
      problemsOf(() =>
        loadDirectoryConfig({
          NODE_ENV: "production",
          LOG_LEVEL: "info",
          DIRECTORY_DATABASE_URL: PROD_DIRECTORY_URL,
        }),
      ),
    ).toEqual([]);
    expect(
      problemsOf(() =>
        loadDirectoryConfig({
          NODE_ENV: "production",
          LOG_LEVEL: "info",
          DIRECTORY_DATABASE_URL:
            "postgres://directory_reader:dev-only-x@db.example:5432/bricx_directory",
        }),
      ),
    ).toEqual(["DIRECTORY_DATABASE_URL:dev_only_value_in_production"]);
    expect(
      problemsOf(() =>
        loadDirectoryConfig({
          NODE_ENV: "production",
          LOG_LEVEL: "info",
          DIRECTORY_DATABASE_URL:
            "postgres://directory_reader:pw-0123456789@localhost:5432/bricx_directory",
        }),
      ),
    ).toEqual(["DIRECTORY_DATABASE_URL:local_host_in_production"]);
  });
});

describe("the API's optional directory key (D3)", () => {
  it("apiKeys declares DIRECTORY_DATABASE_URL; the worker does not", () => {
    expect(apiKeys).toContain("DIRECTORY_DATABASE_URL");
    expect(workerKeys).not.toContain("DIRECTORY_DATABASE_URL");
  });

  it("absent: no directory (a cell deployment)", () => {
    expect(loadApiConfig(devApiEnv).directory).toBeUndefined();
  });

  it("set: the directory_reader URL as a Secret", () => {
    const config = loadApiConfig({
      ...devApiEnv,
      DIRECTORY_DATABASE_URL: DIRECTORY_URL,
    });
    expect(config.directory?.url).toBeInstanceOf(Secret);
    expect(config.directory?.url.reveal()).toBe(DIRECTORY_URL);
    expect(JSON.stringify(config)).not.toContain("test-password-123");
  });
});

describe("the migrator's optional directory key", () => {
  it("migrateKeys adds DIRECTORY_MIGRATION_DATABASE_URL", () => {
    expect([...migrateKeys]).toEqual([
      "NODE_ENV",
      "MIGRATION_DATABASE_URL",
      "DIRECTORY_MIGRATION_DATABASE_URL",
    ]);
  });

  it("absent: undefined; set: a Secret; production refuses a local host", () => {
    const base = {
      NODE_ENV: "development",
      MIGRATION_DATABASE_URL:
        "postgres://bricx_owner:test-password-123@127.0.0.1:5432/bricx_dev",
    };
    expect(loadMigrateConfig(base).directoryMigrationDatabase).toBeUndefined();
    const url =
      "postgres://directory_owner:test-password-456@127.0.0.1:5432/bricx_directory";
    const config = loadMigrateConfig({
      ...base,
      DIRECTORY_MIGRATION_DATABASE_URL: url,
    });
    expect(config.directoryMigrationDatabase?.url.reveal()).toBe(url);
    expect(
      problemsOf(() =>
        loadMigrateConfig({
          NODE_ENV: "production",
          MIGRATION_DATABASE_URL:
            "postgres://bricx_owner:prod-password-789@db.internal.example:5432/bricx",
          DIRECTORY_MIGRATION_DATABASE_URL:
            "postgres://directory_owner:prod-password-789@127.0.0.1:5432/bricx_directory",
        }),
      ),
    ).toEqual(["DIRECTORY_MIGRATION_DATABASE_URL:local_host_in_production"]);
  });
});

describe("the client's directory URL (D6)", () => {
  it("clientPublicKeys adds EXPO_PUBLIC_DIRECTORY_URL", () => {
    expect([...clientPublicKeys]).toEqual([
      "EXPO_PUBLIC_API_URL",
      "EXPO_PUBLIC_DIRECTORY_URL",
    ]);
  });

  it("loads it as directoryUrl; an http(s) URL is required", () => {
    expect(
      loadClientPublicConfig({
        EXPO_PUBLIC_API_URL: "http://127.0.0.1:3000",
        EXPO_PUBLIC_DIRECTORY_URL: "http://127.0.0.1:3000",
      }).directoryUrl,
    ).toBe("http://127.0.0.1:3000");
    expect(
      problemsOf(() =>
        loadClientPublicConfig({
          EXPO_PUBLIC_API_URL: "http://127.0.0.1:3000",
        }),
      ),
    ).toEqual(["EXPO_PUBLIC_DIRECTORY_URL:missing"]);
  });
});
