// Region configuration (P6-03, ADR 0073): the effective settings of an
// organisation or one of its projects, layered system -> org -> project,
// each later layer winning and NULL (or absent) inheriting. Every field of
// the result says which layer set it.
// - org: the organisation's own columns for currency, language, timezone
//   and units (P6-02 D8; one source, D8), plus its region_configs org row
//   for every other field.
// - project: the project's region_configs row; it never sets the session
//   idle timeout (D10).
// - system: what is left, derived (D9): reporting currency = the effective
//   currency; format locale = the effective language + the org's country;
//   no tax profile, accounting adapter or rate library; no payment
//   adapters; the realm's idle limit.
// Pure and client-safe: no clock, no I/O. Inputs are validated at the
// boundary (the API's DTOs and the table's CHECKs).
import { SESSION_IDLE_SECONDS } from "./limits.ts";
import type { UnitSystemName } from "./regions.ts";

export const REGION_CONFIG_FIELDS = Object.freeze([
  "currency",
  "reportingCurrency",
  "language",
  "timezone",
  "formatLocale",
  "units",
  "taxProfileId",
  "paymentAdapters",
  "accountingAdapter",
  "rateLibrary",
  "sessionIdleSeconds",
] as const);
export type RegionConfigField = (typeof REGION_CONFIG_FIELDS)[number];

/** Fields whose org layer is the organisation's own column (D8). */
export const ORG_COLUMN_FIELDS = Object.freeze([
  "currency",
  "language",
  "timezone",
  "units",
] as const);
export type OrgColumnField = (typeof ORG_COLUMN_FIELDS)[number];

/** Fields a project row never sets (D10). */
export const PROJECT_FORBIDDEN_FIELDS = Object.freeze([
  "sessionIdleSeconds",
] as const);

/** An adapter id (D4): P6-04's registry checks it exists. */
export const ADAPTER_ID_PATTERN = /^[a-z][a-z0-9_]{1,62}$/;
/** An opaque reference (tax profile, rate library) until P21 and P15. */
export const REFERENCE_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
/** Most payment adapters one layer enables (D12). */
export const PAYMENT_ADAPTERS_MAX = 16;

export interface RegionConfigValues {
  readonly currency: string;
  readonly reportingCurrency: string;
  readonly language: string;
  readonly timezone: string;
  /** A BCP 47 tag dates and numbers are formatted with (Intl, D3). */
  readonly formatLocale: string;
  readonly units: UnitSystemName;
  readonly taxProfileId: string | null;
  readonly paymentAdapters: readonly string[];
  readonly accountingAdapter: string | null;
  readonly rateLibrary: string | null;
  readonly sessionIdleSeconds: number;
}

/** One stored row: each field set, or NULL / absent (inherit). */
export type RegionConfigLayer = {
  readonly [K in RegionConfigField]?: RegionConfigValues[K] | null;
};

/** The organisation's own columns (P6-02). */
export interface OrganizationLayer {
  readonly country: string;
  readonly currency: string;
  readonly language: string;
  readonly timezone: string;
  readonly units: UnitSystemName;
}

export type Provenance = "system" | "org" | "project";

export type EffectiveRegionConfig = {
  readonly [K in RegionConfigField]: {
    readonly value: RegionConfigValues[K];
    readonly source: Provenance;
  };
};

export interface ResolveInput {
  readonly organization: OrganizationLayer;
  readonly org?: RegionConfigLayer | undefined;
  readonly project?: RegionConfigLayer | undefined;
}

const isOrgColumn = (field: RegionConfigField): field is OrgColumnField =>
  (ORG_COLUMN_FIELDS as readonly string[]).includes(field);
const projectForbidden = (field: RegionConfigField) =>
  (PROJECT_FORBIDDEN_FIELDS as readonly string[]).includes(field);

/** A layer's value for `field`, or undefined when absent or NULL (inherit). */
const stored = <K extends RegionConfigField>(
  layer: RegionConfigLayer,
  field: K,
): RegionConfigValues[K] | undefined => layer[field] ?? undefined;

const freeze = <T>(value: T): T =>
  Array.isArray(value) ? (Object.freeze([...value]) as T) : value;

/** The effective configuration, every field with its provenance. */
export function resolveRegionConfig(
  input: ResolveInput,
): EffectiveRegionConfig {
  const { organization } = input;
  const org = input.org ?? {};
  const project = input.project ?? {};
  const layered = <K extends RegionConfigField>(
    field: K,
  ): { value: RegionConfigValues[K]; source: Provenance } | undefined => {
    const fromProject = projectForbidden(field)
      ? undefined
      : stored(project, field);
    if (fromProject !== undefined) {
      return { value: freeze(fromProject), source: "project" };
    }
    if (isOrgColumn(field)) {
      return {
        value: organization[field] as RegionConfigValues[K],
        source: "org",
      };
    }
    const fromOrg = stored(org, field);
    if (fromOrg !== undefined) {
      return { value: freeze(fromOrg), source: "org" };
    }
    return undefined;
  };
  const resolved = new Map<RegionConfigField, unknown>();
  const take = <K extends RegionConfigField>(
    field: K,
    system: () => RegionConfigValues[K],
  ) => {
    const value = layered(field) ?? {
      value: freeze(system()),
      source: "system" as const,
    };
    resolved.set(field, Object.freeze(value));
    return value.value;
  };
  // The organisation columns always hold a value; their system default is
  // never reached but keeps the result total.
  const currency = take("currency", () => organization.currency);
  const language = take("language", () => organization.language);
  take("timezone", () => organization.timezone);
  take("units", () => organization.units);
  take("reportingCurrency", () => currency);
  take("formatLocale", () => `${language}-${organization.country}`);
  take("taxProfileId", () => null);
  take("paymentAdapters", () => []);
  take("accountingAdapter", () => null);
  take("rateLibrary", () => null);
  take("sessionIdleSeconds", () => SESSION_IDLE_SECONDS.max);
  return Object.freeze(
    Object.fromEntries(REGION_CONFIG_FIELDS.map((f) => [f, resolved.get(f)])),
  ) as EffectiveRegionConfig;
}
