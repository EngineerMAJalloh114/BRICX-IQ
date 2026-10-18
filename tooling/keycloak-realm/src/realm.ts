// The bricx realm file (P5-01, ADR 0060) as data for the tests: parsed,
// with its environment placeholders resolved the way Keycloak's import
// resolves them, and split into the part the admin API's partial export
// returns and the declarative user profile it does not.
import { readFileSync } from "node:fs";
import path from "node:path";
import { isArray, isObject, type Json } from "./normalise.js";

export const repoRoot = path.resolve(import.meta.dirname, "../../..");
export const realmFile = path.join(
  repoRoot,
  "infrastructure/keycloak/realm-bricx.json",
);
/** The build context of the dev stack's optimized Keycloak image. */
export const imageDir = path.join(repoRoot, "infrastructure/docker/keycloak");

/** Environment variables the realm file reads through `${NAME}`. */
export const PLACEHOLDERS = [
  "KEYCLOAK_WEB_REDIRECT_URI",
  "KEYCLOAK_WEB_ORIGIN",
] as const;

const USER_PROFILE = "org.keycloak.userprofile.UserProfileProvider";
const placeholder = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::([^}]*))?\}/g;

/** The realm file, parsed. */
export function loadRealm(file = realmFile): { readonly [key: string]: Json } {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as Json;
  if (!isObject(parsed)) throw new Error("the realm file is not an object");
  return parsed;
}

/**
 * The value with every `${NAME}` or `${NAME:default}` in a string replaced
 * from `env`, as Keycloak's import does; a name `env` lacks keeps its
 * default, or stays literal when it has none.
 */
export function resolvePlaceholders(
  value: Json,
  env: Readonly<Record<string, string>>,
): Json {
  if (typeof value === "string") {
    return value.replace(
      placeholder,
      (whole, name: string, fallback: string | undefined) =>
        env[name] ?? fallback ?? whole,
    );
  }
  if (isArray(value)) {
    return value.map((item) => resolvePlaceholders(item, env));
  }
  if (!isObject(value)) return value;
  const out: Record<string, Json> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = resolvePlaceholders(item, env);
  }
  return out;
}

/** Every placeholder name used anywhere in the value. */
export function placeholderNames(value: Json): string[] {
  const names = new Set<string>();
  const visit = (item: Json): void => {
    if (typeof item === "string") {
      for (const match of item.matchAll(placeholder)) names.add(match[1] ?? "");
    } else if (isArray(item)) {
      for (const child of item) visit(child);
    } else if (isObject(item)) {
      for (const child of Object.values(item)) visit(child);
    }
  };
  visit(value);
  return [...names].sort();
}

/** The realm's declarative user profile, parsed from its component. */
export function userProfileOf(realm: { readonly [key: string]: Json }): Json {
  const components = realm.components;
  const providers = isObject(components) ? components[USER_PROFILE] : undefined;
  const provider = isArray(providers) ? providers[0] : undefined;
  const config = isObject(provider) ? provider.config : undefined;
  const text = isObject(config) ? config["kc.user.profile.config"] : undefined;
  const first = isArray(text) ? text[0] : undefined;
  if (typeof first !== "string") {
    throw new Error("the realm file has no declarative user profile");
  }
  return JSON.parse(first) as Json;
}

/** The realm without its components: what the partial export compares to. */
export function withoutComponents(realm: {
  readonly [key: string]: Json;
}): Json {
  return Object.fromEntries(
    Object.entries(realm).filter(([key]) => key !== "components"),
  );
}
