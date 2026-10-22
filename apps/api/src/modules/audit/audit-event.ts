// What AuditService.record() accepts (P4-05, ADR 0055). Since P5-06 (ADR
// 0067, owner condition 4) the validators live with the recorder in
// @bricx/db/audit, shared with the worker's expiry consumer; this module
// re-exports them under their P4-05 names.
export {
  AuditEventError,
  type AuditEventField,
  type AuditEventInput,
  type AuditGeo,
  type AuditOriginInput,
  MAX_JSON_BYTES,
  MAX_JSON_DEPTH,
  type ValidAuditEvent,
  type ValidAuditOrigin,
  isAuditJson,
  validateAuditEvent,
  validateOrigin,
} from "@bricx/db/audit";
