// Client config (P2-03, ADR 0039): EXPO_PUBLIC_* keys only, because Expo
// inlines them into the app bundle that every user downloads. No secret
// ever belongs here. This file imports only zod and the shared loader
// engine; never shared.ts, api.ts, worker.ts or secret.ts (tested).
import {
  type EnvSource,
  deepFreeze,
  httpUrl,
  parseOrThrow,
  readDeclared,
} from "./load.js";

export { ConfigError, type ConfigProblem, type EnvSource } from "./load.js";

const clientPublicShape = {
  EXPO_PUBLIC_API_URL: httpUrl(),
};

export const clientPublicKeys: readonly string[] = Object.freeze(
  Object.keys(clientPublicShape),
);

export interface ClientPublicConfig {
  readonly apiUrl: string;
}

/**
 * Validates the client's public config. `env` is required: Expo replaces
 * each EXPO_PUBLIC_* reference by name at build time, so the caller lists
 * every key explicitly (see this package's README).
 */
export function loadClientPublicConfig(env: EnvSource): ClientPublicConfig {
  const keys = Object.keys(
    clientPublicShape,
  ) as (keyof typeof clientPublicShape)[];
  const raw = readDeclared(keys, env);
  const parsed = parseOrThrow("client-public", clientPublicShape, raw);
  return deepFreeze({ apiUrl: parsed.EXPO_PUBLIC_API_URL });
}
