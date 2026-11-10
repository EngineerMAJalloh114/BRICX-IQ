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
  cellId,
  issuerProblems,
  keycloakIssuer,
  productionProblems,
  serverConfig,
  serverShape,
} from "./shared.js";
import {
  RATE_LIMIT_CLASSES,
  RATE_LIMIT_DEFAULTS,
  type RateLimit,
  type RateLimitClass,
  type RateLimits,
  type TrustProxy,
  parseRateLimit,
  parseTrustProxy,
} from "./rate-limits.js";
import { Secret } from "./secret.js";

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

/** Most non-revoked devices one user may register (P5-03 review fix 2). */
export const DEFAULT_MAX_DEVICES_PER_USER = 20;

/** Most open temporary elevations one user may hold per organisation (P5-06, ADR 0067). */
export const DEFAULT_MAX_ACCESS_GRANTS_PER_USER = 20;

/** The longest temporary elevation, in seconds (P5-06, D-C: 24 h). */
export const DEFAULT_ACCESS_GRANT_MAX_SECONDS = 86_400;

/** Most organisations one user may create, archived ones counted (P6-02, D1). */
export const DEFAULT_ORGS_MAX_CREATED_PER_USER = 5;

/** Resends one invitation allows; the next is 409 (P6-06, ADR 0077, D11). */
export const DEFAULT_INVITATION_MAX_RESENDS = 5;
export const MAX_INVITATION_MAX_RESENDS = 20;

const TRUST_PROXY_OFF: TrustProxy = Object.freeze({ mode: "off" });

/** TRUST_PROXY: off, hops:N or a CIDR list (rate-limits.ts). */
const trustProxyValue = () =>
  z
    .string()
    .refine((text) => parseTrustProxy(text) !== undefined, {
      error: "",
      abort: true,
    })
    .transform((text) => parseTrustProxy(text) ?? TRUST_PROXY_OFF)
    .optional();

/** RATE_LIMIT_<CLASS>: "ip=N,user=N,org=N,window=S" (rate-limits.ts). */
const rateLimitValue = (cls: RateLimitClass) =>
  z
    .string()
    .refine((text) => parseRateLimit(text) !== undefined, {
      error: "",
      abort: true,
    })
    .transform((text) => parseRateLimit(text) ?? RATE_LIMIT_DEFAULTS[cls])
    .optional();

