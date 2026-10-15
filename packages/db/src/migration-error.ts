// Every way `migrate()` refuses or fails (P4-02, ADR 0052). The message is
// built from the code and the migration tag only, plus, for a failed
// statement, its position, SQLSTATE and the server's message (never the
// statement text, the URL or the driver's detail). P4-04 (ADR 0054) adds
// the RLS guard's two refusals, which also name the table or function from
// the catalog.

export type MigrationErrorCode =
  // The migrations folder (checked before connecting).
  | "journal_missing"
  | "journal_invalid"
  | "journal_order"
  | "migration_file_missing"
  | "migration_file_unlisted"
  | "migration_too_large"
  // The database.
  | "database_unavailable"
  // The server rejected a query outside a migration (e.g. a permission).
  | "database_error"
  | "wrong_role"
  | "missing_schema"
  // Applied history must never change.
  | "applied_migration_removed"
  | "applied_migration_reordered"
  | "applied_migration_changed"
  | "gap_fill"
  // A statement failed; its migration was rolled back.
  | "migration_failed"
  // The RLS guard (P4-04): the migration was rolled back.
  | "tenant_rls_missing"
  | "definer_search_path";

export interface MigrationErrorDetail {
  /** The journal tag, e.g. 0003_add_projects. */
  readonly tag?: string;
  /** 1-based position of the failed statement in its migration. */
  readonly statement?: number;
  readonly sqlState?: string;
  readonly serverMessage?: string;
  /** The table or function the RLS guard refused (schema-qualified). */
  readonly relation?: string;
}

export class MigrationError extends Error {
  readonly code: MigrationErrorCode;
  readonly tag: string | undefined;
  readonly statement: number | undefined;
  readonly sqlState: string | undefined;
  readonly serverMessage: string | undefined;
  readonly relation: string | undefined;

  constructor(code: MigrationErrorCode, detail: MigrationErrorDetail = {}) {
    super(
      code === "migration_failed"
        ? `migration failed: ${detail.tag ?? "?"}, statement ${String(detail.statement ?? "?")}: ${detail.sqlState ?? "?"} ${detail.serverMessage ?? ""}`.trimEnd()
        : code === "database_error"
          ? `database error: ${detail.sqlState ?? "?"} ${detail.serverMessage ?? ""}`.trimEnd()
          : `migration refused: ${code}${detail.tag === undefined ? "" : ` (${detail.tag})`}${detail.relation === undefined ? "" : `: ${detail.relation}`}`,
    );
    this.code = code;
    this.tag = detail.tag;
    this.statement = detail.statement;
    this.sqlState = detail.sqlState;
    this.serverMessage = detail.serverMessage;
    this.relation = detail.relation;
  }
}
Object.defineProperty(MigrationError.prototype, "name", {
  value: "MigrationError",
});
