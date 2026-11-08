// Sites' boundary schemas (P6-05, ADR 0075 D15, D17; owner condition C6).
// - boundary: a GeoJSON Polygon through @bricx/validation's
//   GeoPolygonSchema (bounded before any position is read, finite 2-D
//   [lng, lat] in range, rings closed, orientation normalised: outer ring
//   counter-clockwise, holes clockwise), or null: a site without a
//   boundary yet (for architect review). Self-intersection and the 1 000
//   km² bound are the table's CHECKs, mapped to 422 by the service.
// - address 1..500 or null; geofenceRadiusM an integer 0..10 000
//   (default 0); name 1..200.
// - A PATCH with no field is 422. Lists are keyset-paged like projects.
import {
  GeoPolygonOutputSchema,
  GeoPolygonSchema,
} from "@bricx/validation/geo";
import { PageLimitSchema, pageOf } from "@bricx/validation/pagination";
import { createZodDto } from "nestjs-zod";
import { z } from "zod";
import {
  IdSchema,
  PageCursor,
  PROJECT_NAME_MAX,
  strict,
  textOf,
  typeError,
} from "./projects.dto.js";

/** Most characters in an address (the table's CHECK says the same). */
export const ADDRESS_MAX = 500;
/** The largest geofence radius in metres (the table's CHECK says the same). */
export const GEOFENCE_RADIUS_MAX = 10_000;

const Radius = z
  .number({ error: typeError })
  .int({ error: "validation:invalid_value" })
  .min(0, { error: "validation:invalid_value" })
  .max(GEOFENCE_RADIUS_MAX, { error: "validation:invalid_value" });

const FIELDS = {
  name: textOf(PROJECT_NAME_MAX),
  boundary: GeoPolygonSchema.nullable().optional(),
  address: textOf(ADDRESS_MAX).nullable().optional(),
  geofenceRadiusM: Radius.optional(),
};

export const CreateSiteSchema = strict(FIELDS);
export type CreateSiteInput = z.output<typeof CreateSiteSchema>;
export class CreateSite extends createZodDto(CreateSiteSchema) {}

export const UpdateSiteSchema = strict({
  ...FIELDS,
  name: FIELDS.name.optional(),
}).refine((body) => Object.keys(body).length > 0, {
  error: "validation:required",
});
export type UpdateSiteInput = z.output<typeof UpdateSiteSchema>;
export class UpdateSite extends createZodDto(UpdateSiteSchema) {}

export class ProjectSitesParams extends createZodDto(
  strict({ projectId: IdSchema }),
) {}

export class SiteParams extends createZodDto(
  strict({ projectId: IdSchema, id: IdSchema }),
) {}

export const ListSitesQuerySchema = strict({
  cursor: PageCursor.optional(),
  limit: PageLimitSchema,
});
export type ListSitesInput = z.output<typeof ListSitesQuerySchema>;
export class ListSitesQuery extends createZodDto(ListSitesQuerySchema) {}

const SiteSchema = strict({
  id: IdSchema,
  projectId: IdSchema,
  name: z.string(),
  /** As stored: outer ring counter-clockwise, holes clockwise; or null. */
  boundary: GeoPolygonOutputSchema.nullable(),
  address: z.string().nullable(),
  geofenceRadiusM: z.number().int(),
  createdBy: IdSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  archivedAt: z.string().nullable(),
});
export type SiteData = z.output<typeof SiteSchema>;
export class Site extends createZodDto(SiteSchema) {}

/** A page of a project's sites, newest first. */
export class SitePage extends createZodDto(pageOf(SiteSchema)) {}
