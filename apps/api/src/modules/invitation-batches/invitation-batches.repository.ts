// Bulk invitations' statements in the API (P6-06c, ADR 0085), all in the
// caller's TxRunner transaction (withTx: RLS scopes every row to the
// request's org). The settle and finish statements are @bricx/db's
// (invitation-batches.ts), shared with the worker. Addresses are written
// here once, on the pending rows, and never read back by the API.
// - One queued or running batch per org: the partial unique index
//   invitation_batches_running (23505 -> 409 invitation.bulk_running).
// - The quota (K4): the rows of the org's batches created in the last
//   24 h of the Clock, refused rows included (row_count).
// - lock(): the org's batch lock, so the purge, the running check and the
//   quota read and the insert are one step per org.
import { type Tx, sqlstateOf } from "@bricx/db/database";
import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { ApiError } from "../../common/errors/api-error.js";
import {
  BATCH_ROW_ERRORS,
  BATCH_ROW_STATUSES,
  BATCH_STATUSES,
  type BatchRowData,
  type InvitationBatchData,
} from "./invitation-batches.dto.js";

const UNIQUE_VIOLATION = "23505";
const BATCH_GUARD_VIOLATION = "P606D";
/** The advisory lock namespace of a batch submit (hashtext of the table). */
const LOCK_KEY = "bricx.invitation_batches";

type Raw = Record<string, unknown>;

const str = (v: unknown): string => {
  if (typeof v !== "string") throw new TypeError("batches: invalid row");
  return v;
};
const strOrNull = (v: unknown): string | null => (v === null ? null : str(v));
const int = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) {
    throw new TypeError("batches: invalid row");
  }
  return n;
};
const oneOf = <T extends string>(list: readonly T[], v: unknown): T => {
  const found = list.find((entry) => entry === v);
  if (found === undefined) throw new TypeError("batches: invalid row");
  return found;
};

