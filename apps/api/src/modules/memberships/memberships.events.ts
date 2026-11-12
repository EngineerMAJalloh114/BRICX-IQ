// Memberships' outbox events (P6-06b, ADR 0084; CLAUDE.md rule 5), both
// registered in @bricx/db/outbox on queue `memberships`:
// - memberships.expire, one per temporary membership, written in the
//   transaction that sets expires_at (invitation accept, project
//   assignment, renewal) with not_before = expires_at when that is within
//   BullMQ's longest delay (MAX_DELAY_MS, about 24.8 days); the worker's
//   5-minute sweep records every other one. The worker sets expired_at
//   and audits org.member.expire / project.member.expire as `system`.
//   The membership's end is effective in the API at the instant whatever
//   the job does (DbGrantsSource reads active rows at the Clock).
//   expiresAt is the instant the job was made for: a renewal makes the
//   job stale and the worker completes it as a no-op.
// - memberships.expiring, the notice (owner condition C8): once per
//   expiry window, 7 days before the end (the worker's sweep) or at once
//   when the membership is created or renewed with less left. Delivery to
//   a person is P12.
// Ids and an instant only.
import type { MembershipKind } from "@bricx/db/memberships";

export const MEMBERSHIPS_EXPIRE = "memberships.expire";
export const MEMBERSHIPS_EXPIRING = "memberships.expiring";

export interface MembershipsExpire {
  readonly kind: MembershipKind;
  readonly membershipId: string;
  readonly userId: string;
  /** UTC with milliseconds (toISOString()). */
  readonly expiresAt: string;
}

export interface MembershipsExpiring {
  readonly kind: MembershipKind;
  readonly membershipId: string;
  readonly userId: string;
}
