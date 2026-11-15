// Ownership transfers (P6-06c, ADR 0085): the statements both the API (the
// lazy expiry at the Clock) and the worker (the ownership.expire job and the
// memberships sweep) run, so an expiry is written one way.
// - expireOwnershipTransfer() settles a pending transfer whose expires_at is
//   at or before `now` as expired (settled_by stays NULL: nobody settled
//   it); otherwise it answers the row's state and changes nothing.
// - ownershipTransfersDue() is the sweep's cross-org read
//   (app.ownership_transfers_due(), SECURITY DEFINER, bricx_relay only).
// Errors carry a code, never a value.
import { sql } from "drizzle-orm";
import type { Tx } from "./tx.js";

export type OwnershipErrorCode =
  "invalid_id" | "invalid_instant" | "invalid_result";

export class OwnershipError extends Error {
  readonly code: OwnershipErrorCode;

  constructor(code: OwnershipErrorCode) {
    super(`ownership: ${code}`);
    this.code = code;
  }
}
Object.defineProperty(OwnershipError.prototype, "name", {
  value: "OwnershipError",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const checkId = (value: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new OwnershipError("invalid_id");
  }
  return value;
};
const checkInstant = (value: string): string => {
  if (typeof value !== "string" || !INSTANT.test(value)) {
    throw new OwnershipError("invalid_instant");
  }
  return value;
};
const str = (value: unknown): string => {
  if (typeof value !== "string") throw new OwnershipError("invalid_result");
  return value;
};

/** A transfer as its audit events carry it. */
export interface TransferRecord {
  readonly id: string;
  readonly orgId: string;
  readonly initiatedBy: string;
  readonly toUserId: string;
  readonly previousOwnerRoleId: string;
  readonly status: string;
  readonly expiresAt: string;
}

export type TransferExpireOutcome =
  | { readonly changed: true; readonly transfer: TransferRecord }
  | { readonly changed: false; readonly state: "early" | "settled" };

const RECORD = sql`id::text AS id, org_id::text AS org_id, initiated_by::text AS initiated_by,
  to_user_id::text AS to_user_id, previous_owner_role_id::text AS previous_owner_role_id, status,
  to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`;

export function transferRecordOf(row: Record<string, unknown>): TransferRecord {
  return {
    id: str(row.id),
    orgId: str(row.org_id),
    initiatedBy: str(row.initiated_by),
    toUserId: str(row.to_user_id),
    previousOwnerRoleId: str(row.previous_owner_role_id),
    status: str(row.status),
    expiresAt: str(row.expires_at),
  };
}

/** Expires transfer `id` when it is pending and due at `now`; undefined when the transaction sees no such row. */
export async function expireOwnershipTransfer(
  tx: Tx,
  id: string,
  now: string,
): Promise<TransferExpireOutcome | undefined> {
  const transferId = checkId(id);
  const at = checkInstant(now);
  const updated = await tx.execute(
    sql`UPDATE bricx.ownership_transfers
        SET status = 'expired', settled_at = ${at}::timestamptz,
            updated_at = GREATEST(updated_at, ${at}::timestamptz)
        WHERE id = ${transferId}::uuid AND status = 'pending'
          AND expires_at <= ${at}::timestamptz
        RETURNING ${RECORD}`,
  );
  const [row] = updated.rows;
  if (row !== undefined) {
    return { changed: true, transfer: transferRecordOf(row) };
  }
  const found = await tx.execute<{ status: unknown }>(
    sql`SELECT status FROM bricx.ownership_transfers WHERE id = ${transferId}::uuid`,
  );
  const [state] = found.rows;
  if (state === undefined) return undefined;
  return {
    changed: false,
    state: str(state.status) === "pending" ? "early" : "settled",
  };
}

/** A due transfer the sweep reads. */
export interface DueTransfer {
  readonly id: string;
  readonly orgId: string;
  readonly toUserId: string;
}

/** The sweep's limit's ceiling (the function caps at 100 too). */
export const MAX_DUE_TRANSFERS = 100;

/** Pending transfers past expires_at in every org (bricx_relay only). */
export async function ownershipTransfersDue(
  tx: Tx,
  limit: number,
): Promise<DueTransfer[]> {
  const n = Number.isSafeInteger(limit)
    ? Math.min(Math.max(limit, 0), MAX_DUE_TRANSFERS)
    : 0;
  const result = await tx.execute(
    sql`SELECT id::text AS id, org_id::text AS org_id, to_user_id::text AS to_user_id
        FROM app.ownership_transfers_due(${n}::integer)`,
  );
  return result.rows.map((row) => ({
    id: str(row.id),
    orgId: str(row.org_id),
    toUserId: str(row.to_user_id),
  }));
}

/** Why a cascade cancelled a transfer (the table's CHECK list, but manual). */
export type CascadeCause =
  "initiator_changed" | "recipient_changed" | "org_archived";

/**
 * Cancels the org's pending transfer in the caller's transaction (P6-06c,
 * ADR 0085, the cascades): with `userId`, only one naming that user as a
 * party (cause initiator_changed or recipient_changed, by their side);
 * without, the org's (cause org_archived). `by` is who made the change.
 * Answers what it cancelled, with the cause, for the caller's audit events.
 */
export async function cancelPendingTransfers(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly userId?: string | undefined;
    readonly by: string;
    readonly now: string;
  },
): Promise<(TransferRecord & { readonly cause: CascadeCause })[]> {
  const orgId = checkId(input.orgId);
  const by = checkId(input.by);
  const now = checkInstant(input.now);
  const userId = input.userId === undefined ? null : checkId(input.userId);
  const result = await tx.execute(
    sql`UPDATE bricx.ownership_transfers
        SET status = 'cancelled', settled_by = ${by}::uuid,
            settled_at = ${now}::timestamptz,
            updated_at = GREATEST(updated_at, ${now}::timestamptz),
            cancel_reason = CASE
              WHEN ${userId}::uuid IS NULL THEN 'org_archived'
              WHEN initiated_by = ${userId}::uuid THEN 'initiator_changed'
              ELSE 'recipient_changed' END
        WHERE org_id = ${orgId}::uuid AND status = 'pending'
          AND (${userId}::uuid IS NULL OR initiated_by = ${userId}::uuid
               OR to_user_id = ${userId}::uuid)
        RETURNING ${RECORD}, cancel_reason`,
  );
  return result.rows.map((row) => {
    const cause = str(row.cancel_reason);
    if (
      cause !== "initiator_changed" &&
      cause !== "recipient_changed" &&
      cause !== "org_archived"
    ) {
      throw new OwnershipError("invalid_result");
    }
    return { ...transferRecordOf(row), cause };
  });
}
