// The relay's statements on bricx.outbox, from @bricx/db/outbox (P4-06,
// ADR 0056): the store createRelay() runs inside withRelayTx().
import type { Tx } from "@bricx/db/database";
import {
  claimOutboxBatch,
  markOutboxFailed,
  markOutboxPublished,
} from "@bricx/db/outbox";
import type { RelayStore } from "./relay.js";

export const outboxStore: RelayStore<Tx> = Object.freeze({
  claim: claimOutboxBatch,
  markPublished: markOutboxPublished,
  markFailed: markOutboxFailed,
});
