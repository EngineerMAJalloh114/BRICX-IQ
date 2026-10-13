// Branded id types (P3-01): each is a UuidV7 checked by the same strict
// parser, and no brand is assignable to another. The ROADMAP names
// ProjectId; the P3-01 ruling adds OrgId, UserId and SiteId.
import type { Brand } from "./brand.js";
import { isUuidV7, parseUuidV7, safeParseUuidV7 } from "./uuid-v7.js";
import type { IdParseResult, UuidV7 } from "./uuid-v7.js";

export type { Brand } from "./brand.js";

export type OrgId = Brand<UuidV7, "OrgId">;
export type UserId = Brand<UuidV7, "UserId">;
export type ProjectId = Brand<UuidV7, "ProjectId">;
export type SiteId = Brand<UuidV7, "SiteId">;

export const parseOrgId = (input: unknown): OrgId =>
  parseUuidV7(input) as OrgId;
export const safeParseOrgId = (input: unknown): IdParseResult<OrgId> =>
  safeParseUuidV7(input) as IdParseResult<OrgId>;
export const isOrgId = (input: unknown): input is OrgId => isUuidV7(input);
export const toOrgId = (id: UuidV7): OrgId => id as OrgId;

export const parseUserId = (input: unknown): UserId =>
  parseUuidV7(input) as UserId;
export const safeParseUserId = (input: unknown): IdParseResult<UserId> =>
  safeParseUuidV7(input) as IdParseResult<UserId>;
export const isUserId = (input: unknown): input is UserId => isUuidV7(input);
export const toUserId = (id: UuidV7): UserId => id as UserId;

export const parseProjectId = (input: unknown): ProjectId =>
  parseUuidV7(input) as ProjectId;
export const safeParseProjectId = (input: unknown): IdParseResult<ProjectId> =>
  safeParseUuidV7(input) as IdParseResult<ProjectId>;
export const isProjectId = (input: unknown): input is ProjectId =>
  isUuidV7(input);
export const toProjectId = (id: UuidV7): ProjectId => id as ProjectId;

export const parseSiteId = (input: unknown): SiteId =>
  parseUuidV7(input) as SiteId;
export const safeParseSiteId = (input: unknown): IdParseResult<SiteId> =>
  safeParseUuidV7(input) as IdParseResult<SiteId>;
export const isSiteId = (input: unknown): input is SiteId => isUuidV7(input);
export const toSiteId = (id: UuidV7): SiteId => id as SiteId;
