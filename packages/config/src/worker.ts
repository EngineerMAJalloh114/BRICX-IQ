// Worker config (P2-03, ADR 0039): the shared server keys, plus the outbox
// relay's (P4-06, ADR 0056): RELAY_DATABASE_URL (bricx_relay, read by the
// worker only; the api's key list is tested not to hold it) and
// OUTBOX_DEAD_LETTER_AFTER. Later tasks add worker keys here (SMTP at P12,
// ClamAV at P8).
import { z } from "zod";
import {
  type EnvSource,
  deepFreeze,
  parseOrThrow,
  readDeclared,
} from "./load.js";
import { Secret } from "./secret.js";
import { productionProblems, serverConfig, serverShape } from "./shared.js";

export { ConfigError, type ConfigProblem, type EnvSource } from "./load.js";
export { Secret } from "./secret.js";

/** Row failures before the relay dead-letters a row, when unset. */
export const DEFAULT_DEAD_LETTER_AFTER = 10;

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
};

export const workerKeys: readonly string[] = Object.freeze(
  Object.keys(workerShape),
);

export type WorkerConfig = Readonly<
  ReturnType<typeof serverConfig> & {
    relayDatabase: { readonly url: Secret };
    outbox: { readonly deadLetterAfter: number };
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
  const parsed = parseOrThrow(
    "worker",
    workerShape,
    raw,
    productionProblems(raw),
  );
  return deepFreeze({
    ...serverConfig(parsed),
    relayDatabase: { url: new Secret(parsed.RELAY_DATABASE_URL) },
    outbox: {
      deadLetterAfter:
        parsed.OUTBOX_DEAD_LETTER_AFTER ?? DEFAULT_DEAD_LETTER_AFTER,
    },
  });
}
