// Seed config (P6-05b, ADR 0076; binding decisions C1 and E1, architect
// call 6): `pnpm db:seed` reads only NODE_ENV and DATABASE_URL (the app's
// own bricx_app URL, ADR 0039: no new key) and refuses production, a
// database host other than localhost, 127.0.0.1 or ::1, and a database
// user other than bricx_app. Problems are keys and codes only, never a
// value.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  SEED_HOSTS,
  SEED_ROLE,
  Secret,
  loadSeedConfig,
  seedKeys,
} from "../src/seed.js";

const devSeedEnv = {
  NODE_ENV: "development",
  DATABASE_URL:
    "postgres://bricx_app:test-password-123@127.0.0.1:5432/bricx_dev",
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

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return (error as Error).message;
  }
  return "";
}

describe("loadSeedConfig", () => {
  it("declares exactly NODE_ENV and DATABASE_URL", () => {
    expect([...seedKeys]).toEqual(["NODE_ENV", "DATABASE_URL"]);
    expect(SEED_ROLE).toBe("bricx_app");
    expect([...SEED_HOSTS]).toEqual(["localhost", "127.0.0.1", "[::1]"]);
  });

  it("reads only its declared keys and never enumerates the environment", () => {
    const read: string[] = [];
    const env = new Proxy(
      {
        ...devSeedEnv,
        MIGRATION_DATABASE_URL: "postgres://bricx_owner:x@127.0.0.1/z",
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
    loadSeedConfig(env);
    expect(read.sort()).toEqual(["DATABASE_URL", "NODE_ENV"]);
  });

  it("returns a frozen config with the URL as a Secret", () => {
    const config = loadSeedConfig(devSeedEnv);
    expect(config.nodeEnv).toBe("development");
    expect(config.database.url).toBeInstanceOf(Secret);
    expect(config.database.url.reveal()).toBe(devSeedEnv.DATABASE_URL);
    expect(JSON.stringify(config)).not.toContain("test-password-123");
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  it("accepts the test environment and each local host", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "LOCALHOST"]) {
      expect(
        problemsOf(() =>
          loadSeedConfig({
            NODE_ENV: "test",
            DATABASE_URL: `postgres://bricx_app:pw-1@${host}:5432/bricx_dev`,
          }),
        ),
      ).toEqual([]);
    }
  });

  it("refuses production, whatever the URL", () => {
    expect(
      problemsOf(() =>
        loadSeedConfig({ ...devSeedEnv, NODE_ENV: "production" }),
      ),
    ).toEqual(["NODE_ENV:seed_refused_in_production"]);
  });

  it("refuses a missing NODE_ENV or DATABASE_URL by key", () => {
    expect(
      problemsOf(() =>
        loadSeedConfig({ DATABASE_URL: devSeedEnv.DATABASE_URL }),
      ),
    ).toEqual(["NODE_ENV:missing"]);
    expect(
      problemsOf(() => loadSeedConfig({ ...devSeedEnv, DATABASE_URL: "" })),
    ).toEqual(["DATABASE_URL:missing"]);
  });

  it("refuses a database host that is not local, naming no value", () => {
    for (const host of [
      "db.internal.example",
      "10.0.0.5",
      "127.0.0.2",
      "postgres",
      "localhost.example",
      "0.0.0.0",
    ]) {
      const env = {
        ...devSeedEnv,
        DATABASE_URL: `postgres://bricx_app:secret-value-42@${host}:5432/bricx_dev`,
      };
      expect(problemsOf(() => loadSeedConfig(env))).toEqual([
        "DATABASE_URL:seed_non_local_host",
      ]);
      const message = messageOf(() => loadSeedConfig(env));
      expect(message).toContain("DATABASE_URL");
      expect(message).not.toContain("secret-value-42");
      expect(message).not.toContain(host);
    }
  });

  it("refuses a database user other than bricx_app (C1)", () => {
    for (const user of [
      "bricx_owner",
      "bricx_relay",
      "postgres",
      "BRICX_APP",
    ]) {
      const env = {
        ...devSeedEnv,
        DATABASE_URL: `postgres://${user}:secret-value-42@127.0.0.1:5432/bricx_dev`,
      };
      expect(problemsOf(() => loadSeedConfig(env))).toEqual([
        "DATABASE_URL:seed_role_not_bricx_app",
      ]);
      expect(messageOf(() => loadSeedConfig(env))).not.toContain(
        "secret-value-42",
      );
    }
  });

  it("judges the host and user pg will use: query-string host= and user= count (condition 3)", () => {
    const cases: [string, string[]][] = [
      // pg takes ?host= over the URL's host, and ?user= over its user.
      [
        "postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=db.internal.example",
        ["DATABASE_URL:seed_non_local_host"],
      ],
      [
        "postgres://bricx_app:pw-1@db.internal.example/bricx_dev?host=127.0.0.1",
        ["DATABASE_URL:seed_non_local_host"],
      ],
      ["postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=localhost", []],
      [
        "postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=localhost&host=db.internal.example",
        ["DATABASE_URL:seed_non_local_host"],
      ],
      [
        "postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?user=bricx_owner",
        ["DATABASE_URL:seed_role_not_bricx_app"],
      ],
      [
        "postgres://bricx_owner:pw-1@127.0.0.1/bricx_dev?user=bricx_app",
        ["DATABASE_URL:seed_role_not_bricx_app"],
      ],
      ["postgres://bricx_app:pw-1@[::1]:5432/bricx_dev", []],
      ["postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=::1", []],
      ["postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=[::1]", []],
    ];
    for (const [url, expected] of cases) {
      expect(
        problemsOf(() => loadSeedConfig({ ...devSeedEnv, DATABASE_URL: url })),
        url,
      ).toEqual(expected);
    }
  });

  it("refuses a unix socket or a missing host (condition 3)", () => {
    for (const url of [
      "postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=/var/run/postgresql",
      "postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=%2Fvar%2Frun%2Fpostgresql",
      "postgres://bricx_app:pw-1@%2Fvar%2Frun%2Fpostgresql/bricx_dev",
      "postgresql://bricx_app:pw-1@/bricx_dev",
      "postgres://bricx_app:pw-1@127.0.0.1/bricx_dev?host=",
    ]) {
      expect(
        problemsOf(() => loadSeedConfig({ ...devSeedEnv, DATABASE_URL: url })),
        url,
      ).toEqual(["DATABASE_URL:seed_non_local_host"]);
    }
  });

  it("refuses an unset or empty NODE_ENV and any value but development or test (condition 3)", () => {
    expect(
      problemsOf(() =>
        loadSeedConfig({ DATABASE_URL: devSeedEnv.DATABASE_URL }),
      ),
    ).toEqual(["NODE_ENV:missing"]);
    expect(
      problemsOf(() => loadSeedConfig({ ...devSeedEnv, NODE_ENV: "" })),
    ).toEqual(["NODE_ENV:missing"]);
    expect(
      problemsOf(() => loadSeedConfig({ ...devSeedEnv, NODE_ENV: "staging" })),
    ).toEqual(["NODE_ENV:invalid_value"]);
  });

  it("accepts .env.example, which carries NODE_ENV=development (condition 3)", () => {
    const example = parseEnv(
      readFileSync(
        path.join(import.meta.dirname, "../../../.env.example"),
        "utf8",
      ),
    );
    expect(example["NODE_ENV"]).toBe("development");
    expect(problemsOf(() => loadSeedConfig(example))).toEqual([]);
  });

  it("reports every problem at once", () => {
    expect(
      problemsOf(() =>
        loadSeedConfig({
          NODE_ENV: "production",
          DATABASE_URL: "postgres://bricx_owner:pw@db.internal.example/bricx",
        }),
      ),
    ).toEqual([
      "NODE_ENV:seed_refused_in_production",
      "DATABASE_URL:seed_non_local_host",
      "DATABASE_URL:seed_role_not_bricx_app",
    ]);
  });

  it("refuses a non-postgres URL without echoing it", () => {
    const value = "mysql://bricx_app:secret-value-42@127.0.0.1/bricx";
    const env = { ...devSeedEnv, DATABASE_URL: value };
    expect(problemsOf(() => loadSeedConfig(env))).toEqual([
      "DATABASE_URL:invalid_format",
    ]);
    expect(messageOf(() => loadSeedConfig(env))).not.toContain(
      "secret-value-42",
    );
  });
});
