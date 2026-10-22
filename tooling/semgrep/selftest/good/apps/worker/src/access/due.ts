// Known-good: the expiry sweep reads app.access_grants_due() in the
// relay's transaction (P5-06, owner condition 4, ADR 0067).
export function dueReader(relay: {
  withRelayTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}) {
  return { read: (limit: number) => relay.withRelayTx(async () => limit) };
}
