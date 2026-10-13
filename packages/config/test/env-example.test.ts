// .env.example is the dev source of every key: each schema key is in it,
// its application section holds nothing the schemas do not declare, its
// URLs agree with the role passwords compose uses, and it loads in
// development but fails the production guards.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { apiKeys, loadApiConfig } from "../src/api.js";
import {
  clientPublicKeys,
  loadClientPublicConfig,
} from "../src/client-public.js";
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
]);

describe(".env.example", () => {
  it("defines every key the schemas declare", () => {
    const missing = [...declared].filter((key) => !(key in example));
    expect(missing).toEqual([]);
  });

  it("has no orphan key in its application section", () => {
    expect(sectionKeys().filter((key) => !declared.has(key))).toEqual([]);
  });

  it("DATABASE_URL is bricx_app with BRICX_APP_PASSWORD", () => {
    const url = new URL(example.DATABASE_URL ?? "");
    expect(url.username).toBe("bricx_app");
    expect(decodeURIComponent(url.password)).toBe(example.BRICX_APP_PASSWORD);
    expect(url.pathname).toBe(`/${example.POSTGRES_DATABASE ?? ""}`);
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
  });

  it("fails the production guards", () => {
    expect(() => loadApiConfig({ ...example, NODE_ENV: "production" })).toThrow(
      /dev_only_value_in_production[\s\S]*local_host_in_production|local_host_in_production[\s\S]*dev_only_value_in_production/,
    );
  });
});
