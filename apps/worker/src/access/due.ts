// The sweep's cross-org read (P5-06, D-G, owner condition 4, ADR 0067):
// app.access_grants_due(limit), a SECURITY DEFINER function only
// bricx_relay may execute, through the relay's transaction. bricx_app
// sees one org per transaction, so the sweep finds the due grants of
// every org here and expires each in its own bricx_app transaction
// (expiry.ts). withRelayTx() is allowed here, in the relay and in the MFA
// consumer only (Semgrep bricx-relay-tx-outside-relay excludes
// apps/worker/src/access/; ADR 0067 records the third use of ADR 0056's
// exception). It writes nothing.
import {
  type DueAccessGrant,
  MAX_DUE,
  accessGrantsDue,
} from "@bricx/db/access-grants";
import type { RelayDatabase } from "@bricx/db/database";

export interface DueReader {
  /** Up to `limit` (1..MAX_DUE) open grants past expires_at, oldest first. */
  read(limit: number): Promise<DueAccessGrant[]>;
}

export function dueReader(
  database: Pick<RelayDatabase, "withRelayTx">,
): DueReader {
  return {
    read: (limit) => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DUE) {
        return Promise.reject(
          new RangeError("accessGrantsDue limit: out of range"),
        );
      }
      return database.withRelayTx((tx) => accessGrantsDue(tx, limit));
    },
  };
}
