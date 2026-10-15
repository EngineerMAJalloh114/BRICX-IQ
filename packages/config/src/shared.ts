// Server keys shared by api and worker (P2-03, ADR 0039), the production
// guards, and the Secret wrapping. Never imported by client-public.ts.
import { z } from "zod";
import { type ConfigProblem, httpUrl } from "./load.js";
import { Secret } from "./secret.js";

export const serverShape = {
  NODE_ENV: z.enum(["development", "test", "production"]),
  LOG_LEVEL: z.enum([
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ]),
  // The application role, bricx_app (ADR 0035). Migrations (bricx_owner)
  // use MIGRATION_DATABASE_URL, read only by @bricx/config/migrate (P4-02).
  DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  VALKEY_URL: z.url({ protocol: /^rediss?$/ }),
  S3_ENDPOINT: httpUrl(),
  S3_REGION: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d+$/),
  S3_BUCKET: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/),
  S3_ACCESS_KEY_ID: z.string().min(16).max(128),
  S3_SECRET_ACCESS_KEY: z.string().min(16).max(256),
  OTEL_EXPORTER_OTLP_ENDPOINT: httpUrl(),
};

export type ServerKey = keyof typeof serverShape;
export const serverKeys = Object.keys(serverShape) as ServerKey[];

/** Hosts a production database must never point at. */
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)
  );
}

/**
 * URL keys whose host must not be local in production. Not
 * OTEL_EXPORTER_OTLP_ENDPOINT: a local collector sidecar is legitimate.
 */
const remoteOnlyKeys = [
  "DATABASE_URL",
  "MIGRATION_DATABASE_URL",
  "VALKEY_URL",
  "S3_ENDPOINT",
] as const;

/**
 * Production-only rules, on the raw values: no "dev-only" placeholder and
 * no "bricx-dev" dev value (the dev bucket and S3 key id) in any declared
 * key, and no local host in DATABASE_URL, MIGRATION_DATABASE_URL (P4-02),
 * VALKEY_URL or S3_ENDPOINT.
 * Nothing in development or test. Returns key + code only.
 */
export function productionProblems(
  raw: Readonly<Record<string, unknown>>,
): ConfigProblem[] {
  if (raw.NODE_ENV !== "production") return [];
  const problems: ConfigProblem[] = [];
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") continue;
    const lower = value.toLowerCase();
    if (lower.includes("dev-only")) {
      problems.push({ key, code: "dev_only_value_in_production" });
    }
    if (lower.includes("bricx-dev")) {
      problems.push({ key, code: "bricx_dev_value_in_production" });
    }
  }
  for (const key of remoteOnlyKeys) {
    const value = raw[key];
    if (
      typeof value === "string" &&
      URL.canParse(value) &&
      isLocalHost(new URL(value).hostname)
    ) {
      problems.push({ key, code: "local_host_in_production" });
    }
  }
  return problems;
}

/** The typed, secret-wrapped server config. */
export function serverConfig(
  parsed: z.output<z.ZodObject<typeof serverShape>>,
) {
  return {
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    database: { url: new Secret(parsed.DATABASE_URL) },
    valkey: { url: new Secret(parsed.VALKEY_URL) },
    s3: {
      endpoint: parsed.S3_ENDPOINT,
      region: parsed.S3_REGION,
      bucket: parsed.S3_BUCKET,
      accessKeyId: parsed.S3_ACCESS_KEY_ID,
      secretAccessKey: new Secret(parsed.S3_SECRET_ACCESS_KEY),
    },
    otel: { endpoint: parsed.OTEL_EXPORTER_OTLP_ENDPOINT },
  };
}
