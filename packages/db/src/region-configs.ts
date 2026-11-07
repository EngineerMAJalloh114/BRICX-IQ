// Region configuration rows (P6-03, ADR 0073), in the caller's transaction
// (RLS: the transaction's org only). The API reads and writes them;
// @bricx/domain/region-config resolves the layers.
// - readRegionLayers(): the organisation's own columns (the org layer for
//   currency, language, timezone and units, D8), its org row and, when
//   asked, one project's row, in ONE query over the region_configs_layer
//   unique index (owner condition C2).
// - readSessionIdleSeconds(): the org row's idle limit, or null (the
//   realm's), read fresh on each tracked request (D13, C2).
// - writeRegionConfig(): inserts the layer's row or updates the given
//   fields of it (ON CONFLICT on region_configs_layer), returning it.
import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { Tx } from "./database.js";
import { organizations, regionConfigs } from "./schema/tables.js";

/** The audit subject and catalogue resource (org.region_config). */
export const REGION_CONFIG_SUBJECT = "org.region_config";

/** One stored layer's fields; null inherits. */
export interface RegionConfigFields {
  readonly currency: string | null;
  readonly reportingCurrency: string | null;
  readonly language: string | null;
  readonly timezone: string | null;
  readonly formatLocale: string | null;
  readonly units: string | null;
  readonly taxProfileId: string | null;
  readonly paymentAdapters: readonly string[] | null;
  readonly accountingAdapter: string | null;
  readonly rateLibrary: string | null;
  readonly sessionIdleSeconds: number | null;
}

export const REGION_CONFIG_FIELD_NAMES = Object.freeze([
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
] as const satisfies readonly (keyof RegionConfigFields)[]);

/** A region_configs row, timestamps as UTC ISO 8601 (microseconds). */
export interface RegionConfigRow extends RegionConfigFields {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The organisation columns that are the org layer (D8), plus the country. */
export interface OrganizationRegion {
  readonly country: string;
  readonly currency: string;
  readonly language: string;
  readonly timezone: string;
  readonly units: string;
}

export interface RegionLayers {
  readonly organization: OrganizationRegion;
  readonly org: RegionConfigRow | undefined;
  readonly project: RegionConfigRow | undefined;
}

const iso = (column: typeof regionConfigs.createdAt) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const FIELD_COLUMNS = {
  currency: regionConfigs.currency,
  reportingCurrency: regionConfigs.reportingCurrency,
  language: regionConfigs.language,
  timezone: regionConfigs.timezone,
  formatLocale: regionConfigs.formatLocale,
  units: regionConfigs.units,
  taxProfileId: regionConfigs.taxProfileId,
  paymentAdapters: regionConfigs.paymentAdapters,
  accountingAdapter: regionConfigs.accountingAdapter,
  rateLibrary: regionConfigs.rateLibrary,
  sessionIdleSeconds: regionConfigs.sessionIdleSeconds,
};

/** The columns every read and write returns. */
export const REGION_CONFIG_COLUMNS = {
  id: regionConfigs.id,
  orgId: regionConfigs.orgId,
  projectId: regionConfigs.projectId,
  ...FIELD_COLUMNS,
  createdAt: iso(regionConfigs.createdAt),
  updatedAt: iso(regionConfigs.updatedAt),
};

/** The layer's row: the org row when `projectId` is null. */
export async function readRegionConfig(
  tx: Tx,
  orgId: string,
  projectId: string | null,
): Promise<RegionConfigRow | undefined> {
  const [row] = await tx
    .select(REGION_CONFIG_COLUMNS)
    .from(regionConfigs)
    .where(
      and(
        eq(regionConfigs.orgId, orgId),
        projectId === null
          ? isNull(regionConfigs.projectId)
          : eq(regionConfigs.projectId, projectId),
      ),
    );
  return row;
}

/**
 * The organisation's columns, its org row and (with `projectId`) that
 * project's row, in one query; undefined when the organisation is not
 * visible to the transaction.
 */
export async function readRegionLayers(
  tx: Tx,
  orgId: string,
  projectId?: string,
): Promise<RegionLayers | undefined> {
  const rows = await tx
    .select({
      organization: {
        country: organizations.country,
        currency: organizations.defaultCurrency,
        language: organizations.defaultLanguage,
        timezone: organizations.timezone,
        units: organizations.units,
      },
      layer: REGION_CONFIG_COLUMNS,
    })
    .from(organizations)
    .leftJoin(
      regionConfigs,
      and(
        eq(regionConfigs.orgId, organizations.id),
        projectId === undefined
          ? isNull(regionConfigs.projectId)
          : or(
              isNull(regionConfigs.projectId),
              eq(regionConfigs.projectId, projectId),
            ),
      ),
    )
    .where(eq(organizations.id, orgId));
  const [first] = rows;
  if (first === undefined) return undefined;
  const layers = rows.flatMap((r) => (r.layer === null ? [] : [r.layer]));
  return {
    organization: first.organization,
    org: layers.find((l) => l.projectId === null),
    project: layers.find((l) => l.projectId !== null),
  };
}

/** The org row's idle limit in seconds, or null (none set: the realm's). */
export async function readSessionIdleSeconds(
  tx: Tx,
  orgId: string,
): Promise<number | null> {
  const [row] = await tx
    .select({ seconds: regionConfigs.sessionIdleSeconds })
    .from(regionConfigs)
    .where(
      and(eq(regionConfigs.orgId, orgId), isNull(regionConfigs.projectId)),
    );
  return row?.seconds ?? null;
}

export interface RegionConfigWrite {
  /** The new row's UUIDv7 (unused when the row exists). */
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string | null;
  /** The fields to set; absent ones keep their stored value (NULL when new). */
  readonly changes: Partial<RegionConfigFields>;
  /** UTC ISO 8601: created_at (new row) and updated_at. */
  readonly now: string;
}

/** Inserts the layer's row or updates `changes` on it; returns the row. */
export async function writeRegionConfig(
  tx: Tx,
  input: RegionConfigWrite,
): Promise<RegionConfigRow> {
  const { paymentAdapters, ...rest } = input.changes;
  const changes = {
    ...rest,
    ...(paymentAdapters === undefined
      ? {}
      : {
          paymentAdapters:
            paymentAdapters === null ? null : [...paymentAdapters],
        }),
  };
  const [row] = await tx
    .insert(regionConfigs)
    .values({
      id: input.id,
      orgId: input.orgId,
      projectId: input.projectId,
      ...changes,
      createdAt: input.now,
      updatedAt: input.now,
    })
    .onConflictDoUpdate({
      target: [regionConfigs.orgId, regionConfigs.projectId],
      set: { ...changes, updatedAt: input.now },
    })
    .returning(REGION_CONFIG_COLUMNS);
  if (row === undefined)
    throw new Error("region_configs: upsert returned no row");
  return row;
}
