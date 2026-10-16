// AuditService's refusals (P4-05, ADR 0055). Codes, never values.

/** record() or verify ran without app.org_id and app.user_id (withTx sets them). */
export class AuditContextError extends Error {
  readonly code = "audit.no_tenant_context";
  constructor() {
    super("audit refused: no tenant context");
  }
}
Object.defineProperty(AuditContextError.prototype, "name", {
  value: "AuditContextError",
});

/**
 * record() ran in a REPEATABLE READ or SERIALIZABLE transaction (condition
 * 4). Its snapshot can predate the lock, so it would read a stale chain
 * head; only READ COMMITTED sees the head the lock's previous holder wrote.
 */
export class AuditIsolationError extends Error {
  readonly code = "audit.isolation_not_read_committed";
  constructor() {
    super("audit refused: the transaction is not READ COMMITTED");
  }
}
Object.defineProperty(AuditIsolationError.prototype, "name", {
  value: "AuditIsolationError",
});
