// Sessions' policies (P5-03, ADR 0063): CASL checks from @bricx/permissions
// through can(), over the identity's ability. Own sessions need no grant
// (the own-row policies and the user_id filter in the repository); the
// administrator routes need org.session.read.org / org.session.revoke.org,
// held through an org role's bundle (P5-05, ADR 0066: owner and auditor
// by default).
import { can } from "@bricx/permissions/ability";
import { abilityFor } from "../../common/auth/ability.js";
import type { Identity } from "../../common/db/request-context.js";
import { ApiError } from "../../common/errors/api-error.js";

/** The catalogue subject (@bricx/permissions, P5-03). */
export const SUBJECT = "org.session";

/** Throws ApiError("forbidden") unless `identity` may read the org's sessions. */
export function assertCanReadOrg(identity: Identity): void {
  if (!can(abilityFor(identity), "read", SUBJECT, { orgId: identity.orgId })) {
    throw new ApiError("forbidden");
  }
}

/** Throws ApiError("forbidden") unless `identity` may revoke the org's sessions. */
export function assertCanRevokeOrg(identity: Identity): void {
  if (
    !can(abilityFor(identity), "revoke", SUBJECT, { orgId: identity.orgId })
  ) {
    throw new ApiError("forbidden");
  }
}
