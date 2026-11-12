// The membership sweeper's cross-org reads (P6-06b, ADR 0084):
// app.memberships_due(limit) and app.memberships_expiring(days, limit),
// SECURITY DEFINER functions only bricx_relay may execute, through the
// relay's transaction (kind, id, org and user only). bricx_app sees one
// org per transaction, so the sweeper finds the rows of every org here
// and settles each in its own bricx_app transaction (expiry.ts).
// withRelayTx() is allowed here as in apps/worker/src/access/ and
// apps/worker/src/invitations/ (Semgrep bricx-relay-tx-outside-relay
// excludes this folder; ADR 0084 records the fifth use of ADR 0056's
// exception). It writes nothing.
import type { RelayDatabase } from "@bricx/db/database";
import {
  type DueMembership,
  MAX_MEMBERSHIPS_DUE,
  membershipsDue,
  membershipsExpiring,
} from "@bricx/db/memberships";

export interface DueMembershipReader {
  /** Up to `limit` open memberships past expires_at with no expired_at. */
  due(limit: number): Promise<DueMembership[]>;
  /** Up to `limit` open memberships ending within 7 days with no notice yet. */
  expiring(limit: number): Promise<DueMembership[]>;
}

const check = (limit: number): boolean =>
  Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_MEMBERSHIPS_DUE;

export function dueMembershipReader(
  database: Pick<RelayDatabase, "withRelayTx">,
): DueMembershipReader {
  const refuse = () =>
    Promise.reject(new RangeError("memberships limit: out of range"));
  return {
    due: (limit) =>
      check(limit)
        ? database.withRelayTx((tx) => membershipsDue(tx, limit))
        : refuse(),
    expiring: (limit) =>
      check(limit)
        ? database.withRelayTx((tx) => membershipsExpiring(tx, limit))
        : refuse(),
  };
}
