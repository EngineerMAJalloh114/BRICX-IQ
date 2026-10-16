// Known-bad: the relay's bricx_relay transaction outside the relay
// (P4-06, ADR 0056: withRelayTx is a documented exception to CLAUDE.md
// rule 4, allowed only in apps/worker/src/relay/).
import { openRelayDatabase } from "@bricx/db/database";

export async function readEveryOrg(url: { reveal(): string }) {
  const db = openRelayDatabase(url);
  return db.withRelayTx(async (tx) => tx);
}
