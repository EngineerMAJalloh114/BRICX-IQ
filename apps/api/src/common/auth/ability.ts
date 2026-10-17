// abilityFor(identity) (P4-09, ADR 0059, owner condition 5; for architect
// review). A STAND-IN, REPLACED IN P5: P5's auth guard builds the ability
// from the grants P5-05 stores per membership. Until then the identity's
// role names become @bricx/permissions role bundles: a known role (a
// ROLE_IDS entry, exact case) gives grantsForRole() over the identity's
// project ids; an unknown or empty role, or one whose bundle needs targets
// the identity cannot carry (site roles: sites arrive with P5), gives
// nothing. Deny by default, every grant pinned to the identity's org.
import { isOrgId, isUserId } from "@bricx/ids/branded";
import { isProjectId } from "@bricx/ids/branded";
import {
  type Ability,
  type Grant,
  buildAbility,
} from "@bricx/permissions/ability";
import { PermissionError } from "@bricx/permissions/errors";
import { ROLE_IDS, type RoleId, grantsForRole } from "@bricx/permissions/roles";
import type { Identity } from "../db/request-context.js";
import { ApiError } from "../errors/api-error.js";

const ROLES: ReadonlySet<string> = new Set(ROLE_IDS);
const isRoleId = (value: string): value is RoleId => ROLES.has(value);

/**
 * The ability of `identity`: the union of its known roles' bundles. Org or
 * user ids that are not UUIDv7 are ApiError("forbidden"), never a 500.
 */
export function abilityFor(identity: Identity): Ability {
  const { orgId, userId } = identity;
  if (!isOrgId(orgId) || !isUserId(userId)) throw new ApiError("forbidden");
  const projectIds = identity.projectIds.filter(isProjectId);
  const grants: Grant[] = [];
  for (const role of new Set(identity.roles)) {
    if (!isRoleId(role)) continue;
    try {
      grants.push(...grantsForRole(role, { projectIds }));
    } catch (error) {
      // A bundle the identity has no targets for grants nothing.
      if (error instanceof PermissionError) continue;
      throw error;
    }
  }
  return buildAbility(grants, { orgId, userId });
}
