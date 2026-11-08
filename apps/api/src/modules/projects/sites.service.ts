// Sites' service (P6-05, ADR 0075 D15, D17; owner conditions C4, C5, C6).
// Every route is under a project: the project must be one the caller may
// read (else 404, the same as unknown, C5), and the site one of that
// project the caller may read (a site key holds on its assigned sites
// only, C4; else 404). Then the action on the site (403), then state: an
// archived project or an archived site is read-only (409). One audit
// event per write, the last statement: project.site.create, .update
// (the changed fields' names) or .archive.
// The boundary arrives normalised by the DTO (C6); the table's CHECKs
// judge validity and area: sites_geom_valid and sites_geom_shape are 422
// invalid_polygon at boundary, sites_geom_area 422 polygon_too_large,
// any other CHECK 422 validation_failed, never a 500.
import { constraintOf, sqlstateOf } from "@bricx/db/database";
import type { Tx } from "@bricx/db/database";
import {
  type UuidV7Generator,
  createUuidV7Generator,
} from "@bricx/ids/uuid-v7";
import { issueKey } from "@bricx/validation/codes";
import { errorEnvelope } from "@bricx/validation/error-envelope";
import type { GeoPolygon } from "@bricx/validation/geo";
import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock.js";
import type { Identity } from "../../common/db/request-context.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError, ValidationError } from "../../common/errors/api-error.js";
import { AuditService } from "../audit/public-api.js";
import {
  type AuditRecorder,
  type TransactionRunner,
  requireIdentity,
} from "../sessions/public-api.js";
import { decodeCursor, encodeCursor } from "./projects.dto.js";
import {
  SITE_SUBJECT,
  canProject,
  canSite,
  projectRecord,
  siteReadFilters,
  siteRecord,
} from "./projects.policies.js";
import {
  type ProjectRow,
  ProjectsRepository,
  type SiteFields,
  type SiteRow,
} from "./projects.repository.js";
import type {
  CreateSiteInput,
  ListSitesInput,
  SiteData,
  UpdateSiteInput,
} from "./sites.dto.js";

const CHECK_VIOLATION = "23514";
/** bricx.sites_guard's refusal (migration 0011). */
const SITE_GUARD = "P6005";

const POLYGON_CHECKS: Readonly<
  Record<string, "invalid_polygon" | "polygon_too_large">
> = {
  sites_geom_valid: "invalid_polygon",
  sites_geom_shape: "invalid_polygon",
  sites_geom_area: "polygon_too_large",
};

export interface SitePageData {
  readonly items: SiteData[];
  readonly nextCursor: string | null;
}

/** What the controller calls. */
export type SitesPort = Pick<
  SitesService,
  "create" | "get" | "list" | "update" | "archive"
>;

/** A write's database refusals as API errors (else rethrown). */
function refuseWrite(error: unknown): never {
  const state = sqlstateOf(error);
  if (state === CHECK_VIOLATION) {
    const code = POLYGON_CHECKS[constraintOf(error) ?? ""];
    if (code === undefined) throw new ApiError("validation_failed");
    throw new ValidationError({
      ...errorEnvelope("validation_failed"),
      issues: [{ path: ["boundary"], code, key: issueKey(code) }],
    });
  }
  if (state === SITE_GUARD) throw new ApiError("request.conflict");
  throw error;
}

/** ST_AsGeoJSON's text as the answered polygon. */
function boundaryOf(text: string | null): GeoPolygon | null {
  if (text === null) return null;
  const parsed: unknown = JSON.parse(text);
  return parsed as GeoPolygon;
}

const present = (row: SiteRow): SiteData => ({
  id: row.id,
  projectId: row.projectId,
  name: row.name,
  boundary: boundaryOf(row.boundary),
  address: row.address,
  geofenceRadiusM: row.geofenceRadiusM,
  createdBy: row.createdBy,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  archivedAt: row.archivedAt,
});

const same = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);

@Injectable()
export class SitesService {
  private readonly ids: UuidV7Generator;

