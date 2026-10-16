// OutboxService.enqueue() (P4-06, ADR 0056; CLAUDE.md rule 5): every side
// effect (job, notification, payment, webhook out) is written to the
// outbox in the caller's transaction (TxRunner or withTx), so it commits
// or rolls back with the change it belongs to; the worker's relay publishes
// it after COMMIT. A thin wrapper over @bricx/db/outbox's insertOutbox()
// (condition 5: the api and the worker share no code but @bricx/db): it
// adds only the id, a UUIDv7 from the injected Clock (rule 6).
import type { Tx } from "@bricx/db/database";
import { insertOutbox } from "@bricx/db/outbox";
import {
  type UuidV7Generator,
  createUuidV7Generator,
} from "@bricx/ids/uuid-v7";
import { Inject, Injectable } from "@nestjs/common";
import { CLOCK, type Clock } from "../../common/clock.js";

@Injectable()
export class OutboxService {
  private readonly ids: UuidV7Generator;

  constructor(@Inject(CLOCK) clock: Clock) {
    this.ids = createUuidV7Generator({ clock });
  }

  /**
   * Writes one outbox row for `topic` in `tx` and returns its id (the
   * BullMQ jobId). The org is the transaction's. Refusals (unknown topic,
   * a payload the topic does not allow, no tenant context) are
   * OutboxError, thrown before anything is written.
   */
  async enqueue(tx: Tx, topic: string, payload: unknown): Promise<string> {
    const id = this.ids.next();
    await insertOutbox(tx, topic, payload, id);
    return id;
  }
}
