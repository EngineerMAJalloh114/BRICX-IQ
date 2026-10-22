// Access grants' policies (P5-06, ADR 0067, D-A): CASL checks from
// @bricx/permissions through can() over the identity's ability.
// org.access_grant.read / grant / revoke at org scope; the caller's own
// rows (GET /v1/me/access-grants) need no grant. Whether the granter
// holds the key they elevate is the service's holdsAll() check, not a
// policy.
import { type Ability, can } from "@bricx/permissions/ability";
import { abilityFor } from "../../common/auth/ability.js";
import type { Identity } from "../../common/db/request-context.js";
import { ApiError } from "../../common/errors/api-error.js";

/** The catalogue subject (@bricx/permissions). */
export const SUBJECT = "org.access_grant";

export type AccessGrantAction = "read" | "grant" | "revoke";

/** The ability, after checking `identity` may `action` the org's grants (403). */
export function assertCan(
  identity: Identity,
  action: AccessGrantAction,
): Ability {
  const ability = abilityFor(identity);
  if (!can(ability, action, SUBJECT, { orgId: identity.orgId })) {
    throw new ApiError("forbidden");
  }
  return ability;
}
