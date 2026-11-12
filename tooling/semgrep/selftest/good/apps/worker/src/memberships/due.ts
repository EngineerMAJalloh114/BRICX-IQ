// Known-good: the membership sweep reads app.memberships_due() in the
// relay's transaction (P6-06b, ADR 0084).
export function dueMembershipReader(relay: {
  withRelayTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}) {
  return { read: (limit: number) => relay.withRelayTx(async () => limit) };
}
