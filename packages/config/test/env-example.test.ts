// .env.example is the dev source of every key: each schema key is in it,
// its application section holds nothing the schemas do not declare, its
// URLs agree with the role passwords compose uses, and it loads in
// development but fails the production guards.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { ConfigError, apiKeys, loadApiConfig } from "../src/api.js";
import {
  clientPublicKeys,
  loadClientPublicConfig,
} from "../src/client-public.js";
import { loadMigrateConfig, migrateKeys } from "../src/migrate.js";
import { loadWorkerConfig, workerKeys } from "../src/worker.js";

const examplePath = path.join(import.meta.dirname, "../../../.env.example");
const text = readFileSync(examplePath, "utf8");
const example = parseEnv(text);
const SECTION = "# --- Application config (@bricx/config, P2-03) ---";

/** Keys defined after the application-config marker. */
function sectionKeys(): string[] {
  const start = text.indexOf(SECTION);
  expect(start, `.env.example needs the line "${SECTION}"`).toBeGreaterThan(-1);
  return Object.keys(parseEnv(text.slice(start)));
}

const declared = new Set<string>([
  ...apiKeys,
  ...workerKeys,
  ...clientPublicKeys,
  ...migrateKeys,
]);

function problemsOf(run: () => unknown): string[] {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems.map((p) => `${p.key}:${p.code}`);
  }
  return [];
}

describe(".env.example", () => {
  it("defines every key the schemas declare", () => {
    const missing = [...declared].filter((key) => !(key in example));
    expect(missing).toEqual([]);
  });

  it("has no orphan key in its application section", () => {
    expect(sectionKeys().filter((key) => !declared.has(key))).toEqual([]);
  });

  it("the worker's revocation keys (P5-04): the client secret is the compose value, the TTL is the default", () => {
    // The realm import and the worker read the same secret, so it lives
    // in the compose section (like S3_*), not the application section.
    expect(sectionKeys()).not.toContain("KEYCLOAK_WORKER_CLIENT_SECRET");
    expect(example.KEYCLOAK_WORKER_CLIENT_SECRET).toMatch(/^dev-only-/);
    expect(sectionKeys()).toContain("REVOCATION_TTL_SECONDS");
    expect(example.REVOCATION_TTL_SECONDS).toBe("330");
  });

  it("DATABASE_URL is bricx_app with BRICX_APP_PASSWORD", () => {
    const url = new URL(example.DATABASE_URL ?? "");
    expect(url.username).toBe("bricx_app");
    expect(decodeURIComponent(url.password)).toBe(example.BRICX_APP_PASSWORD);
    expect(url.pathname).toBe(`/${example.POSTGRES_DATABASE ?? ""}`);
  });

  it("MIGRATION_DATABASE_URL is bricx_owner with BRICX_OWNER_PASSWORD", () => {
    const url = new URL(example.MIGRATION_DATABASE_URL ?? "");
    expect(url.username).toBe("bricx_owner");
    expect(decodeURIComponent(url.password)).toBe(example.BRICX_OWNER_PASSWORD);
    expect(url.pathname).toBe(`/${example.POSTGRES_DATABASE ?? ""}`);
    expect(url.host).toBe(new URL(example.DATABASE_URL ?? "").host);
  });

  it("RELAY_DATABASE_URL is bricx_relay with BRICX_RELAY_PASSWORD (P4-06)", () => {
    const url = new URL(example.RELAY_DATABASE_URL ?? "");
    expect(url.username).toBe("bricx_relay");
    expect(decodeURIComponent(url.password)).toBe(example.BRICX_RELAY_PASSWORD);
    expect(url.pathname).toBe(`/${example.POSTGRES_DATABASE ?? ""}`);
    expect(url.host).toBe(new URL(example.DATABASE_URL ?? "").host);
  });

  it("VALKEY_URL carries VALKEY_PASSWORD", () => {
    const url = new URL(example.VALKEY_URL ?? "");
    expect(decodeURIComponent(url.password)).toBe(example.VALKEY_PASSWORD);
  });

  it("the API port and the client API URL agree", () => {
    expect(new URL(example.EXPO_PUBLIC_API_URL ?? "").port).toBe(
      example.API_PORT,
    );
  });

  it("loads in development", () => {
    expect(() => loadApiConfig(example)).not.toThrow();
    expect(() => loadWorkerConfig(example)).not.toThrow();
    expect(() => loadClientPublicConfig(example)).not.toThrow();
    expect(() => loadMigrateConfig(example)).not.toThrow();
  });

  it("fails the production guards", () => {
    let problems: string[] = [];
    try {
      loadApiConfig({ ...example, NODE_ENV: "production" });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      problems = (error as ConfigError).problems.map(
        (p) => `${p.key}:${p.code}`,
      );
    }
    expect(problems).toEqual(
      expect.arrayContaining([
        "DATABASE_URL:dev_only_value_in_production",
        "DATABASE_URL:local_host_in_production",
        "VALKEY_URL:local_host_in_production",
        "S3_ENDPOINT:local_host_in_production",
        "S3_BUCKET:bricx_dev_value_in_production",
        "S3_ACCESS_KEY_ID:bricx_dev_value_in_production",
        "S3_SECRET_ACCESS_KEY:dev_only_value_in_production",
      ]),
    );
    expect(
      problemsOf(() =>
        loadMigrateConfig({ ...example, NODE_ENV: "production" }),
      ),
    ).toEqual([
      "MIGRATION_DATABASE_URL:dev_only_value_in_production",
      "MIGRATION_DATABASE_URL:local_host_in_production",
    ]);
    expect(
      problemsOf(() =>
        loadWorkerConfig({ ...example, NODE_ENV: "production" }),
      ),
    ).toEqual(
      expect.arrayContaining([
        "RELAY_DATABASE_URL:dev_only_value_in_production",
        "RELAY_DATABASE_URL:local_host_in_production",
        "KEYCLOAK_ISSUER:https_required_in_production",
        "KEYCLOAK_WORKER_CLIENT_SECRET:dev_only_value_in_production",
      ]),
    );
    // A local OTel collector is legitimate, even in production.
    expect(problems.filter((p) => p.startsWith("OTEL_"))).toEqual([]);
  });
});
