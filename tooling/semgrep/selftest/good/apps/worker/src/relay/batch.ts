// Known-good: the relay folder opens the relay database and runs its batch
// in withRelayTx (P4-06, ADR 0056).
import { openRelayDatabase } from "@bricx/db/database";

export async function batch(url: { reveal(): string }) {
  const db = openRelayDatabase(url);
  return db.withRelayTx(async (tx) => tx);
}
