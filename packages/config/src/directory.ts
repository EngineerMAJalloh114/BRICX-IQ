// Directory config (P6-01, ADR 0071; owner condition C4): what the global
// directory needs and nothing else, so its DI graph can be built from this
// loader alone. DIRECTORY_DATABASE_URL is the directory_reader role on
// bricx_directory; production refuses a dev-only value and a local host.
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

const directoryShape = {
  NODE_ENV: serverShape.NODE_ENV,
  LOG_LEVEL: serverShape.LOG_LEVEL,
  DIRECTORY_DATABASE_URL: z.url({ protocol: /^postgres(?:ql)?$/ }),
};

const declared = ["NODE_ENV", "LOG_LEVEL", "DIRECTORY_DATABASE_URL"] as const;

export const directoryKeys: readonly string[] = Object.freeze([...declared]);

export interface DirectoryConfig {
  readonly nodeEnv: "development" | "test" | "production";
  readonly logLevel: z.output<typeof serverShape.LOG_LEVEL>;
  readonly directory: { readonly url: Secret };
}

/**
 * Validates the directory environment and returns frozen config. Throws
 * ConfigError (keys and codes only). Never reads a file.
 */
export function loadDirectoryConfig(
  env: EnvSource = process.env,
): DirectoryConfig {
  const raw = readDeclared(declared, env);
  const parsed = parseOrThrow(
    "directory",
    directoryShape,
    raw,
    productionProblems(raw),
  );
  return deepFreeze({
    nodeEnv: parsed.NODE_ENV,
    logLevel: parsed.LOG_LEVEL,
    directory: { url: new Secret(parsed.DIRECTORY_DATABASE_URL) },
  });
}
