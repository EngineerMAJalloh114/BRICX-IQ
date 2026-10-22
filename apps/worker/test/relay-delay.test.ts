// P5-06 (D-G, ADR 0067, amending ADR 0056): a claimed row's delayMs (the
// milliseconds until its not_before, by the database clock) reaches the
// publisher, which adds the job delayed by it; a row without not_before
// (delayMs 0) is published as before. The relay's control flow is in
// relay.test.ts; the delayed job in Valkey is in access.int.test.ts.
import type { OutboxDelivery, OutboxRow } from "@bricx/db/outbox";
import { describe, expect, test } from "vitest";
import type { Publisher } from "../src/relay/publisher.js";
import {
  type OutboxJobData,
  type RelayStore,
  createRelay,
} from "../src/relay/relay.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const idN = (n: number) =>
  `0199e1a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

const quiet = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function world(rows: OutboxRow[]) {
  const added: {
    jobId: string;
    delivery: OutboxDelivery | undefined;
    delayMs: number | undefined;
  }[] = [];
  const published: string[][] = [];
  const publisher: Publisher = {
    publish(_queue, _name, _data: OutboxJobData, jobId, delivery, delayMs) {
      added.push({ jobId, delivery, delayMs });
      return Promise.resolve();
    },
    ping: () => Promise.resolve(),
    close: () => Promise.resolve(),
    schedule: () => Promise.resolve(),
  };
  const store: RelayStore<string> = {
    claim: () => Promise.resolve([...rows]),
    markPublished: (_tx, ids) => {
      published.push([...ids]);
      return Promise.resolve();
    },
    markFailed: () => Promise.resolve({ attempts: 1, dead: false }),
  };
  const relay = createRelay<string>({
    database: { withRelayTx: (fn) => fn("tx") },
    store,
    publisher,
    logger: quiet,
  });
  return { relay, added, published };
}

const row = (n: number, delayMs: number, topic = "system.ping"): OutboxRow => ({
  id: idN(n),
  orgId: ORG,
  topic,
  payload:
    topic === "system.ping" ? {} : { grantId: idN(90 + n), userId: idN(80) },
  attempts: 0,
  delayMs,
});

describe("the relay hands the row's delay to the publisher", () => {
  test("a not_before row is published with its delayMs; a plain row with 0; both are marked published in the same batch", async () => {
    const w = world([
      row(1, 0),
      row(2, 7_000, "access_grants.expire"),
      row(3, 2_147_483_647, "access_grants.expire"),
    ]);
    expect(await w.relay.runOnce()).toMatchObject({
      claimed: 3,
      published: 3,
      failed: 0,
    });
    expect(w.added).toEqual([
      { jobId: idN(1), delivery: undefined, delayMs: 0 },
      {
        jobId: idN(2),
        delivery: { attempts: 40, backoffMs: 1_000, maxBackoffMs: 60_000 },
        delayMs: 7_000,
      },
      {
        jobId: idN(3),
        delivery: { attempts: 40, backoffMs: 1_000, maxBackoffMs: 60_000 },
        delayMs: 2_147_483_647,
      },
    ]);
    expect(w.published).toEqual([[idN(1), idN(2), idN(3)]]);
  });
});
