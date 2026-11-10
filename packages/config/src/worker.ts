// Worker config (P2-03, ADR 0039): the shared server keys, plus the outbox
// relay's (P4-06, ADR 0056): RELAY_DATABASE_URL (bricx_relay, read by the
// worker only; the api's key list is tested not to hold it) and
// OUTBOX_DEAD_LETTER_AFTER. P5-04 (ADR 0065): the revocation consumer's
// KEYCLOAK_ISSUER (the api's rule), KEYCLOAK_WORKER_CLIENT_SECRET (the
// bricx-worker service account, ADR 0060; read by the worker only) and
// REVOCATION_TTL_SECONDS. P6-06 (ADR 0077): the invitation sender's
// CELL_ID (the token's cell prefix, the API's rule), INVITE_LINK_BASE (the
// app origin the link opens), MAILPIT_URL (development only: production
// refuses it) and EMAIL_FROM. Later tasks add worker keys here (SES at
// P12, ClamAV at P8).
import { z } from "zod";
import {
  type ConfigProblem,
  type EnvSource,
  deepFreeze,
  httpUrl,
  parseOrThrow,
  readDeclared,
} from "./load.js";
import { Secret } from "./secret.js";
import {
  cellId,
  isLocalHost,
  issuerProblems,
  keycloakIssuer,
  productionProblems,
  serverConfig,
  serverShape,
} from "./shared.js";

export { ConfigError, type ConfigProblem, type EnvSource } from "./load.js";
export { Secret } from "./secret.js";

/** Row failures before the relay dead-letters a row, when unset. */
export const DEFAULT_DEAD_LETTER_AFTER = 10;

/** The realm's service-account client the worker authenticates as (ADR 0060). */
export const WORKER_CLIENT_ID = "bricx-worker";

/**
 * Revocation keys live at least as long as any access token minted before
 * the revoke: the realm's 300 s access token lifespan plus the guard's 5 s
 * clock tolerance (apps/api token-verifier CLOCK_TOLERANCE_SECONDS); the
 * default adds a margin for relay delay and clock drift.
 */
export const MIN_REVOCATION_TTL_SECONDS = 305;
export const DEFAULT_REVOCATION_TTL_SECONDS = 330;
export const MAX_REVOCATION_TTL_SECONDS = 3600;

/** The From address of invitation e-mail when EMAIL_FROM is unset (P6-06). */
export const DEFAULT_EMAIL_FROM = "no-reply@bricx.invalid";

/** An exact http(s) origin: no path, query, fragment or credentials. */
function isOriginUrl(value: string): boolean {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    url.origin === value
  );
}

/**
 * P6-06 (ADR 0077, D5): production refuses MAILPIT_URL (Mailpit is the dev
 * stack's catcher) and needs an https, remote INVITE_LINK_BASE.
 */
function invitationProblems(
  raw: Readonly<Record<string, unknown>>,
): ConfigProblem[] {
  if (raw.NODE_ENV !== "production") return [];
  const problems: ConfigProblem[] = [];
  if (raw.MAILPIT_URL !== undefined) {
    problems.push({ key: "MAILPIT_URL", code: "mailpit_in_production" });
  }
  const base = raw.INVITE_LINK_BASE;
  if (typeof base === "string" && URL.canParse(base)) {
    const url = new URL(base);
    if (url.protocol !== "https:") {
      problems.push({
        key: "INVITE_LINK_BASE",
        code: "https_required_in_production",
      });
    } else if (isLocalHost(url.hostname)) {
      problems.push({
        key: "INVITE_LINK_BASE",
        code: "local_host_in_production",
      });
    }
  }
  return problems;
}

const workerShape = {
  ...serverShape,
  // bricx_relay (ADR 0056): SELECT and the delivery columns of bricx.outbox.
  RELAY_DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
  OUTBOX_DEAD_LETTER_AFTER: z
    .string()
    .regex(/^\d+$/)
    .transform(Number)
    .pipe(z.number().int().min(1).max(100))
    .optional(),
  // The realm whose sessions the revocation consumer ends (ADR 0065).
  KEYCLOAK_ISSUER: keycloakIssuer(),
  KEYCLOAK_WORKER_CLIENT_SECRET: z.string().min(16).max(256),
  REVOCATION_TTL_SECONDS: z
    .string()
    .regex(/^\d{1,4}$/)
    .transform(Number)
    .pipe(
      z
        .number()
        .int()
        .min(MIN_REVOCATION_TTL_SECONDS)
        .max(MAX_REVOCATION_TTL_SECONDS),
    )
    .optional(),
  // P6-06 (ADR 0077): the invitation sender.
  CELL_ID: cellId(),
  INVITE_LINK_BASE: z.string().refine(isOriginUrl, { error: "", abort: true }),
  MAILPIT_URL: httpUrl().optional(),
  EMAIL_FROM: z.email().max(254).optional(),
};

export const workerKeys: readonly string[] = Object.freeze(
  Object.keys(workerShape),
);

export type WorkerConfig = Readonly<
  ReturnType<typeof serverConfig> & {
    relayDatabase: { readonly url: Secret };
    outbox: { readonly deadLetterAfter: number };
    keycloak: {
      readonly issuer: string;
      readonly workerClientId: string;
      readonly workerClientSecret: Secret;
    };
    revocation: { readonly ttlSeconds: number };
    /** This cell's id: the invitation token's prefix (P6-06). */
    cellId: string;
    invitations: {
      /** The app origin; the link is <linkBase>/invite#<token>. */
      readonly linkBase: string;
    };
    email: {
      /** Mailpit's HTTP origin (development only); absent: the Null adapter. */
      readonly mailpitUrl: string | undefined;
      readonly from: string;
    };
  }
>;

/**
 * Validates the worker's environment and returns frozen, typed config.
 * Throws ConfigError (keys and codes only) on any problem: call it first
 * thing on boot. Never reads a file; a dev entry point loads .env first.
 */
export function loadWorkerConfig(env: EnvSource = process.env): WorkerConfig {
  const keys = Object.keys(workerShape) as (keyof typeof workerShape)[];
  const raw = readDeclared(keys, env);
  const parsed = parseOrThrow("worker", workerShape, raw, [
    ...productionProblems(raw),
    ...issuerProblems(raw),
    ...invitationProblems(raw),
  ]);
  return deepFreeze({
    ...serverConfig(parsed),
    relayDatabase: { url: new Secret(parsed.RELAY_DATABASE_URL) },
    outbox: {
      deadLetterAfter:
        parsed.OUTBOX_DEAD_LETTER_AFTER ?? DEFAULT_DEAD_LETTER_AFTER,
    },
    keycloak: {
      issuer: parsed.KEYCLOAK_ISSUER,
      workerClientId: WORKER_CLIENT_ID,
      workerClientSecret: new Secret(parsed.KEYCLOAK_WORKER_CLIENT_SECRET),
    },
    revocation: {
      ttlSeconds:
        parsed.REVOCATION_TTL_SECONDS ?? DEFAULT_REVOCATION_TTL_SECONDS,
    },
    cellId: parsed.CELL_ID,
    invitations: { linkBase: parsed.INVITE_LINK_BASE },
    email: {
      mailpitUrl: parsed.MAILPIT_URL,
      from: parsed.EMAIL_FROM ?? DEFAULT_EMAIL_FROM,
    },
  });
}
