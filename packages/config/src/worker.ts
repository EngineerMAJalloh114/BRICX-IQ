// Worker config (P2-03, ADR 0039): the shared server keys, plus the outbox
// relay's (P4-06, ADR 0056): RELAY_DATABASE_URL (bricx_relay, read by the
// worker only; the api's key list is tested not to hold it) and
// OUTBOX_DEAD_LETTER_AFTER. P5-04 (ADR 0065): the revocation consumer's
// KEYCLOAK_ISSUER (the api's rule), KEYCLOAK_WORKER_CLIENT_SECRET (the
// bricx-worker service account, ADR 0060; read by the worker only) and
// REVOCATION_TTL_SECONDS. Later tasks add worker keys here (SMTP at P12,
// ClamAV at P8).
import { z } from "zod";
import {
  type EnvSource,
  deepFreeze,
  parseOrThrow,
  readDeclared,
} from "./load.js";
import { Secret } from "./secret.js";
import {
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
  });
}
