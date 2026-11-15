// Bulk invitation batches (P6-06c, ADR 0085; owner condition C5, plan K3):
// the statements the bulk consumer, its sweep and the API's lazy purge run.
// - A row is pending with its address until it settles: created (with its
//   invitation id) or failed (with a code); the address becomes NULL in
//   the same UPDATE (a CHECK and the guard trigger require it).
// - finishBatch() closes a batch once: done, with the counts of its rows.
// - staleBatches() is the sweep's cross-org read
//   (app.invitation_batches_stale(), bricx_relay only).
// The address never leaves these statements but through pendingBatchRows()
// to the consumer's own insert. Errors carry a code, never a value.
import { INVITATION_TTL_HOURS } from "@bricx/domain/limits";
import { sql } from "drizzle-orm";
import { readInvitationTtlHours } from "./region-configs.js";
import type { Tx } from "./tx.js";

export type BatchErrorCode =
  "invalid_id" | "invalid_instant" | "invalid_code" | "invalid_result";

export class BatchError extends Error {
  readonly code: BatchErrorCode;

  constructor(code: BatchErrorCode) {
    super(`invitation batch: ${code}`);
    this.code = code;
  }
}
Object.defineProperty(BatchError.prototype, "name", { value: "BatchError" });

/** Why a row failed (the table's CHECK list). */
export const BATCH_ROW_ERROR_CODES = Object.freeze([
  "validation_failed",
  "not_found",
  "conflict",
  "escalation",
  "owner_role",
  "project_archived",
  "pending_exists",
  "inviter_inactive",
  "org_archived",
  "not_processed",
] as const);
export type BatchRowErrorCode = (typeof BATCH_ROW_ERROR_CODES)[number];

/** A batch's pending rows older than this are settled not_processed (K3). */
export const BATCH_PURGE_AFTER_MS = 3_600_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const CODES: ReadonlySet<string> = new Set(BATCH_ROW_ERROR_CODES);
const checkId = (value: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new BatchError("invalid_id");
  }
  return value;
};
const checkInstant = (value: string): string => {
  if (typeof value !== "string" || !INSTANT.test(value)) {
    throw new BatchError("invalid_instant");
  }
  return value;
};
const checkCode = (value: string): BatchRowErrorCode => {
  if (!CODES.has(value)) throw new BatchError("invalid_code");
  return value as BatchRowErrorCode;
};
const str = (value: unknown): string => {
  if (typeof value !== "string") throw new BatchError("invalid_result");
  return value;
};
const strOrNull = (value: unknown): string | null =>
  value === null ? null : str(value);
const int = (value: unknown): number => {
  const n = typeof value === "string" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) {
    throw new BatchError("invalid_result");
  }
  return n;
};

export interface BatchState {
  readonly id: string;
  readonly orgId: string;
  readonly createdBy: string;
  readonly status: "queued" | "running" | "done";
  readonly createdAt: string;
}

/** The batch, as the transaction sees it (RLS: its org only). */
export async function readBatch(
  tx: Tx,
  id: string,
): Promise<BatchState | undefined> {
  const result = await tx.execute(
    sql`SELECT id::text AS id, org_id::text AS org_id, created_by::text AS created_by, status,
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
        FROM bricx.invitation_batches WHERE id = ${checkId(id)}::uuid`,
  );
  const [row] = result.rows;
  if (row === undefined) return undefined;
  const status = str(row.status);
  if (status !== "queued" && status !== "running" && status !== "done") {
    throw new BatchError("invalid_result");
  }
  return {
    id: str(row.id),
    orgId: str(row.org_id),
    createdBy: str(row.created_by),
    status,
    createdAt: str(row.created_at),
  };
}

/** queued -> running (once); false when it was not queued. */
export async function startBatch(
  tx: Tx,
  id: string,
  now: string,
): Promise<boolean> {
  const result = await tx.execute(
    sql`UPDATE bricx.invitation_batches SET status = 'running',
          updated_at = GREATEST(updated_at, ${checkInstant(now)}::timestamptz)
        WHERE id = ${checkId(id)}::uuid AND status = 'queued'`,
  );
  return (result.rowCount ?? 0) === 1;
}

/** A pending row: what the single invite's insert needs. */
export interface PendingBatchRow {
  readonly rowNo: number;
  readonly email: string;
  readonly roleId: string;
  readonly projectId: string | null;
  readonly projectRoleId: string | null;
  readonly external: boolean;
  readonly membershipExpiresAt: string | null;
}

/** The batch's pending rows in order, at most `limit`, each locked (SKIP LOCKED: a concurrent run takes others). */
export async function pendingBatchRows(
  tx: Tx,
  batchId: string,
  limit: number,
): Promise<PendingBatchRow[]> {
  const n = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 0), 200) : 0;
  const result = await tx.execute(
    sql`SELECT row_no, email_normalised, role_id::text AS role_id, project_id::text AS project_id,
          project_role_id::text AS project_role_id, is_external,
          to_char(membership_expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS membership_expires_at
        FROM bricx.invitation_batch_rows
        WHERE batch_id = ${checkId(batchId)}::uuid AND status = 'pending'
        ORDER BY row_no LIMIT ${n}::integer
        FOR UPDATE SKIP LOCKED`,
  );
  return result.rows.map((row) => ({
    rowNo: int(row.row_no),
    email: str(row.email_normalised),
    roleId: str(row.role_id),
    projectId: strOrNull(row.project_id),
    projectRoleId: strOrNull(row.project_role_id),
    external: row.is_external === true,
    membershipExpiresAt: strOrNull(row.membership_expires_at),
  }));
}

