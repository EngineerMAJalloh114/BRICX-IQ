// AuditService's refusals (P4-05, ADR 0055). Codes, never values. Since
// P5-06 (ADR 0067, owner condition 4) they live with the recorder in
// @bricx/db/audit; this module re-exports them.
export { AuditContextError, AuditIsolationError } from "@bricx/db/audit";
