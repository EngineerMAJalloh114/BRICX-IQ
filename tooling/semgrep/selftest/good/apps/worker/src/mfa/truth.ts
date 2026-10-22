// Known-good: the MFA consumer reads app.mfa_state() in the relay's
// transaction (P5-05, owner condition 5, ADR 0066).
export function mfaTruth(relay: {
  withRelayTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}) {
  return { read: (userId: string) => relay.withRelayTx(async () => userId) };
}