  constructor(
    @Inject(TxRunner) private readonly runner: TransactionRunner,
    @Inject(ProjectsRepository)
    private readonly repository: ProjectsRepository,
    @Inject(AuditService) private readonly audit: AuditRecorder,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.ids = createUuidV7Generator({ clock });
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** The project the caller may read; else 404 (C5). */
  private async project(
    tx: Tx,
    identity: Identity,
    projectId: string,
  ): Promise<ProjectRow> {
    const row = await this.repository.findProject(
      tx,
      identity.orgId,
      projectId,
    );
    if (
      row === undefined ||
      !canProject(identity, "read", projectRecord(identity.orgId, row))
    ) {
      throw new ApiError("not_found");
    }
    return row;
  }

  /** The project's site the caller may read; else 404 (C4, C5). */
  private async site(
    tx: Tx,
    identity: Identity,
    projectId: string,
    id: string,
  ): Promise<{ readonly project: ProjectRow; readonly site: SiteRow }> {
    const project = await this.project(tx, identity, projectId);
    const site = await this.repository.findSite(
      tx,
      identity.orgId,
      projectId,
      id,
    );
    if (
      site === undefined ||
      !canSite(identity, "read", siteRecord(identity.orgId, site))
    ) {
      throw new ApiError("not_found");
    }
    return { project, site };
  }

  /** A new site of the project (project.site.create). */
  create(projectId: string, input: CreateSiteInput): Promise<SiteData> {
    const identity = requireIdentity();
    return this.runner.run(async (tx) => {
      const project = await this.project(tx, identity, projectId);
      const id = this.ids.next();
      const record = siteRecord(identity.orgId, {
        id,
        projectId,
        createdBy: identity.userId,
      });
      if (!canSite(identity, "create", record)) {
        throw new ApiError("forbidden");
      }
      if (project.status === "archived") throw new ApiError("request.conflict");
      let row: SiteRow;
      try {
        row = await this.repository.insertSite(tx, {
          id,
          orgId: identity.orgId,
          projectId,
          name: input.name,
          boundary: input.boundary ?? null,
          address: input.address ?? null,
          geofenceRadiusM: input.geofenceRadiusM ?? 0,
          createdBy: identity.userId,
          now: this.now(),
        });
      } catch (error) {
        refuseWrite(error);
      }
      await this.audit.record(tx, {
        action: `${SITE_SUBJECT}.create`,
        entityType: SITE_SUBJECT,
        entityId: row.id,
        after: { projectId, hasBoundary: row.boundary !== null },
      });
      return present(row);
    });
  }

  /** One site (404 when the project or the site is not the caller's to read). */
  get(projectId: string, id: string): Promise<SiteData> {
    const identity = requireIdentity();
    return this.runner.run(async (tx) =>
      present((await this.site(tx, identity, projectId, id)).site),
    );
  }

  /** A page of the project's sites the caller may read, newest first. */
  list(projectId: string, query: ListSitesInput): Promise<SitePageData> {
    const identity = requireIdentity();
    const filters = siteReadFilters(identity);
    const before =
      query.cursor === undefined ? undefined : decodeCursor(query.cursor);
    return this.runner.run(async (tx) => {
      await this.project(tx, identity, projectId);
      const rows = await this.repository.listSites(
        tx,
        identity.orgId,
        projectId,
        { filters, before, limit: query.limit + 1 },
      );
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        items: page.map(present),
        nextCursor:
          rows.length > query.limit && last !== undefined
            ? encodeCursor(last.id)
            : null,
      };
    });
  }

  /** Changes the given fields (project.site.update on the site). */
  update(
    projectId: string,
    id: string,
    input: UpdateSiteInput,
  ): Promise<SiteData> {
    const identity = requireIdentity();
    return this.runner.run(async (tx) => {
      const { project, site } = await this.site(tx, identity, projectId, id);
      if (!canSite(identity, "update", siteRecord(identity.orgId, site))) {
        throw new ApiError("forbidden");
      }
      if (project.status === "archived" || site.archivedAt !== null) {
        throw new ApiError("request.conflict");
      }
      const before = present(site);
      const changes: { -readonly [K in keyof SiteFields]?: SiteFields[K] } = {};
      if (input.name !== undefined && input.name !== before.name)
        changes.name = input.name;
      if (
        input.boundary !== undefined &&
        !same(input.boundary, before.boundary)
      )
        changes.boundary = input.boundary;
      if (input.address !== undefined && input.address !== before.address)
        changes.address = input.address;
      if (
        input.geofenceRadiusM !== undefined &&
        input.geofenceRadiusM !== before.geofenceRadiusM
      )
        changes.geofenceRadiusM = input.geofenceRadiusM;
      const fields = Object.keys(changes).sort();
      if (fields.length === 0) return before;
      let row: SiteRow;
      try {
        row = await this.repository.updateSite(
          tx,
          identity.orgId,
          projectId,
          id,
          changes,
          this.now(),
        );
      } catch (error) {
        refuseWrite(error);
      }
      await this.audit.record(tx, {
        action: `${SITE_SUBJECT}.update`,
        entityType: SITE_SUBJECT,
        entityId: id,
        after: { fields },
      });
      return present(row);
    });
  }

  /** Archives the site (project.site.archive on it); final. */
  archive(projectId: string, id: string): Promise<SiteData> {
    const identity = requireIdentity();
    return this.runner.run(async (tx) => {
      const { project, site } = await this.site(tx, identity, projectId, id);
      if (!canSite(identity, "archive", siteRecord(identity.orgId, site))) {
        throw new ApiError("forbidden");
      }
      if (project.status === "archived" || site.archivedAt !== null) {
        throw new ApiError("request.conflict");
      }
      const now = this.now();
      let row: SiteRow;
      try {
        row = await this.repository.updateSite(
          tx,
          identity.orgId,
          projectId,
          id,
          { archivedAt: now },
          now,
        );
      } catch (error) {
        refuseWrite(error);
      }
      await this.audit.record(tx, {
        action: `${SITE_SUBJECT}.archive`,
        entityType: SITE_SUBJECT,
        entityId: id,
        before: { archivedAt: null },
        after: { archivedAt: row.archivedAt },
      });
      return present(row);
    });
  }
}
