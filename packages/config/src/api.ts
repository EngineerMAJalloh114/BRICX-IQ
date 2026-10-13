// API config (P2-03, ADR 0039): the shared server keys plus the HTTP
// listener. Later tasks add API keys here (Keycloak at P5).
import { z } from "zod";
import {
  type ConfigProblem,
  type EnvSource,
  deepFreeze,
  parseOrThrow,
  readDeclared,
} from "./load.js";
import { productionProblems, serverConfig, serverShape } from "./shared.js";

export { ConfigError, type ConfigProblem, type EnvSource } from "./load.js";
export { Secret } from "./secret.js";

/**
 * One exact origin: http(s), lower-case host, no path, query, fragment or
 * credentials (the WHATWG origin must equal the text). Development and test
 * also accept origins containing "*"; production rejects them.
 */
function isOrigin(item: string): boolean {
  const candidate =
    item === "*" ? "http://wildcard.invalid" : item.replaceAll("*", "wildcard");
  if (!URL.canParse(candidate)) return false;
  const url = new URL(candidate);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === candidate
  );
}

const apiShape = {
  ...serverShape,
  API_PORT: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(65_535)),
  CORS_ORIGINS: z
    .string()
    .transform((list) => list.split(",").map((item) => item.trim()))
    .refine((items) => items.every(isOrigin), { error: "", abort: true }),
};

export const apiKeys: readonly string[] = Object.freeze(Object.keys(apiShape));

function apiProductionProblems(
  raw: Readonly<Record<string, unknown>>,
): ConfigProblem[] {
  const problems = productionProblems(raw);
  if (
    raw.NODE_ENV === "production" &&
    typeof raw.CORS_ORIGINS === "string" &&
    raw.CORS_ORIGINS.includes("*")
  ) {
    problems.push({ key: "CORS_ORIGINS", code: "wildcard_in_production" });
  }
  return problems;
}

export type ApiConfig = Readonly<
  ReturnType<typeof serverConfig> & {
    http: { readonly port: number; readonly corsOrigins: readonly string[] };
  }
>;

/**
 * Validates the API's environment and returns frozen, typed config.
 * Throws ConfigError (keys and codes only) on any problem: call it first
 * thing on boot. Never reads a file; a dev entry point loads .env first.
 */
export function loadApiConfig(env: EnvSource = process.env): ApiConfig {
  const keys = Object.keys(apiShape) as (keyof typeof apiShape)[];
  const raw = readDeclared(keys, env);
  const parsed = parseOrThrow("api", apiShape, raw, apiProductionProblems(raw));
  return deepFreeze({
    ...serverConfig(parsed),
    http: { port: parsed.API_PORT, corsOrigins: parsed.CORS_ORIGINS },
  });
}
