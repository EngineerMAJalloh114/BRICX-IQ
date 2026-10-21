// A valid API environment for the tests: .env.example's values (the dev
// stack's only source), overridden per test where needed.
import { readFileSync } from "node:fs";
import path from "node:path";
import { envEntries } from "../../../scripts/guards.mjs";

const repoRoot = path.resolve(import.meta.dirname, "../../..");
const example = envEntries(
  readFileSync(path.join(repoRoot, ".env.example"), "utf8"),
);

export function exampleValue(key: string): string {
  const line = example.get(key);
  if (line === undefined) throw new Error(`.env.example has no ${key}`);
  return line.slice(line.indexOf("=") + 1);
}

const apiKeys = [
  "NODE_ENV",
  "LOG_LEVEL",
  "DATABASE_URL",
  "VALKEY_URL",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "API_PORT",
  "CORS_ORIGINS",
  "KEYCLOAK_ISSUER",
] as const;

/** Every API key from .env.example, with `overrides` applied. */
export function apiEnv(
  overrides: Record<string, string> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of apiKeys) env[key] = exampleValue(key);
  return { ...env, NODE_ENV: "test", ...overrides };
}
