// abilityFor(identity) (P4-09, ADR 0059; P5-02, ADR 0062, owner condition
// 1): the identity's ability, built from its grants alone. The auth guard
// takes the grants from the grants source (grants-source.ts): production
// reads them from the user's memberships in the request's org (P5-05, ADR
// 0066). There is no role-name path: an identity carries no roles. Deny
// by default, every grant pinned to the identity's org; ids
// that are not UUIDv7 and grants that are not valid are 403, never a 500.
// P5-07 (ADR 0068, D-I): the single builder, memoised per sealed (frozen)
// identity, so the authorization guard and the service of one request
// share one ability; an identity that is not frozen is built every time.
import { isOrgId, isUserId } from "@bricx/ids/branded";
import { type Ability, buildAbility } from "@bricx/permissions/ability";
import { PermissionError } from "@bricx/permissions/errors";
import type { Identity } from "../db/request-context.js";
import { ApiError } from "../errors/api-error.js";

const abilities = new WeakMap<Identity, Ability>();
const membershipAbilities = new WeakMap<Identity, Ability>();

export function abilityFor(identity: Identity): Ability {
  return memoised(abilities, identity, identity.grants);
}

/**
 * The ability from the identity's membership grants alone, without its
 * elevations (PR #71 review, amendment 3, ADR 0067): what grant() checks
 * a granter against, so an elevation never elevates someone else.
 */
export function membershipAbilityFor(identity: Identity): Ability {
  return memoised(membershipAbilities, identity, identity.membershipGrants);
}

/** The ability from `cache` when the identity is sealed, else a new one. */
function memoised(
  cache: WeakMap<Identity, Ability>,
  identity: Identity,
  grants: Identity["grants"],
): Ability {
  if (!Object.isFrozen(identity)) return abilityOf(identity, grants);
  const cached = cache.get(identity);
  if (cached !== undefined) return cached;
  const ability = abilityOf(identity, grants);
  cache.set(identity, ability);
  return ability;
}

function abilityOf(identity: Identity, grants: Identity["grants"]): Ability {
  const { orgId, userId } = identity;
  if (!isOrgId(orgId) || !isUserId(userId)) throw new ApiError("forbidden");
  try {
    return buildAbility(grants, { orgId, userId });
  } catch (error) {
    if (error instanceof PermissionError) throw new ApiError("forbidden");
    throw error;
  }
}
