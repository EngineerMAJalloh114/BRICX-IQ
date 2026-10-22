// The sessions module's public API (CLAUDE.md rule 13): other modules
// import from here only.
export { SessionsModule } from "./sessions.module.js";
export {
  type AuditRecorder,
  type SessionsActivePort,
  type SessionsOfDevicePort,
  type SessionsOfMemberPort,
  SessionsService,
  type TransactionRunner,
  requireIdentity,
} from "./sessions.service.js";
export {
  SESSIONS_REVOKED,
  SYNC_REVOKE,
  type SessionRevokeCause,
  type SessionRevoked,
  type SyncRevoke,
} from "./sessions.events.js";
