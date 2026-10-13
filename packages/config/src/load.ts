// Shared loader engine (P2-03, ADR 0039), safe for every app including
// the client bundle: it imports only zod and holds no secret type.
//
// - Reads exactly the declared keys from the given environment, one
//   property read each; nothing else is read, enumerated or probed.
// - An empty string counts as missing.
// - Every problem is reported at once, as { key, code } only. Messages are
//   built from the key name and the code, never from zod's own messages
//   or from any input, so no value can reach a log line.
import { z } from "zod";

export type EnvSource = Readonly<Record<string, unknown>>;

/** A problem is a key and a code, nothing else (no value, no message). */
export interface ConfigProblem {
  readonly key: string;
  readonly code: string;
}

const phrases: Readonly<Record<string, string>> = {
  missing: "is not set (or is empty)",
  invalid_type: "has the wrong type",
  invalid_format: "is not in the required format",
  invalid_value: "is not one of the allowed values",
  too_small: "is below the allowed minimum (length or value)",
  too_big: "is above the allowed maximum (length or value)",
  dev_only_value_in_production:
    'contains a "dev-only" placeholder, which production never accepts',
  local_host_in_production:
    "points at a local host (localhost, loopback or 0.0.0.0) in production",
  wildcard_in_production: "contains a wildcard origin in production",
};

export class ConfigError extends Error {
  readonly app: string;
  readonly problems: readonly ConfigProblem[];

  constructor(app: string, problems: readonly ConfigProblem[]) {
    const lines = problems.map(
      ({ key, code }) =>
        `  - ${key}: ${code} (${phrases[code] ?? "is invalid"})`,
    );
    super(
      [
        `${app} config is invalid (${String(problems.length)} problem${problems.length === 1 ? "" : "s"}; values are never shown):`,
        ...lines,
        "Set these keys in the environment (locally: .env, created from .env.example by pnpm dev:up).",
      ].join("\n"),
    );
    this.app = app;
    this.problems = Object.freeze(
      problems.map((p) => Object.freeze({ key: p.key, code: p.code })),
    );
  }
}

// On the prototype, so an instance's own keys are only app and problems.
Object.defineProperty(ConfigError.prototype, "name", { value: "ConfigError" });

/** The declared keys' raw values: one read per key, "" becomes undefined. */
export function readDeclared<K extends string>(
  keys: readonly K[],
  env: EnvSource,
): Record<K, unknown> {
  const raw = {} as Record<K, unknown>;
  for (const key of keys) {
    const value = env[key];
    raw[key] = value === "" ? undefined : value;
  }
  return raw;
}

/**
 * Parses `raw` against `shape`. Returns the parsed object, or throws a
 * ConfigError listing every field problem plus `extra` (production
 * guards), deduplicated, in declaration order.
 */
export function parseOrThrow<S extends z.ZodRawShape>(
  app: string,
  shape: S,
  raw: Readonly<Record<keyof S & string, unknown>>,
  extra: readonly ConfigProblem[] = [],
): z.output<z.ZodObject<S>> {
  const result = z.object(shape).safeParse(raw, { reportInput: false });
  const problems: ConfigProblem[] = [];
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = String(issue.path[0] ?? "(root)");
      // A refine() is only ever a format check here (CORS origins).
      const code =
        raw[key] === undefined
          ? "missing"
          : issue.code === "custom"
            ? "invalid_format"
            : issue.code;
      problems.push({ key, code });
    }
  }
  problems.push(...extra);
  const order = Object.keys(shape);
  const unique = [
    ...new Map(problems.map((p) => [`${p.key}\0${p.code}`, p])).values(),
  ].sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  if (unique.length > 0 || !result.success) {
    throw new ConfigError(app, unique);
  }
  return result.data;
}

/** An http(s) URL. */
export const httpUrl = () => z.url({ protocol: /^https?$/ });

/** Deep-freezes plain objects and arrays (Secrets freeze themselves). */
export function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
