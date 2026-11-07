// The memberships module's public API (CLAUDE.md rule 13): other modules
// and the CLIs import from here only.
export { MembershipsModule } from "./memberships.module.js";
export { MembershipsService, mfaRequiredOf } from "./memberships.service.js";
export { MembershipsRepository } from "./memberships.repository.js";
// P6-02 (ADR 0072, PD-2): an organisation's bootstrap moved to
// @bricx/db/organizations, shared by POST /v1/organizations, the
// membership:bootstrap CLI and the seed.
