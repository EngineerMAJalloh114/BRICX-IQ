// Compares a realm file with what Keycloak holds after importing it (P5-01,
// ADR 0060). The file is a minimal realm: it names only what BRICX sets, and
// Keycloak fills every other field with its defaults and generated ids. So
// the comparison has two parts: subsetProblems() proves every value the file
// sets is the value Keycloak holds, and normalise() makes two imports of the
// same file comparable (generated ids and keys dropped, arrays ordered).

export type Json =
  | null
  | boolean
  | number
  | string
  | readonly Json[]
  | { readonly [key: string]: Json };

type JsonObject = { readonly [key: string]: Json };

export const isObject = (value: Json | undefined): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Array.isArray narrows a readonly Json[] to any[]; this keeps Json. */
export const isArray = (value: Json | undefined): value is readonly Json[] =>
  Array.isArray(value);

/** The value as a string, or an error naming `what` (no value echoed). */
export function text(value: Json | undefined, what: string): string {
  if (typeof value !== "string") throw new Error(`${what} is not a string`);
  return value;
}

/** Generated per import: database ids, the Keycloak version string, the
 * time a client secret was generated. */
const VOLATILE_KEYS: ReadonlySet<string> = new Set([
  "id",
  "containerId",
  "keycloakVersion",
  "client.secret.creation.time",
]);

/** Generated per realm on purpose: its signing and encryption keys. */
const KEY_PROVIDER = "org.keycloak.keys.KeyProvider";

/** Arrays whose element count must match the file exactly. */
const EXACT_LENGTH: ReadonlySet<string> = new Set([
  "authenticationExecutions",
  "protocolMappers",
]);

/** Fields that identify an element of an object array, in priority order. */
const IDENTITY_KEYS = [
  "clientId",
  "alias",
  "flowAlias",
  "authenticator",
  "name",
] as const;

const canonical = (value: Json): string => JSON.stringify(value);

/**
 * The value with generated ids, the Keycloak version and the realm's key
 * providers removed, and every array sorted by its elements' JSON, so two
 * imports of one file compare equal.
 */
export function normalise(value: Json): Json {
  if (isArray(value)) {
    return value
      .map((item) => normalise(item))
      .sort((a, b) => canonical(a).localeCompare(canonical(b)));
  }
  if (!isObject(value)) return value;
  const out: Record<string, Json> = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined || VOLATILE_KEYS.has(key) || key === KEY_PROVIDER) {
      continue;
    }
    out[key] = normalise(item);
  }
  return out;
}

/** The identity of an object-array element, or undefined when it has none. */
function identityOf(item: Json): string | undefined {
  if (!isObject(item)) return undefined;
  for (const key of IDENTITY_KEYS) {
    const value = item[key];
    if (typeof value === "string") return `${key}=${value}`;
  }
  return undefined;
}

/**
 * Every place where `actual` does not hold what `expected` sets, as
 * `$.path: reason` lines (empty when it does). Objects: every key of
 * `expected` must be present and match; extra keys in `actual` are
 * Keycloak defaults and allowed. Arrays of strings, numbers or booleans:
 * the same elements, in any order, none extra. Arrays of objects: each
 * expected element must match the actual element with the same identity
 * (clientId, alias, flowAlias, authenticator or name); extra elements are
 * allowed except in authenticationExecutions and protocolMappers, whose
 * length must match.
 */
export function subsetProblems(
  expected: Json,
  actual: Json | undefined,
  at = "$",
): string[] {
  if (actual === undefined) return [`${at}: missing`];
  if (isArray(expected)) {
    if (!isArray(actual)) return [`${at}: expected an array`];
    return arrayProblems(expected, actual, at);
  }
  if (isObject(expected)) {
    if (!isObject(actual)) return [`${at}: expected an object`];
    return Object.keys(expected).flatMap((key) => {
      const item = expected[key];
      return item === undefined
        ? []
        : subsetProblems(item, actual[key], `${at}.${key}`);
    });
  }
  return expected === actual
    ? []
    : [`${at}: expected ${canonical(expected)}, found ${canonical(actual)}`];
}

function arrayProblems(
  expected: readonly Json[],
  actual: readonly Json[],
  at: string,
): string[] {
  const key = at.slice(at.lastIndexOf(".") + 1);
  const objects = expected.some((item) => isObject(item));
  if (!objects) {
    const want = expected.map(canonical).sort();
    const have = actual.map(canonical).sort();
    return canonical(want) === canonical(have)
      ? []
      : [`${at}: expected [${want.join(", ")}], found [${have.join(", ")}]`];
  }
  const problems: string[] = [];
  if (EXACT_LENGTH.has(key) && expected.length !== actual.length) {
    problems.push(
      `${at}: expected ${String(expected.length)} elements, found ${String(actual.length)}`,
    );
  }
  for (const item of expected) {
    const id = identityOf(item);
    if (id === undefined) {
      problems.push(`${at}: an expected element has no identity field`);
      continue;
    }
    const match = actual.filter((candidate) => identityOf(candidate) === id);
    if (match.length !== 1) {
      problems.push(
        `${at}[${id}]: expected one element, found ${String(match.length)}`,
      );
      continue;
    }
    problems.push(...subsetProblems(item, match[0], `${at}[${id}]`));
  }
  return problems;
}
