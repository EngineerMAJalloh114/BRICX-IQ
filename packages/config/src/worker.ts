// Worker config (P2-03, ADR 0039): the shared server keys only. Later
// tasks add worker keys here (SMTP at P12, ClamAV at P8).
import {
  type EnvSource,
  deepFreeze,
  parseOrThrow,
  readDeclared,
} from "./load.js";
import {
  productionProblems,
  serverConfig,
  serverKeys,
  serverShape,
} from "./shared.js";

export { ConfigError, type ConfigProblem, type EnvSource } from "./load.js";
export { Secret } from "./secret.js";

export const workerKeys: readonly string[] = Object.freeze([...serverKeys]);

export type WorkerConfig = Readonly<ReturnType<typeof serverConfig>>;

/**
 * Validates the worker's environment and returns frozen, typed config.
 * Throws ConfigError (keys and codes only) on any problem: call it first
 * thing on boot. Never reads a file; a dev entry point loads .env first.
 */
export function loadWorkerConfig(env: EnvSource = process.env): WorkerConfig {
  const raw = readDeclared(serverKeys, env);
  const parsed = parseOrThrow(
    "worker",
    serverShape,
    raw,
    productionProblems(raw),
  );
  return deepFreeze(serverConfig(parsed));
}
