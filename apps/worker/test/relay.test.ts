// P4-06 (ADR 0056): the relay's control flow with fakes (no Docker). The
// same behaviour against real Postgres and Valkey is in relay.int.test.ts.
// - One withRelayTx() per batch: claim, publish each row with jobId = id,
//   mark the published ones, commit; log dead letters only after COMMIT.
// - Row failures (unknown topic, invalid payload, an add Valkey's PING
//   contradicts) go to markFailed; infrastructure failures stop the batch,
//   leave the row untouched and back off globally (condition 1).
// - outbox.relay_unavailable is rate-limited; outbox.relay_recovered once.
// - The batch deadline (condition 6) and the publish timeout.
// - The loop: immediate after a full batch, idlePollMs otherwise, backoff
//   after an unavailable batch; stop() waits for the batch in flight.
import {
  OUTBOX_TOPICS,
  type OutboxDelivery,
  OutboxError,
  type OutboxRow,
} from "@bricx/db/outbox";
import { describe, expect, test } from "vitest";
import { PublishTimeoutError } from "../src/relay/errors.js";
import type { Publisher } from "../src/relay/publisher.js";
import {
  type OutboxJobData,
  type RelayLogger,
  type RelayStore,
  createRelay,
} from "../src/relay/relay.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const idN = (n: number) =>
  `0199e1a0-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Row extends Mutable<OutboxRow> {
  published: boolean;
  dead: boolean;
  lastError: string | null;
}

interface Logged {
  level: string;
  msg: string;
  fields: Record<string, unknown>;
}

/** One turn of the event loop, as real I/O would take. */
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** An in-memory outbox; each withRelayTx() is a transaction "tx-N". */
function fakeOutbox(rows: Partial<Row>[] = []) {
  const table: Row[] = rows.map((r, i) => ({
    id: idN(i + 1),
    orgId: ORG,
    topic: "system.ping",
    payload: {},
    attempts: 0,
    published: false,
    dead: false,
    lastError: null,
    ...r,
  }));
  const calls: string[] = [];
  let txCount = 0;
  let failCommit = false;
  let failOpen = false;
  const database = {
    async withRelayTx<T>(fn: (tx: string) => Promise<T>): Promise<T> {
      if (failOpen) throw new Error("database unavailable");
      txCount += 1;
      const tx = `tx-${String(txCount)}`;
      const snapshot = structuredClone(table);
      try {
        const result = await fn(tx);
        if (failCommit) throw new Error("commit failed");
        calls.push(`${tx}:commit`);
        return result;
      } catch (error) {
        table.splice(0, table.length, ...snapshot);
        calls.push(`${tx}:rollback`);
        throw error;
      }
    },
  };
  const store: RelayStore<string> = {
    async claim(tx, limit) {
      await tick();
      calls.push(`${tx}:claim:${String(limit)}`);
      return table
        .filter((r) => !r.published && !r.dead)
        .slice(0, limit)
        .map(({ id, orgId, topic, payload, attempts }) => ({
          id,
          orgId,
          topic,
          payload,
          attempts,
        }));
    },
    async markPublished(tx, ids) {
      await tick();
      calls.push(`${tx}:published:${ids.join(",")}`);
      for (const r of table) if (ids.includes(r.id)) r.published = true;
    },
    async markFailed(tx, id, code, deadLetterAfter) {
      await tick();
      calls.push(`${tx}:failed:${id}:${code}`);
      const row = table.find((r) => r.id === id);
      if (row === undefined) throw new Error("no row");
      row.attempts += 1;
      row.lastError = code;
      row.dead = row.attempts >= deadLetterAfter;
      return { attempts: row.attempts, dead: row.dead };
    },
  };
  return {
    table,
    calls,
    database,
    store,
    failCommit: (on: boolean) => {
      failCommit = on;
    },
    failOpen: (on: boolean) => {
      failOpen = on;
    },
  };
}

function fakePublisher(behaviour: (jobId: string) => Promise<void> = tick) {
  const added: {
    queue: string;
    name: string;
    data: OutboxJobData;
    jobId: string;
    delivery: OutboxDelivery | undefined;
  }[] = [];
  let pingOk = true;
  const publisher: Publisher = {
    async publish(queue, name, data, jobId, delivery) {
      await behaviour(jobId);
      added.push({ queue, name, data, jobId, delivery });
    },
    async ping() {
      await tick();
      if (!pingOk) throw new Error("Connection is closed.");
    },
    async close() {
      await tick();
    },
  };
  return {
    publisher,
    added,
    setPing: (ok: boolean) => {
      pingOk = ok;
    },
  };
}

function recorder(): RelayLogger & { lines: Logged[] } {
  const lines: Logged[] = [];
  const at =
    (level: string) => (fields: Record<string, unknown>, msg: string) => {
      lines.push({ level, msg, fields });
    };
  return {
    lines,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}

const refused = (message: string) => () => Promise.reject(new Error(message));

describe("one batch", () => {
  test("claims, publishes each row with jobId = id on its topic's queue, marks them published, commits", async () => {
    const outbox = fakeOutbox([{}, { orgId: idN(99) }]);
    const pub = fakePublisher();
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: pub.publisher,
      logger: recorder(),
    });
    expect(await relay.runOnce()).toEqual({
      claimed: 2,
      published: 2,
      failed: 0,
      dead: 0,
      unavailable: false,
      deadlineHit: false,
    });
    expect(pub.added).toEqual([
      {
        queue: "system",
        name: "system.ping",
        jobId: idN(1),
        data: {
          outboxId: idN(1),
          orgId: ORG,
          topic: "system.ping",
          payload: {},
        },
        delivery: undefined,
      },
      {
        queue: "system",
        name: "system.ping",
        jobId: idN(2),
        data: {
          outboxId: idN(2),
          orgId: idN(99),
          topic: "system.ping",
          payload: {},
        },
        delivery: undefined,
      },
    ]);
    expect(outbox.calls).toEqual([
      "tx-1:claim:100",
      `tx-1:published:${idN(1)},${idN(2)}`,
      "tx-1:commit",
    ]);
  });

  test("passes the topic's delivery options to the publisher (P5-04 plan decision 8: sessions.revoked retries at Keycloak)", async () => {
    const payload = {
      sessionId: idN(10),
      userId: idN(11),
      orgId: ORG,
      keycloakSid: idN(12),
      cause: "admin",
    };
    const outbox = fakeOutbox([{ topic: "sessions.revoked", payload }]);
    const pub = fakePublisher();
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: pub.publisher,
      logger: recorder(),
    });
    expect(await relay.runOnce()).toMatchObject({ claimed: 1, published: 1 });
    const delivery = OUTBOX_TOPICS["sessions.revoked"]?.delivery;
    expect(delivery).toEqual({
      attempts: 40,
      backoffMs: 1_000,
      maxBackoffMs: 60_000,
    });
    expect(pub.added).toEqual([
      {
        queue: "sessions",
        name: "sessions.revoked",
        jobId: idN(1),
        data: {
          outboxId: idN(1),
          orgId: ORG,
          topic: "sessions.revoked",
          payload,
        },
        delivery,
      },
    ]);
  });

  test("an empty outbox: one claim, nothing published, no mark", async () => {
    const outbox = fakeOutbox();
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: fakePublisher().publisher,
      logger: recorder(),
    });
    expect(await relay.runOnce()).toMatchObject({ claimed: 0, published: 0 });
    expect(outbox.calls).toEqual(["tx-1:claim:100", "tx-1:commit"]);
  });

  test("row failures: unknown topic, invalid payload, payload too large; the batch goes on", async () => {
    const outbox = fakeOutbox([
      { topic: "system.unknown" },
      { payload: { a: 1 } },
      { payload: [] },
      {},
    ]);
    const pub = fakePublisher();
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: pub.publisher,
      logger: recorder(),
    });
    expect(await relay.runOnce()).toMatchObject({
      claimed: 4,
      published: 1,
      failed: 3,
      dead: 0,
    });
    expect(outbox.calls).toEqual([
      "tx-1:claim:100",
      `tx-1:published:${idN(4)}`,
      `tx-1:failed:${idN(1)}:unknown_topic`,
      `tx-1:failed:${idN(2)}:invalid_payload`,
      `tx-1:failed:${idN(3)}:invalid_payload`,
      "tx-1:commit",
    ]);
    expect(pub.added.map((a) => a.jobId)).toEqual([idN(4)]);
  });

  test("an add Valkey's PING does not contradict is the row's: publish_rejected", async () => {
    const outbox = fakeOutbox([{}]);
    const pub = fakePublisher(refused("Invalid job options"));
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: pub.publisher,
      logger: recorder(),
    });
    expect(await relay.runOnce()).toMatchObject({
      failed: 1,
      unavailable: false,
    });
    expect(outbox.table[0]).toMatchObject({
      attempts: 1,
      lastError: "publish_rejected",
    });
  });

  test("dead at N: outbox.dead_letter (ids, topic, attempts, code) after COMMIT only", async () => {
    const outbox = fakeOutbox([{ topic: "system.unknown", attempts: 2 }]);
    const log = recorder();
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: fakePublisher().publisher,
      logger: log,
      deadLetterAfter: 3,
    });
    outbox.failCommit(true);
    expect(await relay.runOnce()).toMatchObject({ unavailable: true, dead: 0 });
    expect(log.lines.filter((l) => l.msg === "outbox.dead_letter")).toEqual([]);
    expect(outbox.table[0]).toMatchObject({ attempts: 2, dead: false });

    outbox.failCommit(false);
    expect(await relay.runOnce()).toMatchObject({ failed: 1, dead: 1 });
    expect(log.lines.filter((l) => l.msg === "outbox.dead_letter")).toEqual([
      {
        level: "error",
        msg: "outbox.dead_letter",
        fields: {
          outboxId: idN(1),
          orgId: ORG,
          topic: "system.unknown",
          attempts: 3,
          lastError: "unknown_topic",
        },
      },
    ]);
  });
});

describe("infrastructure failures (condition 1)", () => {
  test("a connection error stops the batch: earlier rows published, the rest untouched, no attempt counted", async () => {
    const outbox = fakeOutbox([{}, {}, {}]);
    const pub = fakePublisher(async (jobId) => {
      await tick();
      if (jobId === idN(2)) throw new Error("Connection is closed.");
    });
    const log = recorder();
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: pub.publisher,
      logger: log,
    });
    expect(await relay.runOnce()).toEqual({
      claimed: 3,
      published: 1,
      failed: 0,
      dead: 0,
      unavailable: true,
      deadlineHit: false,
    });
    expect(outbox.calls).toEqual([
      "tx-1:claim:100",
      `tx-1:published:${idN(1)}`,
      "tx-1:commit",
    ]);
    expect(outbox.table.map((r) => [r.published, r.attempts])).toEqual([
      [true, 0],
      [false, 0],
      [false, 0],
    ]);
    expect(log.lines.filter((l) => l.level === "warn")).toEqual([
      {
        level: "warn",
        msg: "outbox.relay_unavailable",
        fields: { dependency: "valkey" },
      },
    ]);
  });

  test("an unrecognised error while Valkey's PING fails is infrastructure", async () => {
    const outbox = fakeOutbox([{}]);
    const pub = fakePublisher(refused("something unexpected"));
    pub.setPing(false);
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: pub.publisher,
      logger: recorder(),
    });
    expect(await relay.runOnce()).toMatchObject({
      failed: 0,
      unavailable: true,
    });
    expect(outbox.table[0]).toMatchObject({ attempts: 0 });
  });

  test("an add that never answers times out (commandTimeoutMs): infrastructure", async () => {
    const outbox = fakeOutbox([{}]);
    const pub = fakePublisher(() => new Promise<void>(() => undefined));
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: pub.publisher,
      logger: recorder(),
      commandTimeoutMs: 20,
    });
    expect(await relay.runOnce()).toMatchObject({
      published: 0,
      failed: 0,
      unavailable: true,
    });
    expect(outbox.table[0]).toMatchObject({ attempts: 0, published: false });
  });

  test("the database unreachable: unavailable (dependency database), no throw", async () => {
    const outbox = fakeOutbox([{}]);
    outbox.failOpen(true);
    const log = recorder();
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: fakePublisher().publisher,
      logger: log,
    });
    expect(await relay.runOnce()).toMatchObject({ unavailable: true });
    expect(log.lines).toContainEqual({
      level: "warn",
      msg: "outbox.relay_unavailable",
      fields: { dependency: "database" },
    });
  });

  test("outbox.relay_unavailable at most once per unavailableLogEveryMs; outbox.relay_recovered once", async () => {
    const outbox = fakeOutbox([{}]);
    let down = true;
    const pub = fakePublisher(async () => {
      await tick();
      if (down) throw new PublishTimeoutError();
    });
    let clock = 0;
    const log = recorder();
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: pub.publisher,
      logger: log,
      unavailableLogEveryMs: 60_000,
      now: () => clock,
    });
    for (const at of [0, 1_000, 59_999, 60_000, 61_000]) {
      clock = at;
      await relay.runOnce();
    }
    const warned = () =>
      log.lines.filter((l) => l.msg === "outbox.relay_unavailable").length;
    expect(warned()).toBe(2);
    down = false;
    await relay.runOnce();
    await relay.runOnce();
    expect(
      log.lines.filter((l) => l.msg === "outbox.relay_recovered"),
    ).toHaveLength(1);
    // A new outage logs again at once.
    down = true;
    outbox.table[0] = { ...(outbox.table[0] as Row), published: false };
    await relay.runOnce();
    expect(warned()).toBe(3);
  });
});

describe("the batch deadline (condition 6)", () => {
  test("past batchDeadlineMs: commit what was published and stop", async () => {
    const outbox = fakeOutbox([{}, {}, {}, {}]);
    let clock = 0;
    const pub = fakePublisher(async () => {
      await tick();
      clock += 10;
    });
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: pub.publisher,
      logger: recorder(),
      batchDeadlineMs: 25,
      now: () => clock,
    });
    expect(await relay.runOnce()).toMatchObject({
      claimed: 4,
      published: 3,
      deadlineHit: true,
      unavailable: false,
    });
    expect(outbox.table.map((r) => r.published)).toEqual([
      true,
      true,
      true,
      false,
    ]);
    expect(outbox.table[3]).toMatchObject({ attempts: 0 });
  });
});

describe("options", () => {
  test.each([
    ["batchSize", { batchSize: 0 }],
    ["batchSize", { batchSize: 1001 }],
    ["deadLetterAfter", { deadLetterAfter: 0 }],
    ["batchDeadlineMs", { batchDeadlineMs: -1 }],
    ["commandTimeoutMs", { commandTimeoutMs: 1.5 }],
  ])("refuses an invalid %s", (_name, bad) => {
    const outbox = fakeOutbox();
    expect(() =>
      createRelay({
        database: outbox.database,
        store: outbox.store,
        publisher: fakePublisher().publisher,
        logger: recorder(),
        ...bad,
      }),
    ).toThrow(/relay: invalid option/);
  });

  test("passes batchSize to claim", async () => {
    const outbox = fakeOutbox();
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: fakePublisher().publisher,
      logger: recorder(),
      batchSize: 7,
    });
    await relay.runOnce();
    expect(outbox.calls[0]).toBe("tx-1:claim:7");
  });
});

describe("the loop", () => {
  const until = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(check()).toBe(true);
  };

  test("drains full batches back to back, then polls; stop() waits for the batch in flight", async () => {
    const outbox = fakeOutbox(Array.from({ length: 5 }, () => ({})));
    const pub = fakePublisher();
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: pub.publisher,
      logger: recorder(),
      batchSize: 2,
      idlePollMs: 10_000,
    });
    relay.start();
    relay.start();
    await until(() => pub.added.length === 5);
    await relay.stop();
    await relay.stop();
    // Three batches (2, 2, 1) and no fourth: the third was not full, so
    // the loop waited idlePollMs and stop() ended the wait.
    expect(outbox.calls.filter((c) => c.endsWith(":claim:2"))).toHaveLength(3);
  });

  test("backs off after an unavailable batch instead of spinning", async () => {
    const outbox = fakeOutbox([{}]);
    const pub = fakePublisher(refused("Connection is closed."));
    const log = recorder();
    const relay = createRelay({
      database: outbox.database,
      store: outbox.store,
      publisher: pub.publisher,
      logger: log,
      idlePollMs: 1,
      maxBackoffMs: 50,
    });
    relay.start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await relay.stop();
    const batches = log.lines.filter(
      (l) => l.msg === "outbox.batch_unavailable",
    ).length;
    expect(batches).toBeGreaterThan(1);
    expect(batches).toBeLessThan(15);
  });

  test("a batch that throws unexpectedly is logged and the loop goes on", async () => {
    const outbox = fakeOutbox([{}]);
    let calls = 0;
    const store: RelayStore<string> = {
      ...outbox.store,
      claim: async (tx, limit) => {
        calls += 1;
        if (calls === 1) throw new OutboxError("invalid_payload");
        return outbox.store.claim(tx, limit);
      },
    };
    const pub = fakePublisher();
    const relay = createRelay({
      database: outbox.database,
      store,
      publisher: pub.publisher,
      logger: recorder(),
      idlePollMs: 1,
      maxBackoffMs: 5,
    });
    relay.start();
    await until(() => pub.added.length === 1);
    await relay.stop();
  });
});
