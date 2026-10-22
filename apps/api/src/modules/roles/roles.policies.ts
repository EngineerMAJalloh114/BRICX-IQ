// Roles' policies (P5-05, ADR 0066): CASL checks from @bricx/permissions
// through can() over the identity's ability. Reading needs
// org.role.read.org, every change org.role.manage.org (both org scope
// only: a project-scope editor cannot touch org roles), and a change may
// grant only keys the editor holds at org scope (holdsAll, plan 3.2).
import { type Ability, can } from "@bricx/permissions/ability";
import { abilityFor } from "../../common/auth/ability.js";
import type { Identity } from "../../common/db/request-context.js";
import { ApiError } from "../../common/errors/api-error.js";

/** The catalogue subject (@bricx/permissions). */
export const SUBJECT = "org.role";

/** Throws ApiError("forbidden") unless `identity` may read the org's roles. */
export function assertCanRead(identity: Identity): void {
  if (!can(abilityFor(identity), "read", SUBJECT, { orgId: identity.orgId })) {
    throw new ApiError("forbidden");
  }
}

/** The ability, after checking `identity` may manage the org's roles (403). */
export function assertCanManage(identity: Identity): Ability {
  const ability = abilityFor(identity);
  if (!can(ability, "manage", SUBJECT, { orgId: identity.orgId })) {
    throw new ApiError("forbidden");
  }
  return ability;
}
