// The audit module's public API (CLAUDE.md rule 13): other modules import
// from here only.
export { AuditModule } from "./audit.module.js";
export {
  AUDIT_LOCK_NAMESPACE,
  AuditService,
  type RecordedAuditEvent,
} from "./audit.service.js";
export { AuditContextError, AuditIsolationError } from "./audit-errors.js";
export {
  AuditEventError,
  type AuditEventInput,
  type AuditOriginInput,
} from "./audit-event.js";
export {
  type ChainBreak,
  type ChainResult,
  type VerifyOptions,
  verifyAuditChain,
} from "./audit-chain.js";
