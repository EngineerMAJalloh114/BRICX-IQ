// The truth the MFA consumer acts on (P5-05, phase ruling D5, owner
// condition 1, ADR 0066): app.mfa_state(userId) through the relay's
// cross-org transaction. bricx_relay alone may execute that SECURITY
// DEFINER function, and withRelayTx() is allowed here and in the relay
// only (owner condition 5: Semgrep bricx-relay-tx-outside-relay excludes
// apps/worker/src/mfa/ with apps/worker/src/relay/; recorded in ADR 0066
// as the second use of ADR 0056's exception). The consumer never reads a
// flag from the payload: a retry of an old job applies the current state.
import type { RelayDatabase } from "@bricx/db/database";
import { type MfaState, mfaState } from "@bricx/db/mfa";

export interface MfaTruth {
  /** The user's current state, or undefined for a user the database does not know. */
  read(userId: string): Promise<MfaState | undefined>;
}

export function mfaTruth(
  database: Pick<RelayDatabase, "withRelayTx">,
): MfaTruth {
  return {
    read: (userId) => database.withRelayTx((tx) => mfaState(tx, userId)),
  };
}
