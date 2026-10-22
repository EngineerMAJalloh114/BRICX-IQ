// Memberships' policies (P5-05, ADR 0066; plan 3.2, 3.6): CASL checks
// from @bricx/permissions through can() over the identity's ability. Org
// memberships need org.member.read / invite / update / remove at org
// scope; project memberships need project.member.read / assign at org
// scope or at project scope on that project (the record names it). The
// caller's own rows (GET /v1/me/memberships) need no grant.
import { type Ability, can } from "@bricx/permissions/ability";
import { abilityFor } from "../../common/auth/ability.js";
import type { Identity } from "../../common/db/request-context.js";
import { ApiError } from "../../common/errors/api-error.js";

/** The catalogue subjects (@bricx/permissions). */
export const ORG_SUBJECT = "org.member";
export const PROJECT_SUBJECT = "project.member";
/**
 * The access-grants module's subject, for the events of the grants a
 * removal ends (PR #71 review, amendment 2); spelled here because that
 * module imports this one.
 */
export const ACCESS_GRANT_SUBJECT = "org.access_grant";

type OrgAction = "read" | "invite" | "update" | "remove";

/** The ability, after checking `identity` may `action` the org's members (403). */
export function assertCanOrg(identity: Identity, action: OrgAction): Ability {
  const ability = abilityFor(identity);
  if (!can(ability, action, ORG_SUBJECT, { orgId: identity.orgId })) {
    throw new ApiError("forbidden");
  }
  return ability;
}

/** The ability, after checking `identity` may `action` `projectId`'s members (403). */
export function assertCanProject(
  identity: Identity,
  action: "read" | "assign",
  projectId: string,
): Ability {
  const ability = abilityFor(identity);
  const record = { orgId: identity.orgId, projectId };
  if (!can(ability, action, PROJECT_SUBJECT, record)) {
    throw new ApiError("forbidden");
  }
  return ability;
}
