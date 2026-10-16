// Known-bad: a worker job outside the relay folder using the relay's
// transaction (P4-06, ADR 0056).
export async function sweep(relay: {
  withRelayTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}) {
  await relay.withRelayTx(async () => undefined);
}
