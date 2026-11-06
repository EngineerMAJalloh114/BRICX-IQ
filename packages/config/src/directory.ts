// Directory config (P6-01, ADR 0071). Stub: the tests come first.
import type { EnvSource } from "./load.js";
import type { Secret } from "./secret.js";

export { ConfigError, type ConfigProblem, type EnvSource } from "./load.js";
export { Secret } from "./secret.js";

export const directoryKeys: readonly string[] = Object.freeze([]);

export interface DirectoryConfig {
  readonly nodeEnv: string;
  readonly logLevel: string;
  readonly directory: { readonly url: Secret };
}

export function loadDirectoryConfig(env: EnvSource): DirectoryConfig {
  throw new Error(
    `loadDirectoryConfig: not implemented (${String(Object.isFrozen(env))})`,
  );
}
