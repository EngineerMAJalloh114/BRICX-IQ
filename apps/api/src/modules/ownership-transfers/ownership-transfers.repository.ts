// Ownership transfers' statements (P6-06c, ADR 0085), all in the caller's
// TxRunner transaction (withTx: RLS scopes every row to the request's org).
// The table's guard trigger (ownership_transfers_guard, P606C) is the
// backstop for the service's checks: a transfer's terms never change, a
// settled row is final, only the recipient accepts a live one. The one
// pending row per org is the partial unique index ownership_transfers_pending
// (23505 -> 409 ownership.transfer_pending). The typed organisation name is
// compared in the service and never written.
import { type Tx, sqlstateOf } from "@bricx/db/database";
import { Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { ApiError } from "../../common/errors/api-error.js";
import {
  CANCEL_REASONS,
  type OwnershipTransferData,
  TRANSFER_STATUSES,
} from "./ownership-transfers.dto.js";

const UNIQUE_VIOLATION = "23505";
const OWNERSHIP_GUARD_VIOLATION = "P606C";

type Raw = Record<string, unknown>;

const str = (v: unknown): string => {
  if (typeof v !== "string") throw new TypeError("ownership: invalid row");
  return v;
};
const strOrNull = (v: unknown): string | null => (v === null ? null : str(v));

const STATUSES: ReadonlySet<string> = new Set(TRANSFER_STATUSES);
const REASONS: ReadonlySet<string> = new Set(CANCEL_REASONS);

const isStatus = (v: string): v is OwnershipTransferData["status"] =>
  STATUSES.has(v);
const isReason = (
  v: string,
): v is NonNullable<OwnershipTransferData["cancelReason"]> => REASONS.has(v);

function transferOf(row: Raw): OwnershipTransferData {
  const status = str(row.status);
  const reason = strOrNull(row.cancel_reason);
  if (!isStatus(status) || (reason !== null && !isReason(reason))) {
    throw new TypeError("ownership: invalid row");
  }
  return {
    id: str(row.id),
    status,
    initiatedBy: str(row.initiated_by),
    toUserId: str(row.to_user_id),
    previousOwnerRoleId: str(row.previous_owner_role_id),
    expiresAt: str(row.expires_at),
    createdAt: str(row.created_at),
    settledAt: strOrNull(row.settled_at),
    settledBy: strOrNull(row.settled_by),
    cancelReason: reason,
  };
}

const iso = (column: string) =>
  sql`to_char(${sql.identifier(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const COLUMNS = sql`id::text AS id, status, initiated_by::text AS initiated_by,
  to_user_id::text AS to_user_id,
  previous_owner_role_id::text AS previous_owner_role_id,
  ${iso("expires_at")} AS expires_at, ${iso("created_at")} AS created_at,
  ${iso("settled_at")} AS settled_at, settled_by::text AS settled_by,
  cancel_reason`;

/** The statuses a settlement writes. */
export type Settlement =
  | { readonly status: "accepted" | "declined"; readonly by: string }
  | { readonly status: "cancelled"; readonly by: string };

function refuse(error: unknown): never {
  const state = sqlstateOf(error);
  if (state === UNIQUE_VIOLATION) {
    throw new ApiError("ownership.transfer_pending");
  }
  if (state === OWNERSHIP_GUARD_VIOLATION) {
    throw new ApiError("request.conflict");
  }
  throw error;
}

@Injectable()
export class OwnershipTransfersRepository {
  /** The request's organisation's legal name (the typed-name check). */
  async legalName(tx: Tx, orgId: string): Promise<string | undefined> {
    const result = await tx.execute<Raw>(
      sql`SELECT legal_name FROM bricx.organizations WHERE id = ${orgId}::uuid`,
    );
    const name = result.rows[0]?.legal_name;
    return typeof name === "string" ? name : undefined;
  }

  /** The org's pending transfer, if any. */
  async pending(
    tx: Tx,
    orgId: string,
  ): Promise<OwnershipTransferData | undefined> {
    const result = await tx.execute<Raw>(
      sql`SELECT ${COLUMNS} FROM bricx.ownership_transfers
          WHERE org_id = ${orgId}::uuid AND status = 'pending'`,
    );
    const [row] = result.rows;
    return row === undefined ? undefined : transferOf(row);
  }

  /** Transfer `id` of the org, locked for the caller's transaction. */
  async findForUpdate(
    tx: Tx,
    orgId: string,
    id: string,
  ): Promise<OwnershipTransferData | undefined> {
    const result = await tx.execute<Raw>(
      sql`SELECT ${COLUMNS} FROM bricx.ownership_transfers
          WHERE org_id = ${orgId}::uuid AND id = ${id}::uuid FOR UPDATE`,
    );
    const [row] = result.rows;
    return row === undefined ? undefined : transferOf(row);
  }

  async insert(
    tx: Tx,
    input: {
      readonly id: string;
      readonly orgId: string;
      readonly initiatedBy: string;
      readonly toUserId: string;
      readonly previousOwnerRoleId: string;
      readonly expiresAt: string;
      readonly now: string;
    },
  ): Promise<OwnershipTransferData> {
    let rows: Raw[];
    try {
      rows = (
        await tx.execute<Raw>(
          sql`INSERT INTO bricx.ownership_transfers
                (id, org_id, initiated_by, to_user_id, previous_owner_role_id,
                 expires_at, created_at, updated_at)
              VALUES (${input.id}::uuid, ${input.orgId}::uuid,
                ${input.initiatedBy}::uuid, ${input.toUserId}::uuid,
                ${input.previousOwnerRoleId}::uuid,
                ${input.expiresAt}::timestamptz, ${input.now}::timestamptz,
                ${input.now}::timestamptz)
              RETURNING ${COLUMNS}`,
        )
      ).rows;
    } catch (error) {
      refuse(error);
    }
    const [row] = rows;
    if (row === undefined) throw new ApiError("request.conflict");
    return transferOf(row);
  }

  /** Settles pending transfer `id` (accepted, declined or cancelled manual). */
  async settle(
    tx: Tx,
    orgId: string,
    id: string,
    settlement: Settlement,
    now: string,
  ): Promise<OwnershipTransferData> {
    const reason = settlement.status === "cancelled" ? "manual" : null;
    let rows: Raw[];
    try {
      rows = (
        await tx.execute<Raw>(
          sql`UPDATE bricx.ownership_transfers
              SET status = ${settlement.status}, settled_by = ${settlement.by}::uuid,
                  settled_at = ${now}::timestamptz,
                  updated_at = GREATEST(updated_at, ${now}::timestamptz),
                  cancel_reason = ${reason}
              WHERE org_id = ${orgId}::uuid AND id = ${id}::uuid
                AND status = 'pending'
              RETURNING ${COLUMNS}`,
        )
      ).rows;
    } catch (error) {
      refuse(error);
    }
    const [row] = rows;
    if (row === undefined) throw new ApiError("request.conflict");
    return transferOf(row);
  }
}
