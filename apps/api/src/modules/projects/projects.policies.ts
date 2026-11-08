// Projects' and sites' policies (P6-05, ADR 0075 D16; owner conditions C3,
// C5, C8): CASL checks from @bricx/permissions through can() over the
// identity's ability. A project record names its own id as the project
// (project.project is a project-level resource); a site record names its
// project and its own id (project.site is site-level), so a site key
// holds on exactly the sites DbGrantsSource assigned (C4). The routes'
// guards check the action is held somewhere in the org ({ anywhere });
// the services check the record: one the caller may not read is 404, the
// same as an unknown id (C5), one they read but may not change is 403.
import {
  type AccessFilter,
  type PermissionRecord,
  accessibleQuery,
  can,
} from "@bricx/permissions/ability";
import { abilityFor } from "../../common/auth/ability.js";
import type { Identity } from "../../common/db/request-context.js";

/** The catalogue subjects (@bricx/permissions) and the audit entity types. */
export const PROJECT_SUBJECT = "project.project";
export const SITE_SUBJECT = "project.site";

export type ProjectAction = "create" | "read" | "update" | "archive";
export type SiteAction = "create" | "read" | "update" | "archive";

/** The permission record of a project. */
export const projectRecord = (
  orgId: string,
  project: { readonly id: string; readonly createdBy: string },
): PermissionRecord => ({
  orgId,
  projectId: project.id,
  createdBy: project.createdBy,
});

/** The permission record of a site. */
export const siteRecord = (
  orgId: string,
  site: {
    readonly id: string;
    readonly projectId: string;
    readonly createdBy: string;
  },
): PermissionRecord => ({
  orgId,
  projectId: site.projectId,
  siteId: site.id,
  createdBy: site.createdBy,
});

/** Whether `identity` may `action` the project `record`. */
export function canProject(
  identity: Identity,
  action: ProjectAction,
  record: PermissionRecord,
): boolean {
  return can(abilityFor(identity), action, PROJECT_SUBJECT, record);
}

/** Whether `identity` may `action` the site `record`. */
export function canSite(
  identity: Identity,
  action: SiteAction,
  record: PermissionRecord,
): boolean {
  return can(abilityFor(identity), action, SITE_SUBJECT, record);
}

/** The filters a listed project must match one of; [] when none may be read. */
export function projectReadFilters(
  identity: Identity,
): readonly AccessFilter[] {
  const query = accessibleQuery(abilityFor(identity), "read", PROJECT_SUBJECT);
  return query.kind === "none" ? [] : query.filters;
}

/** The filters a listed site must match one of; [] when none may be read. */
export function siteReadFilters(identity: Identity): readonly AccessFilter[] {
  const query = accessibleQuery(abilityFor(identity), "read", SITE_SUBJECT);
  return query.kind === "none" ? [] : query.filters;
}
