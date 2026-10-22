// The roles module's public API (CLAUDE.md rule 13): other modules import
// from here only.
export { RolesModule } from "./roles.module.js";
export {
  MAX_MFA_FANOUT,
  RolesService,
  financeChanged,
} from "./roles.service.js";
export { USERS_MFA_CHECK, type UsersMfaCheck } from "./roles.events.js";
export { type RoleRow, RolesRepository } from "./roles.repository.js";
