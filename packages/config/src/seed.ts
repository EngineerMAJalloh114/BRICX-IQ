// Seed config (P6-05b, ADR 0076; binding decisions C1 and E1, architect
// call 6): the bricx_app URL `pnpm db:seed` connects with. It reads only
// NODE_ENV and DATABASE_URL (the app's own key, ADR 0039: no new key), and
// refuses production or an unset NODE_ENV, a database host other than
// localhost, 127.0.0.1 or ::1 (unix sockets included), and a database user
// other than bricx_app, as pg will read the URL (owner condition 3). The
// seed also checks current_user at run time. Problems are keys and
// codes only (ConfigError), never a value.
import { z } from "zod";
import {
  type ConfigProblem,
  type EnvSource,
  deepFreeze,
  parseOrThrow,
  readDeclared,
} from "./load.js";
import { Secret } from "./secret.js";
import { serverShape } from "./shared.js";

export { ConfigError, type ConfigProblem, type EnvSource } from "./load.js";
export { Secret } from "./secret.js";

/** The only database user the seed connects as (ADR 0035). */
export const SEED_ROLE = "bricx_app";

/**
 * The hosts the seed accepts, as a URL spells them (an IPv6 literal in
 * brackets); compared lower-cased, since a postgres URL is not a special
 * scheme and its host is not normalised.
 */
export const SEED_HOSTS: readonly string[] = Object.freeze([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

const seedShape = {
  NODE_ENV: serverShape.NODE_ENV,
  // Checked by hand below (pg's own reading of the URL), so zod only
  // requires a non-empty string here.
  DATABASE_URL: z.string(),
};

const declared = ["NODE_ENV", "DATABASE_URL"] as const;

export const seedKeys: readonly string[] = Object.freeze([...declared]);

const POSTGRES = /^postgres(?:ql)?:$/;

/** `value` as pg parses it: an empty host gets a placeholder (pg-connection-string). */
function parseLikePg(value: string): URL | undefined {
  if (URL.canParse(value)) return new URL(value);
  const dummy = value.replace("@/", "@seed.invalid.host/");
  if (!URL.canParse(dummy)) return undefined;
  const url = new URL(dummy);
  url.hostname = "";
  return url;
}

/** A host as SEED_HOSTS spells it: lower-cased, IPv6 in brackets. */
function hostForm(host: string): string {
  const lower = host.toLowerCase();
  return lower.includes(":") && !lower.startsWith("[") ? `[${lower}]` : lower;
}

function decoded(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}

/**
 * The URL's problems, judged on what node-postgres will use (owner
 * condition 3): pg reads every query parameter into its config, so a
 * ?host= or ?user= replaces the URL's own. Every host the URL names (its
 * host and each ?host=) must be localhost, 127.0.0.1 or ::1: a unix
 * socket path, an empty host (pg would fall back to PGHOST) or any other
 * host is refused. Every user it names (its user and each ?user=) must be
 * bricx_app.
 */
function urlProblems(value: unknown): ConfigProblem[] {
  if (typeof value !== "string" || value === "") return [];
  const url = parseLikePg(value);
  if (url === undefined || !POSTGRES.test(url.protocol)) {
    return [{ key: "DATABASE_URL", code: "invalid_format" }];
  }
  const hosts = [url.hostname, ...url.searchParams.getAll("host")].map((host) =>
    decoded(host),
  );
  const users = [decoded(url.username), ...url.searchParams.getAll("user")];
  const problems: ConfigProblem[] = [];
  if (
    !hosts.every(
      (host) => host !== undefined && SEED_HOSTS.includes(hostForm(host)),
    )
  ) {
    problems.push({ key: "DATABASE_URL", code: "seed_non_local_host" });
  }
  if (!users.every((user) => user === SEED_ROLE)) {
    problems.push({ key: "DATABASE_URL", code: "seed_role_not_bricx_app" });
  }
  return problems;
}

/**
 * Validates the seed environment and returns frozen config. Throws
 * ConfigError (keys and codes only). Never reads a file.
 */
export function loadSeedConfig(env: EnvSource = process.env) {
  const raw = readDeclared(declared, env);
  const extra: ConfigProblem[] = [];
  if (raw.NODE_ENV === "production") {
    extra.push({ key: "NODE_ENV", code: "seed_refused_in_production" });
  }
  extra.push(...urlProblems(raw.DATABASE_URL));
  const parsed = parseOrThrow("seed", seedShape, raw, extra);
  return deepFreeze({
    nodeEnv: parsed.NODE_ENV,
    database: { url: new Secret(parsed.DATABASE_URL) },
  });
}

export type SeedConfig = Readonly<ReturnType<typeof loadSeedConfig>>;
