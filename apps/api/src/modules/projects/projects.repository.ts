// Projects' and sites' repository (P6-05, ADR 0075): every statement runs
// in the `tx` TxRunner hands over, as bricx_app under RLS (tenant and
// project isolation on projects and sites; the extra assigned-site SELECT
// policy on sites), and adds the org id too.
// - Timestamps are read as UTC ISO 8601 with microseconds; the contract
//   value's minor units as text (never a float, never a JS number).
// - A site's boundary is written with ST_GeomFromGeoJSON(...)::geography
//   and read with ST_AsGeoJSON (the API normalised its orientation, C6).
// - Lists are keyset-paged by id (UUIDv7), newest first: id < the cursor,
//   ORDER BY id DESC, `limit` rows (the service asks one more than a page).
// - A unique violation (the code, regardless of case, C7) is
//   ApiError("request.conflict") here; CHECK violations are the
//   service's to map (it names the field).
import { type Tx, sqlstateOf } from "@bricx/db/database";
import { projects, sites } from "@bricx/db/schema";
import type { AccessFilter } from "@bricx/permissions/ability";
import type { GeoPolygon } from "@bricx/validation/geo";
import { Injectable } from "@nestjs/common";
import {
  type SQL,
  and,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { ApiError } from "../../common/errors/api-error.js";

const UNIQUE_VIOLATION = "23505";

const iso = (
  column:
    | typeof projects.createdAt
    | typeof projects.updatedAt
    | typeof sites.createdAt
    | typeof sites.updatedAt,
) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const isoOrNull = (
  column: typeof projects.archivedAt | typeof sites.archivedAt,
) =>
  sql<
    string | null
  >`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** A projects row as the API reads it. */
export interface ProjectRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly clientName: string | null;
  readonly status: string;
  readonly currency: string;
  readonly reportingCurrency: string;
  readonly timezone: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  /** Minor units as a decimal string, or null. */
  readonly contractValueMinor: string | null;
  readonly contractValueCurrency: string | null;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/** The writable columns of a project (a PATCH sets some of them). */
export interface ProjectFields {
  readonly code: string;
  readonly name: string;
  readonly clientName: string | null;
  readonly currency: string;
  readonly reportingCurrency: string;
  readonly timezone: string;
  readonly startDate: string | null;
  readonly endDate: string | null;
  readonly contractValueMinor: bigint | null;
  readonly contractValueCurrency: string | null;
}

export interface NewProject extends ProjectFields {
  readonly id: string;
  readonly orgId: string;
  readonly createdBy: string;
  readonly now: string;
}

/** A sites row as the API reads it; boundary is ST_AsGeoJSON's text. */
export interface SiteRow {
  readonly id: string;
  readonly projectId: string;
  readonly name: string;
  readonly boundary: string | null;
  readonly address: string | null;
  readonly geofenceRadiusM: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

/** The writable fields of a site (a PATCH sets some of them). */
export interface SiteFields {
  readonly name: string;
  readonly boundary: GeoPolygon | null;
  readonly address: string | null;
  readonly geofenceRadiusM: number;
}

export interface NewSite extends SiteFields {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string;
  readonly createdBy: string;
  readonly now: string;
}

export interface PageQuery {
  readonly filters: readonly AccessFilter[];
  /** Only ids before this one (the cursor), newest first. */
  readonly before: string | undefined;
  readonly limit: number;
}

const projectColumns = {
  id: projects.id,
  code: projects.code,
  name: projects.name,
  clientName: projects.clientName,
  status: projects.status,
  currency: projects.currency,
  reportingCurrency: projects.reportingCurrency,
  timezone: projects.timezone,
  startDate: projects.startDate,
  endDate: projects.endDate,
  contractValueMinor: sql<string | null>`${projects.contractValueMinor}::text`,
  contractValueCurrency: projects.contractValueCurrency,
  createdBy: projects.createdBy,
  createdAt: iso(projects.createdAt),
  updatedAt: iso(projects.updatedAt),
  archivedAt: isoOrNull(projects.archivedAt),
};

const siteColumns = {
  id: sites.id,
  projectId: sites.projectId,
  name: sites.name,
  boundary: sql<string | null>`extensions.ST_AsGeoJSON(${sites.geom})`,
  address: sites.address,
  geofenceRadiusM: sites.geofenceRadiusM,
  createdBy: sites.createdBy,
  createdAt: iso(sites.createdAt),
  updatedAt: iso(sites.updatedAt),
  archivedAt: isoOrNull(sites.archivedAt),
};

/** A boundary as the column's SQL value (NULL for none). */
const geomOf = (boundary: GeoPolygon | null): SQL =>
  boundary === null
    ? sql`NULL`
    : sql`extensions.ST_GeomFromGeoJSON(${JSON.stringify(boundary)})::extensions.geography`;

/** One project read filter as SQL; a site filter matches no project. */
function projectFilterSql(filter: AccessFilter): SQL | undefined {
  if (filter.siteIds !== undefined) return undefined;
  return and(
    eq(projects.orgId, filter.orgId),
    filter.projectIds === undefined
      ? undefined
      : inArray(projects.id, [...filter.projectIds]),
    filter.createdBy === undefined
      ? undefined
      : eq(projects.createdBy, filter.createdBy),
  );
}

/** One site read filter as SQL. */
function siteFilterSql(filter: AccessFilter): SQL | undefined {
  return and(
    eq(sites.orgId, filter.orgId),
    filter.projectIds === undefined
      ? undefined
      : inArray(sites.projectId, [...filter.projectIds]),
    filter.siteIds === undefined
      ? undefined
      : inArray(sites.id, [...filter.siteIds]),
    filter.createdBy === undefined
      ? undefined
      : eq(sites.createdBy, filter.createdBy),
  );
}

const anyOf = (
  filters: readonly AccessFilter[],
  toSql: (filter: AccessFilter) => SQL | undefined,
): SQL | undefined => {
  const allowed = filters.map(toSql).filter((f): f is SQL => f !== undefined);
  return allowed.length === 0 ? undefined : or(...allowed);
};

function conflictOnUnique(error: unknown): never {
  if (sqlstateOf(error) === UNIQUE_VIOLATION) {
    throw new ApiError("request.conflict");
  }
  throw error;
}

/** The project columns a PATCH writes (only the given ones). */
function projectSet(fields: Partial<ProjectFields>): Record<string, unknown> {
  // exactOptionalPropertyTypes: an absent field is absent, never undefined.
  return { ...fields };
}

@Injectable()
export class ProjectsRepository {
  /** The project `id` the transaction sees, or undefined. */
  async findProject(
    tx: Tx,
    orgId: string,
    id: string,
  ): Promise<ProjectRow | undefined> {
    const [row] = await tx
      .select(projectColumns)
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, id)));
    return row;
  }

  /** The same, locked FOR UPDATE (a write reads before it changes). */
  async lockProject(
    tx: Tx,
    orgId: string,
    id: string,
  ): Promise<ProjectRow | undefined> {
    const [row] = await tx
      .select(projectColumns)
      .from(projects)
      .where(and(eq(projects.orgId, orgId), eq(projects.id, id)))
      .for("update");
    return row;
  }

  async insertProject(tx: Tx, input: NewProject): Promise<ProjectRow> {
    let rows: ProjectRow[];
    try {
      rows = await tx
        .insert(projects)
        .values({
          id: input.id,
          orgId: input.orgId,
          code: input.code,
          name: input.name,
          clientName: input.clientName,
          status: "draft",
          currency: input.currency,
          reportingCurrency: input.reportingCurrency,
          timezone: input.timezone,
          startDate: input.startDate,
          endDate: input.endDate,
          contractValueMinor: input.contractValueMinor,
          contractValueCurrency: input.contractValueCurrency,
          createdBy: input.createdBy,
          createdAt: input.now,
          updatedAt: input.now,
        })
        .returning(projectColumns);
    } catch (error) {
      conflictOnUnique(error);
    }
    const [row] = rows;
    if (row === undefined) throw new Error("insert returned no row");
    return row;
  }

  /** Sets the given fields (and updated_at); the row after. */
  async updateProject(
    tx: Tx,
    orgId: string,
    id: string,
    fields: Partial<ProjectFields> & {
      readonly status?: string;
      readonly archivedAt?: string;
    },
    now: string,
  ): Promise<ProjectRow> {
    let rows: ProjectRow[];
    try {
      rows = await tx
        .update(projects)
        .set({ ...projectSet(fields), updatedAt: now })
        .where(and(eq(projects.orgId, orgId), eq(projects.id, id)))
        .returning(projectColumns);
    } catch (error) {
      conflictOnUnique(error);
    }
    const [row] = rows;
    if (row === undefined) throw new ApiError("not_found");
    return row;
  }

  /** Up to `limit` projects matching a filter (and the status), newest first. */
  listProjects(
    tx: Tx,
    orgId: string,
    query: PageQuery & { readonly status?: string | undefined },
  ): Promise<ProjectRow[]> {
    const allowed = anyOf(query.filters, projectFilterSql);
    if (allowed === undefined) return Promise.resolve([]);
    return tx
      .select(projectColumns)
      .from(projects)
      .where(
        and(
          eq(projects.orgId, orgId),
          allowed,
          query.status === undefined
            ? undefined
            : eq(projects.status, query.status),
          query.before === undefined
            ? undefined
            : lt(projects.id, query.before),
        ),
      )
      .orderBy(desc(projects.id))
      .limit(query.limit);
  }

  /** The site `id` of `projectId` the transaction sees, or undefined. */
  async findSite(
    tx: Tx,
    orgId: string,
    projectId: string,
    id: string,
  ): Promise<SiteRow | undefined> {
    const [row] = await tx
      .select(siteColumns)
      .from(sites)
      .where(
        and(
          eq(sites.orgId, orgId),
          eq(sites.projectId, projectId),
          eq(sites.id, id),
        ),
      );
    return row;
  }

  /** Inserts a site; constraint violations propagate (the service maps them). */
  async insertSite(tx: Tx, input: NewSite): Promise<SiteRow> {
    const rows = await tx
      .insert(sites)
      .values({
        id: input.id,
        orgId: input.orgId,
        projectId: input.projectId,
        name: input.name,
        geom: geomOf(input.boundary),
        address: input.address,
        geofenceRadiusM: input.geofenceRadiusM,
        createdBy: input.createdBy,
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning(siteColumns);
    const [row] = rows;
    if (row === undefined) throw new Error("insert returned no row");
    return row;
  }

  /** Sets the given fields (and updated_at, archived_at when given). */
  async updateSite(
    tx: Tx,
    orgId: string,
    projectId: string,
    id: string,
    fields: Partial<SiteFields> & { readonly archivedAt?: string },
    now: string,
  ): Promise<SiteRow> {
    const set: Record<string, unknown> = { updatedAt: now };
    if (fields.name !== undefined) set["name"] = fields.name;
    if (fields.boundary !== undefined) set["geom"] = geomOf(fields.boundary);
    if (fields.address !== undefined) set["address"] = fields.address;
    if (fields.geofenceRadiusM !== undefined)
      set["geofenceRadiusM"] = fields.geofenceRadiusM;
    if (fields.archivedAt !== undefined) set["archivedAt"] = fields.archivedAt;
    const rows = await tx
      .update(sites)
      .set(set)
      .where(
        and(
          eq(sites.orgId, orgId),
          eq(sites.projectId, projectId),
          eq(sites.id, id),
          isNull(sites.archivedAt),
        ),
      )
      .returning(siteColumns);
    const [row] = rows;
    if (row === undefined) throw new ApiError("request.conflict");
    return row;
  }

  /** Up to `limit` sites of the project matching a filter, newest first. */
  listSites(
    tx: Tx,
    orgId: string,
    projectId: string,
    query: PageQuery,
  ): Promise<SiteRow[]> {
    const allowed = anyOf(query.filters, siteFilterSql);
    if (allowed === undefined) return Promise.resolve([]);
    return tx
      .select(siteColumns)
      .from(sites)
      .where(
        and(
          eq(sites.orgId, orgId),
          eq(sites.projectId, projectId),
          allowed,
          query.before === undefined ? undefined : lt(sites.id, query.before),
        ),
      )
      .orderBy(desc(sites.id))
      .limit(query.limit);
  }

  /** Of `siteIds`, the open sites of the project the transaction sees. */
  async openSiteIds(
    tx: Tx,
    orgId: string,
    projectId: string,
    siteIds: readonly string[],
  ): Promise<string[]> {
    if (siteIds.length === 0) return [];
    const rows = await tx
      .select({ id: sites.id })
      .from(sites)
      .where(
        and(
          eq(sites.orgId, orgId),
          eq(sites.projectId, projectId),
          inArray(sites.id, [...siteIds]),
          isNull(sites.archivedAt),
        ),
      );
    return rows.map((row) => row.id).sort();
  }
}
