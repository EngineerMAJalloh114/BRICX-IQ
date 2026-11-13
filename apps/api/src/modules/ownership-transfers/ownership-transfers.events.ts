// Ownership transfers' outbox event (P6-06c, ADR 0085; CLAUDE.md rule 5),
// registered in @bricx/db/outbox on queue `memberships`:
// - ownership.expire {transferId, toUserId, expiresAt}, one per started transfer,
//   written in the start's transaction with not_before = expires_at (24 h,
//   under MAX_DELAY_MS). The worker expires the transfer as `system` when
//   it is still pending; the memberships sweep is the backstop. The API
//   also expires a due transfer lazily at its Clock (accept, decline).
// Ids and an instant only.
export const OWNERSHIP_EXPIRE = "ownership.expire";

export interface OwnershipExpire {
  readonly transferId: string;
  /** The recipient: the worker's transaction runs as them. */
  readonly toUserId: string;
  /** UTC with milliseconds (toISOString()). */
  readonly expiresAt: string;
}
