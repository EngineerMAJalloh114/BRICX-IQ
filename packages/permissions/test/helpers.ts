// Fixed ids and records for the tests. Every id is a valid lowercase
// UUIDv7 made from a counter, so tests never read a clock or randomness.
import {
  parseOrgId,
  parseProjectId,
  parseSiteId,
  parseUserId,
} from "@bricx/ids/branded";
import type { OrgId, ProjectId, SiteId, UserId } from "@bricx/ids/branded";
import type { AbilityContext, PermissionRecord } from "../src/ability.ts";

/** The n-th test UUIDv7 (version 7, variant 10, lowercase). */
export const uuid = (n: number): string =>
  `0190a000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

export const ORG_A: OrgId = parseOrgId(uuid(1));
export const ORG_B: OrgId = parseOrgId(uuid(2));
export const USER: UserId = parseUserId(uuid(10));
export const OTHER_USER: UserId = parseUserId(uuid(11));
export const PROJECT_1: ProjectId = parseProjectId(uuid(20));
export const PROJECT_2: ProjectId = parseProjectId(uuid(21));
export const SITE_1: SiteId = parseSiteId(uuid(30));
export const SITE_2: SiteId = parseSiteId(uuid(31));

export const CONTEXT: AbilityContext = { orgId: ORG_A, userId: USER };

/** A record in org A, project 1, site 1, created by USER. */
export const IN_SCOPE: PermissionRecord = {
  orgId: ORG_A,
  projectId: PROJECT_1,
  siteId: SITE_1,
  createdBy: USER,
};

/** A record in org A but project 2, site 2, created by someone else. */
export const OTHER_PROJECT: PermissionRecord = {
  orgId: ORG_A,
  projectId: PROJECT_2,
  siteId: SITE_2,
  createdBy: OTHER_USER,
};

/** The same shape in org B. */
export const OTHER_ORG: PermissionRecord = {
  orgId: ORG_B,
  projectId: PROJECT_1,
  siteId: SITE_1,
  createdBy: USER,
};

export const TARGETS = { projectIds: [PROJECT_1], siteIds: [SITE_1] } as const;