/** Settles one pending row (created or failed) and clears its address; false when it was not pending. */
export async function settleBatchRow(
  tx: Tx,
  input: {
    readonly batchId: string;
    readonly rowNo: number;
    readonly now: string;
  } & (
    | { readonly invitationId: string; readonly errorCode?: undefined }
    | {
        readonly errorCode: BatchRowErrorCode;
        readonly invitationId?: undefined;
      }
  ),
): Promise<boolean> {
  const batchId = checkId(input.batchId);
  const now = checkInstant(input.now);
  if (!Number.isSafeInteger(input.rowNo)) throw new BatchError("invalid_id");
  const invitationId =
    input.invitationId === undefined ? null : checkId(input.invitationId);
  const errorCode =
    input.errorCode === undefined ? null : checkCode(input.errorCode);
  const result = await tx.execute(
    sql`UPDATE bricx.invitation_batch_rows
        SET status = ${invitationId === null ? "failed" : "created"},
            invitation_id = ${invitationId}::uuid, error_code = ${errorCode},
            email_normalised = NULL,
            updated_at = GREATEST(updated_at, ${now}::timestamptz)
        WHERE batch_id = ${batchId}::uuid AND row_no = ${input.rowNo}::smallint
          AND status = 'pending'`,
  );
  return (result.rowCount ?? 0) === 1;
}

/** Fails every pending row of the batch with `code` (addresses cleared); the count. */
export async function failPendingRows(
  tx: Tx,
  batchId: string,
  code: BatchRowErrorCode,
  now: string,
): Promise<number> {
  const result = await tx.execute(
    sql`UPDATE bricx.invitation_batch_rows
        SET status = 'failed', error_code = ${checkCode(code)}, email_normalised = NULL,
            updated_at = GREATEST(updated_at, ${checkInstant(now)}::timestamptz)
        WHERE batch_id = ${checkId(batchId)}::uuid AND status = 'pending'`,
  );
  return result.rowCount ?? 0;
}

export interface BatchCounts {
  readonly created: number;
  readonly failed: number;
}

/**
 * Closes the batch: done, with its rows' counts. undefined when it was
 * done already or still has a pending row (nothing written).
 */
export async function finishBatch(
  tx: Tx,
  batchId: string,
  now: string,
): Promise<BatchCounts | undefined> {
  const result = await tx.execute(
    sql`WITH counts AS (
          SELECT count(*) FILTER (WHERE status = 'created') AS created,
                 count(*) FILTER (WHERE status = 'failed') AS failed,
                 count(*) FILTER (WHERE status = 'pending') AS pending
          FROM bricx.invitation_batch_rows WHERE batch_id = ${checkId(batchId)}::uuid)
        UPDATE bricx.invitation_batches b
        SET status = 'done', created_count = counts.created, failed_count = counts.failed,
            updated_at = GREATEST(b.updated_at, ${checkInstant(now)}::timestamptz)
        FROM counts
        WHERE b.id = ${batchId}::uuid AND b.status <> 'done' AND counts.pending = 0
        RETURNING b.created_count, b.failed_count`,
  );
  const [row] = result.rows;
  if (row === undefined) return undefined;
  return { created: int(row.created_count), failed: int(row.failed_count) };
}

/** A batch the sweep settles. */
export interface StaleBatch {
  readonly id: string;
  readonly orgId: string;
  readonly createdBy: string;
}

/** Batches still queued or running an hour after creation, every org (bricx_relay only). */
export async function staleBatches(
  tx: Tx,
  limit: number,
): Promise<StaleBatch[]> {
  const n = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 0), 100) : 0;
  const result = await tx.execute(
    sql`SELECT id::text AS id, org_id::text AS org_id, created_by::text AS created_by
        FROM app.invitation_batches_stale(${n}::integer)`,
  );
  return result.rows.map((row) => ({
    id: str(row.id),
    orgId: str(row.org_id),
    createdBy: str(row.created_by),
  }));
}

/** Whether a batch's author may still invite at the run (S17). */
export type BatchInviterState = "active" | "inactive" | "org_archived";

/**
 * The org and the author at `now`: org_archived when the org is
 * archived; inactive unless the author has an open, unsuspended,
 * unexpired membership in it; else active. Their keys are not re-read
 * (K5: a demoted inviter's invitation is refused at accept).
 */
export async function batchInviterState(
  tx: Tx,
  orgId: string,
  userId: string,
  now: string,
): Promise<BatchInviterState> {
  const result = await tx.execute(
    sql`SELECT
          (SELECT archived_at IS NOT NULL FROM bricx.organizations
           WHERE id = ${checkId(orgId)}::uuid) AS archived,
          EXISTS (SELECT 1 FROM bricx.memberships
                  WHERE org_id = ${orgId}::uuid AND user_id = ${checkId(userId)}::uuid
                    AND removed_at IS NULL AND suspended_at IS NULL
                    AND (expires_at IS NULL OR expires_at > ${checkInstant(now)}::timestamptz)) AS active`,
  );
  const [row] = result.rows;
  if (row?.archived !== false) return "org_archived";
  return row.active === true ? "active" : "inactive";
}

/** A new invitation's expires_at: the org's lifetime (else the default 72 h) after `now`. */
export async function batchInvitationExpiresAt(
  tx: Tx,
  orgId: string,
  now: string,
): Promise<string> {
  const hours =
    (await readInvitationTtlHours(tx, checkId(orgId))) ??
    INVITATION_TTL_HOURS.default;
  return new Date(
    Date.parse(checkInstant(now)) + hours * 3_600_000,
  ).toISOString();
}