const iso = (column: string) =>
  sql`to_char(${sql.identifier(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const BATCH_COLUMNS = sql`id::text AS id, status, created_by::text AS created_by,
  row_count, created_count, failed_count,
  ${iso("created_at")} AS created_at, ${iso("updated_at")} AS updated_at`;

function batchOf(row: Raw): InvitationBatchData {
  return {
    id: str(row.id),
    status: oneOf(BATCH_STATUSES, row.status),
    createdBy: str(row.created_by),
    rowCount: int(row.row_count),
    createdCount: int(row.created_count),
    failedCount: int(row.failed_count),
    createdAt: str(row.created_at),
    updatedAt: str(row.updated_at),
  };
}

/** A row as submitted: pending with its inputs, or failed with only its code. */
export type NewBatchRow =
  | {
      readonly rowNo: number;
      readonly status: "pending";
      readonly email: string;
      readonly roleId: string;
      readonly projectId: string | null;
      readonly projectRoleId: string | null;
      readonly external: boolean;
      readonly membershipExpiresAt: string | null;
    }
  | {
      readonly rowNo: number;
      readonly status: "failed";
      readonly errorCode: (typeof BATCH_ROW_ERRORS)[number];
    };

@Injectable()
export class InvitationBatchesRepository {
  /** The org's batch lock (held to the transaction's end). */
  async lock(tx: Tx, orgId: string): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${LOCK_KEY}), hashtext(${orgId}))`,
    );
  }

  async find(
    tx: Tx,
    orgId: string,
    id: string,
  ): Promise<InvitationBatchData | undefined> {
    const result = await tx.execute<Raw>(
      sql`SELECT ${BATCH_COLUMNS} FROM bricx.invitation_batches
          WHERE org_id = ${orgId}::uuid AND id = ${id}::uuid`,
    );
    const [row] = result.rows;
    return row === undefined ? undefined : batchOf(row);
  }

  /** The org's queued or running batch, if any. */
  async open(tx: Tx, orgId: string): Promise<InvitationBatchData | undefined> {
    const result = await tx.execute<Raw>(
      sql`SELECT ${BATCH_COLUMNS} FROM bricx.invitation_batches
          WHERE org_id = ${orgId}::uuid AND status IN ('queued', 'running')`,
    );
    const [row] = result.rows;
    return row === undefined ? undefined : batchOf(row);
  }

  /** Rows the org's batches created after `since` carried (the quota). */
  async rowsSince(tx: Tx, orgId: string, since: string): Promise<number> {
    const result = await tx.execute<Raw>(
      sql`SELECT coalesce(sum(row_count), 0)::int AS n FROM bricx.invitation_batches
          WHERE org_id = ${orgId}::uuid AND created_at > ${since}::timestamptz`,
    );
    return int(result.rows[0]?.n ?? 0);
  }

  /** The batch and its rows; refused rows keep only their code. */
  async insert(
    tx: Tx,
    input: {
      readonly id: string;
      readonly orgId: string;
      readonly createdBy: string;
      readonly rows: readonly NewBatchRow[];
      readonly now: string;
    },
  ): Promise<void> {
    const failed = input.rows.filter((row) => row.status === "failed").length;
    try {
      await tx.execute(
        sql`INSERT INTO bricx.invitation_batches
              (id, org_id, created_by, row_count, failed_count, created_at, updated_at)
            VALUES (${input.id}::uuid, ${input.orgId}::uuid, ${input.createdBy}::uuid,
              ${input.rows.length}::integer, ${failed}::integer,
              ${input.now}::timestamptz, ${input.now}::timestamptz)`,
      );
      const values = input.rows.map((row) =>
        row.status === "pending"
          ? sql`(${input.orgId}::uuid, ${input.id}::uuid, ${row.rowNo}::smallint,
                 ${row.email}, ${row.roleId}::uuid, ${row.projectId}::uuid,
                 ${row.projectRoleId}::uuid, ${row.external},
                 ${row.membershipExpiresAt}::timestamptz, 'pending', NULL,
                 ${input.now}::timestamptz)`
          : sql`(${input.orgId}::uuid, ${input.id}::uuid, ${row.rowNo}::smallint,
                 NULL, NULL, NULL, NULL, false, NULL, 'failed', ${row.errorCode},
                 ${input.now}::timestamptz)`,
      );
      await tx.execute(
        sql`INSERT INTO bricx.invitation_batch_rows
              (org_id, batch_id, row_no, email_normalised, role_id, project_id,
               project_role_id, is_external, membership_expires_at, status,
               error_code, updated_at)
            VALUES ${sql.join(values, sql`, `)}`,
      );
    } catch (error) {
      const state = sqlstateOf(error);
      if (state === UNIQUE_VIOLATION) {
        throw new ApiError("invitation.bulk_running");
      }
      if (state === BATCH_GUARD_VIOLATION) {
        throw new ApiError("request.conflict");
      }
      throw error;
    }
  }

  /** The batch's rows after `afterRowNo`, by number, at most `limit`. */
  async rows(
    tx: Tx,
    orgId: string,
    batchId: string,
    afterRowNo: number,
    limit: number,
  ): Promise<BatchRowData[]> {
    const result = await tx.execute<Raw>(
      sql`SELECT row_no, status, error_code, invitation_id::text AS invitation_id
          FROM bricx.invitation_batch_rows
          WHERE org_id = ${orgId}::uuid AND batch_id = ${batchId}::uuid
            AND row_no > ${afterRowNo}::smallint
          ORDER BY row_no LIMIT ${limit}::integer`,
    );
    return result.rows.map((row) => ({
      rowNo: int(row.row_no),
      status: oneOf(BATCH_ROW_STATUSES, row.status),
      errorCode:
        row.error_code === null
          ? null
          : oneOf(BATCH_ROW_ERRORS, row.error_code),
      invitationId: strOrNull(row.invitation_id),
    }));
  }
}