export const OPENAPI_EXPOSURES = ["public", "authenticated", "off"] as const;
export type OpenApiExposure = (typeof OPENAPI_EXPOSURES)[number];

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
  // The realm whose tokens the guard trusts (rule shared with the worker).
  KEYCLOAK_ISSUER: keycloakIssuer(),
  OPENAPI_EXPOSURE: z.enum(OPENAPI_EXPOSURES).optional(),
  USERS_LAST_SEEN_THROTTLE_SECONDS: z
    .string()
    .regex(/^\d{1,5}$/)
    .transform(Number)
    .pipe(z.number().int().min(0).max(86_400))
    .optional(),
  DEVICES_MAX_PER_USER: z
    .string()
    .regex(/^\d{1,4}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(1_000))
    .optional(),
  ACCESS_GRANTS_MAX_PER_USER: z
    .string()
    .regex(/^\d{1,4}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(1_000))
    .optional(),
  // 60 s to 30 days (the table's CHECK on one grant's window says the same).
  ACCESS_GRANT_MAX_SECONDS: z
    .string()
    .regex(/^\d{1,7}$/)
    .transform(Number)
    .pipe(z.number().int().min(60).max(2_592_000))
    .optional(),
  // directory_reader on bricx_directory (P6-01, ADR 0071). Optional: set
  // only on the global deployment, which then serves GET /v1/directory/resolve.
  DIRECTORY_DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }).optional(),
  // P6-02 (ADR 0072, D2): the cell this API serves (directory.cells' id
  // shape); every organisation it creates records it as data_region.
  CELL_ID: cellId(),
  // directory_writer on bricx_directory (D3). Optional: absent, POST
  // /v1/organizations answers 503 server_unavailable.
  DIRECTORY_WRITER_DATABASE_URL: z
    .url({ protocol: /^postgres(?:ql)?$/ })
    .optional(),
  // The per-user create cap (D1, D13: pending and committed attempts).
  ORGS_MAX_CREATED_PER_USER: z
    .string()
    .regex(/^\d{1,4}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(1_000))
    .optional(),
  // P6-05d (ADR 0080): the proxies whose X-Forwarded-For is believed
  // (required in production), and one optional override per limit class.
  TRUST_PROXY: trustProxyValue(),
  RATE_LIMIT_DEFAULT: rateLimitValue("default"),
  RATE_LIMIT_AUTH_ADJACENT: rateLimitValue("auth_adjacent"),
  RATE_LIMIT_INVITATION: rateLimitValue("invitation"),
  RATE_LIMIT_UPLOAD: rateLimitValue("upload"),
  RATE_LIMIT_EXPORT: rateLimitValue("export"),
  // P6-06 (ADR 0077, D11): resends per invitation (1-20; unset: 5).
  INVITATION_MAX_RESENDS: z
    .string()
    .regex(/^\d{1,2}$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(MAX_INVITATION_MAX_RESENDS))
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
  problems.push(...issuerProblems(raw));
  if (raw.NODE_ENV === "production") {
    if (raw.OPENAPI_EXPOSURE === "public") {
      problems.push({
        key: "OPENAPI_EXPOSURE",
        code: "public_in_production",
      });
    }
    // Without it every client shares the load balancer's address
    // (P6-05d, ADR 0080).
    if (raw.TRUST_PROXY === undefined || raw.TRUST_PROXY === "off") {
      problems.push({ key: "TRUST_PROXY", code: "required_in_production" });
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
      /**
       * The realm's userinfo endpoint (P6-06, owner condition C3): derived
       * from KEYCLOAK_ISSUER only, never from a token or a request.
       */
      readonly userinfoUrl: string;
      readonly lastSeenThrottleSeconds: number;
    };
    devices: {
      /** Non-revoked devices one user may hold; the next registration is 409. */
      readonly maxPerUser: number;
    };
    accessGrants: {
      /** Open temporary elevations one user may hold per organisation; the next grant is 409. */
      readonly maxPerUser: number;
      /** The longest elevation window, in seconds. */
      readonly maxSeconds: number;
    };
    openApiExposure: OpenApiExposure;
    /** The global directory (P6-01, ADR 0071); absent in a cell deployment. */
    directory: { readonly url: Secret } | undefined;
    /** This cell's id (P6-02, ADR 0072). */
    cellId: string;
    /** directory_writer (P6-02); absent, organisations cannot be created. */
    directoryWriter: { readonly url: Secret } | undefined;
    organizations: {
      /** Organisations one user may create; the next create is 409. */
      readonly maxCreatedPerUser: number;
    };
    /** The proxies whose X-Forwarded-For is believed (P6-05d, ADR 0080). */
    trustProxy: TrustProxy;
    /** Every limit class's limits: the defaults, each overridable. */
    rateLimits: RateLimits;
    invitations: {
      /** Resends one invitation allows; the next is 409 invitation.resend_limit. */
      readonly maxResends: number;
    };
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
      userinfoUrl: `${parsed.KEYCLOAK_ISSUER}/protocol/openid-connect/userinfo`,
      lastSeenThrottleSeconds:
        parsed.USERS_LAST_SEEN_THROTTLE_SECONDS ??
        DEFAULT_LAST_SEEN_THROTTLE_SECONDS,
    },
    devices: {
      maxPerUser: parsed.DEVICES_MAX_PER_USER ?? DEFAULT_MAX_DEVICES_PER_USER,
    },
    accessGrants: {
      maxPerUser:
        parsed.ACCESS_GRANTS_MAX_PER_USER ?? DEFAULT_MAX_ACCESS_GRANTS_PER_USER,
      maxSeconds:
        parsed.ACCESS_GRANT_MAX_SECONDS ?? DEFAULT_ACCESS_GRANT_MAX_SECONDS,
    },
    openApiExposure:
      parsed.OPENAPI_EXPOSURE ??
      (parsed.NODE_ENV === "production" ? "off" : "public"),
    directory:
      parsed.DIRECTORY_DATABASE_URL === undefined
        ? undefined
        : { url: new Secret(parsed.DIRECTORY_DATABASE_URL) },
    cellId: parsed.CELL_ID,
    directoryWriter:
      parsed.DIRECTORY_WRITER_DATABASE_URL === undefined
        ? undefined
        : { url: new Secret(parsed.DIRECTORY_WRITER_DATABASE_URL) },
    organizations: {
      maxCreatedPerUser:
        parsed.ORGS_MAX_CREATED_PER_USER ?? DEFAULT_ORGS_MAX_CREATED_PER_USER,
    },
    trustProxy: parsed.TRUST_PROXY ?? TRUST_PROXY_OFF,
    rateLimits: rateLimitsOf({
      default: parsed.RATE_LIMIT_DEFAULT,
      auth_adjacent: parsed.RATE_LIMIT_AUTH_ADJACENT,
      invitation: parsed.RATE_LIMIT_INVITATION,
      upload: parsed.RATE_LIMIT_UPLOAD,
      export: parsed.RATE_LIMIT_EXPORT,
    }),
    invitations: {
      maxResends:
        parsed.INVITATION_MAX_RESENDS ?? DEFAULT_INVITATION_MAX_RESENDS,
    },
  });
}

/** The defaults with each class's override applied. */
function rateLimitsOf(
  overrides: Readonly<Record<RateLimitClass, RateLimit | undefined>>,
): RateLimits {
  const out = {} as Record<RateLimitClass, RateLimit>;
  for (const cls of RATE_LIMIT_CLASSES) {
    out[cls] = overrides[cls] ?? RATE_LIMIT_DEFAULTS[cls];
  }
  return out;
}
