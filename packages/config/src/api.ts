// API config (P2-03, ADR 0039): the shared server keys plus the HTTP
// listener. P5-02 (phase rulings D1 and D8, ADR 0062): the Keycloak issuer
// the token guard trusts, the /openapi.json exposure and the last_seen_at
// throttle of user provisioning.
import { z } from "zod";
import {
  type ConfigProblem,
  type EnvSource,
  deepFreeze,
  parseOrThrow,
  readDeclared,
} from "./load.js";
import {
  isLocalHost,
  productionProblems,
  serverConfig,
  serverShape,
} from "./shared.js";

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

/** The audience every access token must carry (ADR 0060: bricx-api). */
export const TOKEN_AUDIENCE = "bricx-api";

/** Seconds between two last_seen_at writes for one user (owner condition 3). */
export const DEFAULT_LAST_SEEN_THROTTLE_SECONDS = 300;

export const OPENAPI_EXPOSURES = ["public", "authenticated", "off"] as const;
export type OpenApiExposure = (typeof OPENAPI_EXPOSURES)[number];

/**
 * A Keycloak realm URL: http(s), no credentials, query or fragment, the
 * path /realms/<name> with no trailing slash, at most 255 characters.
 */
function isIssuer(value: string): boolean {
  if (value.length > 255 || !URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    /^\/realms\/[A-Za-z0-9_-]{1,64}$/.test(url.pathname) &&
    value === `${url.origin}${url.pathname}`
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
  KEYCLOAK_ISSUER: z.string().refine(isIssuer, { error: "", abort: true }),
  OPENAPI_EXPOSURE: z.enum(OPENAPI_EXPOSURES).optional(),
  USERS_LAST_SEEN_THROTTLE_SECONDS: z
    .string()
    .regex(/^\d{1,5}$/)
    .transform(Number)
    .pipe(z.number().int().min(0).max(86_400))
    .optional(),
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
  if (raw.NODE_ENV === "production") {
    const issuer = raw.KEYCLOAK_ISSUER;
    if (typeof issuer === "string" && URL.canParse(issuer)) {
      const url = new URL(issuer);
      if (url.protocol !== "https:") {
        problems.push({
          key: "KEYCLOAK_ISSUER",
          code: "https_required_in_production",
        });
      } else if (isLocalHost(url.hostname)) {
        problems.push({
          key: "KEYCLOAK_ISSUER",
          code: "local_host_in_production",
        });
      }
    }
    if (raw.OPENAPI_EXPOSURE === "public") {
      problems.push({
        key: "OPENAPI_EXPOSURE",
        code: "public_in_production",
      });
    }
  }
  return problems;
}

export type ApiConfig = Readonly<
  ReturnType<typeof serverConfig> & {
    http: { readonly port: number; readonly corsOrigins: readonly string[] };
    auth: {
      readonly issuer: string;
      readonly audience: typeof TOKEN_AUDIENCE;
      readonly jwksUrl: string;
      readonly lastSeenThrottleSeconds: number;
    };
    openApiExposure: OpenApiExposure;
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
    auth: {
      issuer: parsed.KEYCLOAK_ISSUER,
      audience: TOKEN_AUDIENCE,
      jwksUrl: `${parsed.KEYCLOAK_ISSUER}/protocol/openid-connect/certs`,
      lastSeenThrottleSeconds:
        parsed.USERS_LAST_SEEN_THROTTLE_SECONDS ??
        DEFAULT_LAST_SEEN_THROTTLE_SECONDS,
    },
    openApiExposure:
      parsed.OPENAPI_EXPOSURE ??
      (parsed.NODE_ENV === "production" ? "off" : "public"),
  });
}
