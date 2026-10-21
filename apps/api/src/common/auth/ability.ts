// abilityFor(identity) (P4-09, ADR 0059; P5-02, ADR 0062, owner condition
// 1): the identity's ability, built from its grants alone. The auth guard
// takes the grants from the grants source (grants-source.ts): production
// reads them from the user's memberships in the request's org (P5-05, ADR
// 0066). There is no role-name path: an identity carries no roles. Deny
// by default, every grant pinned to the identity's org; ids
// that are not UUIDv7 and grants that are not valid are 403, never a 500.
import { isOrgId, isUserId } from "@bricx/ids/branded";
import { type Ability, buildAbility } from "@bricx/permissions/ability";
import { PermissionError } from "@bricx/permissions/errors";
import type { Identity } from "../db/request-context.js";
import { ApiError } from "../errors/api-error.js";

export function abilityFor(identity: Identity): Ability {
  const { orgId, userId } = identity;
  if (!isOrgId(orgId) || !isUserId(userId)) throw new ApiError("forbidden");
  try {
    return buildAbility(identity.grants, { orgId, userId });
  } catch (error) {
    if (error instanceof PermissionError) throw new ApiError("forbidden");
    throw error;
  }
}
