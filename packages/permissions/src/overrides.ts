// Per-member project overrides (P5-05, ADR 0066): pure set algebra over
// catalogue keys, shared by the API (writes and the grants source) and
// anything that must agree with it. A project membership grants
// effectiveKeys(bundle, overrides) = (bundle ∪ add) − remove. Every list
// is bounded before it is read (P3 rule); errors carry codes only.
import {
  CATALOGUE,
  type CatalogueKey,
  parseCatalogueKey,
} from "./catalogue.ts";
import { PermissionError } from "./errors.ts";

/** Most keys in one override list (add or remove). */
export const MAX_OVERRIDE_KEYS = 50;

/** A project membership's overrides, as stored (both lists optional). */
export interface Overrides {
  readonly add?: readonly string[] | undefined;
  readonly remove?: readonly string[] | undefined;
}

/** No overrides: the bundle as it is. */
export const NO_OVERRIDES: Overrides = Object.freeze({
  add: Object.freeze([]),
  remove: Object.freeze([]),
});

export type OverridesProblem =
  | "too_many_keys"
  | "unknown_key"
  | "duplicate_key"
  | "add_scope"
  | "add_in_bundle"
  | "remove_not_in_bundle"
  | "key_in_both"
  | "bundle_immutable";

export interface ValidateOverridesOptions {
  /** The bundle takes no overrides (the virtual owner role). */
  readonly immutable?: boolean | undefined;
}

/** The catalogue keys of `values`, in order, and how many were not. */
export interface KnownKeys {
  readonly known: readonly CatalogueKey[];
  readonly unknown: number;
}

const bounded = (values: readonly unknown[], max: number): void => {
  if (!Array.isArray(values) || values.length > max) {
    throw new PermissionError("too_many_keys");
  }
};

/**
 * Splits `values` into the catalogue keys it holds (in order, duplicates
 * kept) and a count of the rest. Never throws for an unknown string: a
 * stored key the catalogue no longer knows is dropped, and the caller
 * logs the count. Throws too_many_keys above the catalogue's size.
 */
export function knownKeys(values: readonly string[]): KnownKeys {
  bounded(values, CATALOGUE.length);
  const known: CatalogueKey[] = [];
  let unknown = 0;
  for (const value of values) {
    const parsed =
      typeof value === "string" ? parseCatalogueKey(value) : undefined;
    if (parsed === undefined) unknown += 1;
    else known.push(`${parsed.permission}.${parsed.scope}`);
  }
  return { known: Object.freeze(known), unknown };
}

/**
 * What a membership grants: (bundle ∪ add) − remove, catalogue keys only,
 * sorted and unique. Lenient on unknown strings (dropped); strict on
 * size (too_many_keys: the bundle above the catalogue's size, a list
 * above MAX_OVERRIDE_KEYS).
 */
export function effectiveKeys(
  bundle: readonly string[],
  overrides: Overrides,
): readonly CatalogueKey[] {
  const add = overrides.add ?? [];
  const remove = overrides.remove ?? [];
  bounded(add, MAX_OVERRIDE_KEYS);
  bounded(remove, MAX_OVERRIDE_KEYS);
  const removed = new Set(knownKeys(remove).known);
  const out = new Set<CatalogueKey>();
  for (const key of [...knownKeys(bundle).known, ...knownKeys(add).known]) {
    if (!removed.has(key)) out.add(key);
  }
  return Object.freeze([...out].sort());
}

/**
 * The write-time check of `overrides` against the role's `bundle`, after
 * the API's shape validation: the first problem, in list order (bounds,
 * then every add, then every remove), or undefined when they are
 * acceptable. An add must be a catalogue key at project or own scope
 * (never org or site: no project override grants beyond the project)
 * and not in the bundle already; a remove must be a catalogue key in
 * the bundle; a key is never in both; nothing may change an immutable
 * bundle. Whether the editor holds every added key is the API's check.
 */
export function validateOverrides(
  overrides: Overrides,
  bundle: readonly CatalogueKey[],
  options: ValidateOverridesOptions = {},
): OverridesProblem | undefined {
  const add: readonly unknown[] = overrides.add ?? [];
  const remove: readonly unknown[] = overrides.remove ?? [];
  if (
    !Array.isArray(add) ||
    add.length > MAX_OVERRIDE_KEYS ||
    !Array.isArray(remove) ||
    remove.length > MAX_OVERRIDE_KEYS
  ) {
    return "too_many_keys";
  }
  if (options.immutable === true && (add.length > 0 || remove.length > 0)) {
    return "bundle_immutable";
  }
  const inBundle = new Set<string>(bundle);
  const seenAdd = new Set<string>();
  for (const value of add) {
    const parsed =
      typeof value === "string" ? parseCatalogueKey(value) : undefined;
    if (parsed === undefined || typeof value !== "string") return "unknown_key";
    if (seenAdd.has(value)) return "duplicate_key";
    seenAdd.add(value);
    if (parsed.scope !== "project" && parsed.scope !== "own") {
      return "add_scope";
    }
    if (inBundle.has(value)) return "add_in_bundle";
  }
  const seenRemove = new Set<string>();
  for (const value of remove) {
    const parsed =
      typeof value === "string" ? parseCatalogueKey(value) : undefined;
    if (parsed === undefined || typeof value !== "string") return "unknown_key";
    if (seenRemove.has(value)) return "duplicate_key";
    seenRemove.add(value);
    if (seenAdd.has(value)) return "key_in_both";
    if (!inBundle.has(value)) return "remove_not_in_bundle";
  }
  return undefined;
}
