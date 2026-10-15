// Migration config (P4-02, ADR 0052): the bricx_owner URL for `pnpm
// db:migrate`. Only the migrate entry point imports this file, so the api
// and worker never read MIGRATION_DATABASE_URL (their key lists are tested).
import { z } from "zod";
import {
  type EnvSource,
  deepFreeze,
  parseOrThrow,
  readDeclared,
} from "./load.js";
import { Secret } from "./secret.js";
import { productionProblems, serverShape } from "./shared.js";

export { ConfigError, type ConfigProblem, type EnvSource } from "./load.js";
export { Secret } from "./secret.js";

const migrateShape = {
  NODE_ENV: serverShape.NODE_ENV,
  // bricx_owner (owns schemas bricx and bricx_migrations; ADR 0035, 0052).
  // The migrator also refuses any other role at run time.
  MIGRATION_DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
};

const declared = ["NODE_ENV", "MIGRATION_DATABASE_URL"] as const;

export const migrateKeys: readonly string[] = Object.freeze([...declared]);

/**
 * Validates the migration environment and returns frozen config: no
 * "dev-only" value and no local host in production. Throws ConfigError
 * (keys and codes only). Never reads a file.
 */
export function loadMigrateConfig(env: EnvSource = process.env) {
  const raw = readDeclared(declared, env);
  const parsed = parseOrThrow(
    "migrate",
    migrateShape,
    raw,
    productionProblems(raw),
  );
  return deepFreeze({
    nodeEnv: parsed.NODE_ENV,
    migrationDatabase: { url: new Secret(parsed.MIGRATION_DATABASE_URL) },
  });
}

export type MigrateConfig = Readonly<ReturnType<typeof loadMigrateConfig>>;
