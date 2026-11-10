// The adapter registry (P6-04, ADR 0074). The API and the worker build it
// at boot from code, with no config file (D5, D11), and refuse to start
// when it is broken. buildRegistry() takes the environment as an explicit
// input and never reads process.env (owner condition C2): the apps pass
// their validated config's nodeEnv.
//
// Refusals, each an AdapterRegistryError with a code and the adapter's
// index in the list, never a value (D7):
// - invalid_id: the id does not match ADAPTER_ID_PATTERN (P6-03, ADR 0073);
// - duplicate_id: an id already used, by any kind;
// - no_capabilities: no countries or no currencies;
// - unknown_country / unknown_currency: not ISO 3166-1 alpha-2, or not a
//   current ISO 4217 code with a minor unit;
// - null_in_production: a Null adapter while nodeEnv is production (D1).
//
// The result is frozen, its lists and descriptors too: nothing can add an
// adapter after boot. defaultAdapters(nodeEnv) is what the apps register:
// the six Null adapters outside production (P6-06 adds null_email); in production nothing until
// P12-03, P17-03 and P21-02 add real adapters (D8). An empty registry is
// valid, and every adapter-id write then answers 422.
import { ADAPTER_ID_PATTERN } from "@bricx/domain/region-config";
import { isCurrencyCode } from "@bricx/money/currency";
import { COUNTRY_CODES } from "@bricx/validation/country";
import { createNullEmail } from "./email.ts";
import {
  createNullFx,
  createNullSms,
  nullAccounting,
  nullPayment,
  nullTax,
} from "./null.ts";
import {
  ADAPTER_KINDS,
  type AdapterDescriptor,
  type AdapterKind,
  type AnyAdapter,
} from "./types.ts";

/** The environments a registry is built for (NODE_ENV's values). */
export type RegistryEnvironment = "development" | "test" | "production";

export const ADAPTER_REGISTRY_ERROR_CODES = Object.freeze([
  "invalid_id",
  "duplicate_id",
  "no_capabilities",
  "unknown_country",
  "unknown_currency",
  "null_in_production",
] as const);
export type AdapterRegistryErrorCode =
  (typeof ADAPTER_REGISTRY_ERROR_CODES)[number];

/** A broken registry: the code and the adapter's index, never a value. */
export class AdapterRegistryError extends Error {
  readonly code: AdapterRegistryErrorCode;
  readonly index: number;

  constructor(code: AdapterRegistryErrorCode, index: number) {
    super(`adapter registry: ${code} at index ${String(index)}`);
    this.code = code;
    this.index = index;
  }
}
Object.defineProperty(AdapterRegistryError.prototype, "name", {
  value: "AdapterRegistryError",
});

export interface AdapterRegistry {
  readonly nodeEnv: RegistryEnvironment;
  /** Whether an adapter of `kind` has this id. */
  has(kind: AdapterKind, id: string): boolean;
  /** The descriptors of one kind, in registration order. */
  list(kind: AdapterKind): readonly AdapterDescriptor[];
}

export interface BuildRegistryOptions {
  readonly nodeEnv: RegistryEnvironment;
}

const COUNTRIES: ReadonlySet<string> = new Set(COUNTRY_CODES);

function check(
  adapter: AdapterDescriptor,
  index: number,
  seen: ReadonlySet<string>,
  nodeEnv: RegistryEnvironment,
): void {
  const fail = (code: AdapterRegistryErrorCode) => {
    throw new AdapterRegistryError(code, index);
  };
  if (!ADAPTER_ID_PATTERN.test(adapter.id)) fail("invalid_id");
  if (seen.has(adapter.id)) fail("duplicate_id");
  if (adapter.countries.length === 0 || adapter.currencies.length === 0) {
    fail("no_capabilities");
  }
  if (!adapter.countries.every((c) => COUNTRIES.has(c))) {
    fail("unknown_country");
  }
  if (!adapter.currencies.every((c) => isCurrencyCode(c))) {
    fail("unknown_currency");
  }
  if (adapter.nullAdapter === true && nodeEnv === "production") {
    fail("null_in_production");
  }
}

const descriptorOf = (adapter: AdapterDescriptor): AdapterDescriptor =>
  Object.freeze({
    id: adapter.id,
    kind: adapter.kind,
    countries: Object.freeze([...adapter.countries]),
    currencies: Object.freeze([...adapter.currencies]),
    ...(adapter.nullAdapter === true ? { nullAdapter: true as const } : {}),
  });

/** Validates `adapters` and returns the frozen registry; throws on any refusal. */
export function buildRegistry(
  adapters: readonly AdapterDescriptor[],
  options: BuildRegistryOptions,
): AdapterRegistry {
  const { nodeEnv } = options;
  const seen = new Set<string>();
  const byKind = new Map<AdapterKind, AdapterDescriptor[]>(
    ADAPTER_KINDS.map((kind) => [kind, []]),
  );
  adapters.forEach((adapter, index) => {
    check(adapter, index, seen, nodeEnv);
    seen.add(adapter.id);
    byKind.get(adapter.kind)?.push(descriptorOf(adapter));
  });
  const lists = new Map<AdapterKind, readonly AdapterDescriptor[]>(
    [...byKind].map(([kind, list]) => [kind, Object.freeze(list)]),
  );
  const ids = new Map<AdapterKind, ReadonlySet<string>>(
    [...lists].map(([kind, list]) => [kind, new Set(list.map((a) => a.id))]),
  );
  return Object.freeze({
    nodeEnv,
    has: (kind: AdapterKind, id: string) => ids.get(kind)?.has(id) === true,
    list: (kind: AdapterKind) => lists.get(kind) ?? Object.freeze([]),
  });
}

/**
 * What the API and the worker register (D8): the six Null adapters
 * outside production, nothing in production.
 */
export function defaultAdapters(
  nodeEnv: RegistryEnvironment,
): readonly AnyAdapter[] {
  if (nodeEnv === "production") return Object.freeze([]);
  return Object.freeze([
    nullPayment,
    nullTax,
    nullAccounting,
    createNullSms(),
    createNullFx(),
    createNullEmail(),
  ]);
}
