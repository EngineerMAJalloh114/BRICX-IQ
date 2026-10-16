// Known-good: the worker's tests read BullMQ queues (P4-06), and prove
// the relay transaction.
import { Queue } from "bullmq";

export const inspect = (name: string) => new Queue(name, { connection: {} });
export async function prove(relay: {
  withRelayTx<T>(fn: (tx: unknown) => Promise<T>): Promise<T>;
}) {
  return relay.withRelayTx(async (tx) => tx);
}
