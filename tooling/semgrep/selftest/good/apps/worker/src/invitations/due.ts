// Known-good: the invitation sweep reads app.invitations_due() in the
// relay's transaction (P6-06, ADR 0077).
export function dueInvitationReader(relay: {
  withRelayTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}) {
  return { read: (limit: number) => relay.withRelayTx(async () => limit) };
}
