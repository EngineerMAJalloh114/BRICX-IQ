// The invitation sweeper's cross-org read (P6-06, ADR 0077, D10):
// app.invitations_due(limit), a SECURITY DEFINER function only bricx_relay
// may execute, through the relay's transaction (ids, org and inviter
// only). bricx_app sees one org per transaction, so the sweeper finds the
// due invitations of every org here and expires each in its own bricx_app
// transaction (expiry.ts). withRelayTx() is allowed here as in
// apps/worker/src/access/ (Semgrep bricx-relay-tx-outside-relay excludes
// this folder; ADR 0077 records the fourth use of ADR 0056's exception).
// It writes nothing. P6-06c (ADR 0085): app.invitation_batches_stale(limit)
// for the same sweep (stale bulk batches, K3).
import type { RelayDatabase } from "@bricx/db/database";
import { type StaleBatch, staleBatches } from "@bricx/db/invitation-batches";
import {
  type InvitationRef,
  MAX_DUE_INVITATIONS,
  invitationsDue,
} from "@bricx/db/invitations";

export interface DueInvitationReader {
  /** Up to `limit` pending invitations past expires_at, oldest first. */
  read(limit: number): Promise<InvitationRef[]>;
}

export function dueInvitationReader(
  database: Pick<RelayDatabase, "withRelayTx">,
): DueInvitationReader {
  return {
    read: (limit) => {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > MAX_DUE_INVITATIONS
      ) {
        return Promise.reject(
          new RangeError("invitationsDue limit: out of range"),
        );
      }
      return database.withRelayTx((tx) => invitationsDue(tx, limit));
    },
  };
}

/** The sweep's read of stale bulk batches (P6-06c, ADR 0085, K3). */
export interface StaleBatchReader {
  /** Up to `limit` batches still queued or running an hour after creation, every org. */
  read(limit: number): Promise<StaleBatch[]>;
}

/** Most stale batches one read returns (the function caps at 100 too). */
export const MAX_STALE_BATCHES = 100;

export function staleBatchReader(
  database: Pick<RelayDatabase, "withRelayTx">,
): StaleBatchReader {
  return {
    read: (limit) =>
      Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_STALE_BATCHES
        ? database.withRelayTx((tx) => staleBatches(tx, limit))
        : Promise.reject(new RangeError("staleBatches limit: out of range")),
  };
}
