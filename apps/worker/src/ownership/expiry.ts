// The expiry of an ownership transfer (P6-06c, ADR 0085; the P6-06b
// pattern of apps/worker/src/memberships/expiry.ts). ONE withTx() as
// bricx_app in the transfer's org, as its recipient (the context only
// feeds RLS):
// 1. expireOwnershipTransfer() (@bricx/db/ownership, the statement the
//    API's lazy expiry runs too): a pending transfer past expires_at (the
//    worker's Clock) becomes expired; otherwise its state and no change
//    (early: the job came before expires_at; settled: accepted, declined,
//    cancelled or expired already);
// 2. when it changed: org.ownership_transfer.expire as actor `system`
//    (correlation = the outbox id, or sweep.<transfer id>) and one
//    users.mfa_check for the recipient (app.mfa_state v4 no longer counts
//    the transfer).
// All or nothing: a transfer is expired once and audited once, whoever
// gets there first (the job, the sweep or a start in the API).
// The sweep's cross-org read is the memberships module's due.ts
// (dueOwnershipReader, re-exported here: withRelayTx stays in the
// folders Semgrep allows).
import { type AuditRecorderOptions, recordAuditEvent } from "@bricx/db/audit";
import type { Tx, TxContext } from "@bricx/db/database";
import { insertOutbox } from "@bricx/db/outbox";
import {
  type DueTransfer,
  type TransferExpireOutcome,
  expireOwnershipTransfer,
} from "@bricx/db/ownership";
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";

export { dueOwnershipReader } from "../memberships/due.js";
export type { DueOwnershipReader } from "../memberships/due.js";

export const OWNERSHIP_EXPIRE = "ownership.expire";
export const OWNERSHIP_TRANSFER_SUBJECT = "org.ownership_transfer";
export const USERS_MFA_CHECK = "users.mfa_check";

/** An expire job that ran before its transfer was due: retried, never completed. */
export class OwnershipNotDueError extends Error {
  readonly code = "ownership.expire_not_due";

  constructor() {
    super("ownership transfer not due");
  }
}
Object.defineProperty(OwnershipNotDueError.prototype, "name", {
  value: "OwnershipNotDueError",
});

export interface OwnershipExpirer {
  /** Expires `transfer` when it is due; undefined when the transaction sees no such row. */
  expire(
    transfer: DueTransfer,
    correlationId: string,
  ): Promise<TransferExpireOutcome | undefined>;
}

export interface OwnershipExpirerOptions {
  /** The bricx_app pool (DATABASE_URL). */
  readonly database: {
    withTx<T>(context: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  };
  /** The worker's clock: the expiry instant and occurred_at (rule 7). */
  readonly clock: { now(): number };
  /** UUIDv7 ids for the event and the outbox row (default: from `clock`). */
  readonly ids?: { next(): string } | undefined;
}

export function createOwnershipExpirer(
  options: OwnershipExpirerOptions,
): OwnershipExpirer {
  const { database, clock } = options;
  const ids = options.ids ?? createUuidV7Generator({ clock });
  const recorder: AuditRecorderOptions = { clock, ids, actor: "system" };
  return {
    expire: (transfer, correlationId) =>
      database.withTx(
        { orgId: transfer.orgId, userId: transfer.toUserId, projectIds: [] },
        async (tx) => {
          const outcome = await expireOwnershipTransfer(
            tx,
            transfer.id,
            new Date(clock.now()).toISOString(),
          );
          if (outcome?.changed !== true) return outcome;
          const settled = outcome.transfer;
          await recordAuditEvent(
            tx,
            recorder,
            {
              action: `${OWNERSHIP_TRANSFER_SUBJECT}.expire`,
              entityType: OWNERSHIP_TRANSFER_SUBJECT,
              entityId: settled.id,
              before: { status: "pending" },
              after: {
                status: "expired",
                initiatedBy: settled.initiatedBy,
                toUserId: settled.toUserId,
              },
            },
            { correlationId },
          );
          await insertOutbox(
            tx,
            USERS_MFA_CHECK,
            { userId: settled.toUserId },
            ids.next(),
          );
          return outcome;
        },
      ),
  };
}
