// The invitations module's public API (CLAUDE.md rule 13): other modules
// and the app import from here only. The cascades (D14) live in
// @bricx/db/invitations, so the memberships, projects and organisations
// modules never import this one.
export {
  InvitationsModule,
  type InvitationsModuleOptions,
} from "./invitations.module.js";
export {
  INVITATIONS_ACTIVATE,
  INVITATIONS_SEND,
  INVITATION_SUBJECT,
  // P6-06c (ADR 0085): a bulk row runs the single invite's own checks.
  InvitationsService,
  type RowRefusal,
  type RowVerdict,
} from "./invitations.service.js";
export { type SystemKeyed, ownerRoleRefusal } from "./owner-role.js";
export {
  CreateInvitation,
  type CreateInvitationInput,
} from "./invitations.dto.js";
export {
  USERINFO_TIMEOUT_MS,
  type UserinfoAnswer,
  type UserinfoClient,
  UserinfoRefused,
  UserinfoUnavailable,
  createUserinfoClient,
} from "./userinfo.js";
