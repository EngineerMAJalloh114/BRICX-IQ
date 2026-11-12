// The memberships module's public API (CLAUDE.md rule 13): other modules
// and the CLIs import from here only.
export { MembershipsModule } from "./memberships.module.js";
export { MembershipsService, mfaRequiredOf } from "./memberships.service.js";
export { MembershipsRepository } from "./memberships.repository.js";
// P6-06b (ADR 0084): the instant schema and the temporary-membership
// bounds the invitations module shares.
export {
  InstantSchema,
  MAX_MEMBERSHIP_MS,
  MIN_MEMBERSHIP_MS,
} from "./memberships.dto.js";
// P6-02 (ADR 0072, PD-2): an organisation's bootstrap moved to
// @bricx/db/organizations, shared by POST /v1/organizations, the
// membership:bootstrap CLI and the seed.
