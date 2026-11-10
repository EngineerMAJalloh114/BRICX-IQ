// The invitation cascades' one entry point (P6-06, ADR 0077, D14): a
// member's removal, a project's archive and an organisation's archive
// revoke the pending invitations they end, in their own transaction,
// through @bricx/db/invitations' revokePendingInvitations. Each module
// provides it under this token (a fake in the unit suites), so none of
// them imports the invitations module (CLAUDE.md rule 13, no cycle).
import type { revokePendingInvitations } from "@bricx/db/invitations";

export type InvitationRevoker = typeof revokePendingInvitations;
export const INVITATION_REVOKER = Symbol("INVITATION_REVOKER");

/** The invitations module's audit subject, spelled once for the cascades. */
export const INVITATION_SUBJECT = "org.invitation";
