// P4-06 (ADR 0056): the outbox relay against compose.yml's Postgres (real
// init folder, production journal) and Valkey (compose.yml's own command
// line: noeviction). Rows are written by @bricx/db/outbox's insertOutbox()
// as bricx_app in withTx(); the relay reads them as bricx_relay.
// - Done when 1: a rolled-back transaction produces no job; a committed one
//   exactly one, with jobId = the outbox id.
// - Done when 2: a crash between the add and the COMMIT still leaves one job.
// - Done when 3 (condition 3): relay A stalls inside queue.add while relay
//   B publishes a different batch; 200 adds in total, 200 jobs.
// - Done when 4 (condition 1): Valkey unreachable or timing out leaves rows
//   pending with attempts unchanged and nothing dead, logging one
//   outbox.relay_unavailable; an unknown topic or a payload BullMQ rejects
//   raises attempts and dead-letters at N with outbox.dead_letter.
// - Condition 6: past the batch deadline the relay commits what it
//   published and stops.
// - Done when 9 (condition 2): the runbook's re-drive SQL, run as
//   bricx_relay, brings a dead row back and the relay publishes it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import {
  type Database,
  type RelayDatabase,
  openDatabase,
  openRelayDatabase,
} from "@bricx/db/database";
import { insertOutbox } from "@bricx/db/outbox";
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import { createBullPublisher, type Publisher } from "../src/relay/publisher.js";
import {
  type BatchResult,
  type OutboxJobData,
  type Relay,
  type RelayLogger,
  type RelayOptions,
  createRelay,
} from "../src/relay/relay.js";
import { outboxStore } from "../src/relay/store.js";
import { openValkey } from "../src/relay/valkey.js";
import { type Stack, startStack } from "./stack.js";

const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const ORG_B = "0199e1a0-0000-7000-8000-00000000000b";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const ids = createUuidV7Generator({ clock: { now: () => Date.now() } });
const runbook = path.resolve(
  import.meta.dirname,
  "../../../docs/runbooks/outbox.md",
);

let stack: Stack;
let app: Database;
let valkey: Redis;
let inspect: Queue<OutboxJobData>;
const closers: (() => Promise<unknown>)[] = [];

interface Logged {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields: Record<string, unknown>;
}

/** A pino-shaped logger that records every line. */
function recorder(): RelayLogger & { lines: Logged[] } {
  const lines: Logged[] = [];
  const at =
    (level: Logged["level"]) =>
    (fields: Record<string, unknown>, msg: string) => {
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

function relayDb(): RelayDatabase {
  const db = openRelayDatabase({ reveal: () => stack.url("bricx_relay") });
  closers.push(() => db.close());
  return db;
}

function publisherOn(client: Redis): Publisher {
  const publisher = createBullPublisher(client);
  closers.push(() => publisher.close());
  return publisher;
}

/** A relay with test timings; every other option is the default. */
function relay(
  overrides: Partial<RelayOptions> & { publisher: Publisher },
): Relay & { log: ReturnType<typeof recorder> } {
  const log = recorder();
  const r = createRelay({
    database: overrides.database ?? relayDb(),
    store: outboxStore,
    logger: log,
    idlePollMs: 50,
    maxBackoffMs: 200,
    ...overrides,
  });
  closers.push(() => r.stop());
  return Object.assign(r, { log });
}

/** Commits `count` system.ping rows for `org`; returns their ids. */
async function enqueue(org: string, count = 1): Promise<string[]> {
  const out: string[] = [];
  await app.withTx({ orgId: org, userId: USER, projectIds: [] }, async (tx) => {
    for (let i = 0; i < count; i += 1) {
      const id = ids.next();
      await insertOutbox(tx, "system.ping", {}, id);
      out.push(id);
    }
  });
  return out;
}

async function asAdmin<R extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const admin = await stack.postgres.admin();
  try {
    return (await admin.query<R>(text, params)).rows;
  } finally {
    await admin.end();
  }
}

type RowState = {
  attempts: number;
  published: boolean;
  dead: boolean;
  last_error: string | null;
};
async function stateOf(id: string): Promise<RowState | undefined> {
  const rows = await asAdmin<RowState & { id: string }>(
    `SELECT attempts, published_at IS NOT NULL AS published,
            dead_at IS NOT NULL AS dead, last_error
     FROM bricx.outbox WHERE id = $1`,
    [id],
  );
  return rows[0];
}

/** Every job in queue `system`, by id. */
async function jobIds(): Promise<string[]> {
  const jobs = await inspect.getJobs([
    "waiting",
    "active",
    "completed",
    "failed",
    "delayed",
  ]);
  return jobs.map((j) => String(j.id)).sort();
}

/** A port nothing listens on (bound, then released). */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise((resolve) => server.close(resolve));
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return address.port;
}

/** A Valkey client for a port nothing listens on. */
async function unreachableValkey(commandTimeoutMs: number): Promise<Redis> {
  const port = await closedPort();
  const down = openValkey(
    { reveal: () => `redis://default:x@127.0.0.1:${String(port)}` },
    { commandTimeoutMs },
  );
  closers.push(() => {
    down.disconnect();
    return Promise.resolve();
  });
  return down;
}

const docker = (...args: string[]) =>
  execFileSync("docker", args, { encoding: "utf8" });

beforeAll(async () => {
  stack = await startStack();
  app = openDatabase({ reveal: () => stack.url("bricx_app") });
  valkey = openValkey(
    { reveal: () => stack.valkeyUrl() },
    { commandTimeoutMs: 1_000 },
  );
  await valkey.connect();
  inspect = new Queue<OutboxJobData>("system", {
    connection: openValkey({ reveal: () => stack.valkeyUrl() }),
  });
});
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close();
  // Each test starts with no pending row and an empty Valkey.
  await asAdmin(
    "UPDATE bricx.outbox SET published_at = now() WHERE published_at IS NULL AND dead_at IS NULL",
  );
  await valkey.flushall();
});
afterAll(async () => {
  await inspect.close();
  valkey.disconnect();
  await app.close();
  await stack.stop();
});

describe("Done when 1: rollback, commit", () => {
  test("a rolled-back transaction produces no job; a committed one exactly one, jobId = outbox id", async () => {
    const r = relay({ publisher: publisherOn(valkey) });
    const rolledBack = ids.next();
    await expect(
      app.withTx({ orgId: ORG_A, userId: USER, projectIds: [] }, async (tx) => {
        await insertOutbox(tx, "system.ping", {}, rolledBack);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await r.runOnce()).toMatchObject({ claimed: 0, published: 0 });
    expect(await jobIds()).toEqual([]);

    const [committed = ""] = await enqueue(ORG_A);
    expect(await r.runOnce()).toMatchObject({
      claimed: 1,
      published: 1,
      failed: 0,
      dead: 0,
      unavailable: false,
    });
    expect(await jobIds()).toEqual([committed]);
    const job = await inspect.getJob(committed);
    expect(job?.name).toBe("system.ping");
    expect(job?.data).toEqual({
      outboxId: committed,
      orgId: ORG_A,
      topic: "system.ping",
      payload: {},
    } satisfies OutboxJobData);
    expect(job?.opts).toMatchObject({
      jobId: committed,
      removeOnComplete: { age: 86_400 },
      removeOnFail: { age: 86_400 },
    });
    expect(await stateOf(committed)).toMatchObject({
      published: true,
      attempts: 0,
    });
    // Published rows are never claimed again.
    expect(await r.runOnce()).toMatchObject({ claimed: 0 });
    expect(await jobIds()).toEqual([committed]);
  });

  test("rows of every org go out; each job carries its own org", async () => {
    const r = relay({ publisher: publisherOn(valkey) });
    const [a] = await enqueue(ORG_A);
    const [b] = await enqueue(ORG_B);
    expect(await r.runOnce()).toMatchObject({ published: 2 });
    expect((await inspect.getJob(a ?? ""))?.data.orgId).toBe(ORG_A);
    expect((await inspect.getJob(b ?? ""))?.data.orgId).toBe(ORG_B);
  });
});

describe("Done when 2: a crash between the add and the COMMIT", () => {
  test("the row stays pending, the next relay re-adds the same jobId: still one job", async () => {
    const [id] = await enqueue(ORG_A);
    const real = publisherOn(valkey);
    let adds = 0;
    // After the real add, every bricx_relay backend is terminated: the
    // relay's transaction is lost exactly as if the process had died.
    const crashing: Publisher = {
      ...real,
      async publish(...args) {
        await real.publish(...args);
        adds += 1;
        await asAdmin(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename = 'bricx_relay'",
        );
      },
    };
    const first = await relay({ publisher: crashing }).runOnce();
    expect(first).toMatchObject({ published: 0, unavailable: true });
    expect(await jobIds()).toEqual([id]);
    expect(await stateOf(id ?? "")).toMatchObject({
      published: false,
      attempts: 0,
      dead: false,
    });

    const counting: Publisher = {
      ...real,
      async publish(...args) {
        adds += 1;
        await real.publish(...args);
      },
    };
    expect(await relay({ publisher: counting }).runOnce()).toMatchObject({
      published: 1,
    });
    expect(adds).toBe(2);
    expect(await jobIds()).toEqual([id]);
    expect(await stateOf(id ?? "")).toMatchObject({ published: true });
  });
});

describe("Done when 3: two relays (condition 3)", () => {
  test("relay A stalls inside queue.add; relay B publishes a different batch meanwhile; 200 adds, 200 jobs", async () => {
    const all = await enqueue(ORG_A, 200);
    const real = publisherOn(valkey);
    const stalled = Promise.withResolvers<undefined>();
    const gate = Promise.withResolvers<undefined>();
    const addsA: string[] = [];
    const addsB: string[] = [];
    const publisherA: Publisher = {
      ...real,
      async publish(queue, name, data, jobId) {
        addsA.push(jobId);
        if (addsA.length === 1) {
          stalled.resolve(undefined);
          await gate.promise;
        }
        await real.publish(queue, name, data, jobId);
      },
    };
    const publisherB: Publisher = {
      ...real,
      async publish(queue, name, data, jobId) {
        addsB.push(jobId);
        await real.publish(queue, name, data, jobId);
      },
    };
    const a = relay({ publisher: publisherA });
    const b = relay({ publisher: publisherB });

    const runA = a.runOnce();
    await stalled.promise;
    // B must finish while A still holds its 100 rows (no SKIP LOCKED: B
    // would wait on A's row locks and this would time out).
    const timeout = new Promise<"blocked">((resolve) =>
      setTimeout(() => {
        resolve("blocked");
      }, 10_000),
    );
    const resultB = await Promise.race([b.runOnce(), timeout]);
    expect(resultB).not.toBe("blocked");
    expect(addsA).toHaveLength(1);
    expect(resultB).toMatchObject({ claimed: 100, published: 100 });

    gate.resolve(undefined);
    const resultA: BatchResult = await runA;
    expect(resultA).toMatchObject({ claimed: 100, published: 100 });

    expect(addsA.length + addsB.length).toBe(200);
    expect(new Set([...addsA, ...addsB]).size).toBe(200);
    expect(addsA.filter((id) => addsB.includes(id))).toEqual([]);
    expect(await jobIds()).toEqual([...all].sort());
    const pending = await asAdmin<{ n: string }>(
      "SELECT count(*)::text AS n FROM bricx.outbox WHERE published_at IS NULL",
    );
    expect(pending).toEqual([{ n: "0" }]);
  });
});

describe("Done when 4: infrastructure failures never burn attempts (condition 1)", () => {
  test("Valkey unreachable: rows stay pending, attempts unchanged, nothing dead, one outbox.relay_unavailable", async () => {
    const pending = await enqueue(ORG_A, 3);
    const down = await unreachableValkey(500);
    const r = relay({ publisher: publisherOn(down), deadLetterAfter: 2 });
    for (let run = 0; run < 4; run += 1) {
      expect(await r.runOnce()).toMatchObject({
        published: 0,
        failed: 0,
        dead: 0,
        unavailable: true,
      });
    }
    for (const id of pending) {
      expect(await stateOf(id)).toEqual({
        attempts: 0,
        published: false,
        dead: false,
        last_error: null,
      });
    }
    const unavailable = r.log.lines.filter(
      (l) => l.msg === "outbox.relay_unavailable",
    );
    expect(unavailable).toHaveLength(1);
    expect(unavailable[0]).toMatchObject({
      level: "warn",
      fields: { dependency: "valkey" },
    });
    expect(r.log.lines.filter((l) => l.msg === "outbox.dead_letter")).toEqual(
      [],
    );
    // Nothing secret or row-specific in the log line.
    expect(JSON.stringify(unavailable)).not.toMatch(
      /redis:|default:x|127\.0\.0\.1/,
    );
  });

  test("Valkey paused (timeouts): rows stay pending, attempts unchanged; after it resumes they publish", async () => {
    const pending = await enqueue(ORG_A, 3);
    const client = openValkey(
      { reveal: () => stack.valkeyUrl() },
      { commandTimeoutMs: 500 },
    );
    await client.connect();
    closers.push(() => {
      client.disconnect();
      return Promise.resolve();
    });
    const r = relay({
      publisher: createBullPublisher(client),
      commandTimeoutMs: 500,
      deadLetterAfter: 2,
    });
    docker("pause", stack.valkey.getId());
    try {
      for (let run = 0; run < 3; run += 1) {
        expect(await r.runOnce()).toMatchObject({
          published: 0,
          failed: 0,
          unavailable: true,
        });
      }
      for (const id of pending) {
        expect(await stateOf(id)).toMatchObject({ attempts: 0, dead: false });
      }
    } finally {
      docker("unpause", stack.valkey.getId());
    }
    // The relay recovers by itself once the connection answers again
    // (ioredis may first reconnect): a later batch publishes everything.
    let result: BatchResult | undefined;
    for (let run = 0; run < 100 && result?.published !== 3; run += 1) {
      if (run > 0) await new Promise((resolve) => setTimeout(resolve, 100));
      result = await r.runOnce();
    }
    expect(result).toMatchObject({ published: 3, unavailable: false });
    expect(await jobIds()).toEqual([...pending].sort());
    expect(
      r.log.lines.filter((l) => l.msg === "outbox.relay_recovered"),
    ).toHaveLength(1);
  });

  test("a failure Valkey's PING contradicts is infrastructure: an unknown error while Valkey is down burns no attempt", async () => {
    const [id] = await enqueue(ORG_A);
    const down = await unreachableValkey(500);
    const real = publisherOn(down);
    const odd: Publisher = {
      ...real,
      publish: () => Promise.reject(new Error("something unexpected")),
    };
    expect(await relay({ publisher: odd }).runOnce()).toMatchObject({
      failed: 0,
      unavailable: true,
    });
    expect(await stateOf(id ?? "")).toMatchObject({ attempts: 0 });
  });

  test("the loop backs off globally while Valkey is down, and resumes", async () => {
    await enqueue(ORG_A, 2);
    const down = await unreachableValkey(300);
    const r = relay({ publisher: publisherOn(down), maxBackoffMs: 400 });
    r.start();
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    await r.stop();
    // 1 s backoff capped at 400 ms: a handful of attempts, never a busy loop.
    const runs = r.log.lines.filter(
      (l) => l.msg === "outbox.batch_unavailable",
    );
    expect(runs.length).toBeGreaterThan(1);
    expect(runs.length).toBeLessThan(10);
  });
});

describe("Done when 4: row failures count and dead-letter at N (condition 1)", () => {
  async function seedUnknown(): Promise<string> {
    const id = ids.next();
    await asAdmin(
      "INSERT INTO bricx.outbox (id, org_id, topic, payload) VALUES ($1, $2, 'system.unknown', '{}')",
      [id, ORG_A],
    );
    return id;
  }
  const dueNow = (id: string) =>
    asAdmin("UPDATE bricx.outbox SET next_attempt_at = now() WHERE id = $1", [
      id,
    ]);

  test("an unknown topic: attempts 1, 2, 3, dead at N = 3 with outbox.dead_letter; no job", async () => {
    const id = await seedUnknown();
    const r = relay({ publisher: publisherOn(valkey), deadLetterAfter: 3 });
    for (const attempt of [1, 2, 3]) {
      expect(await r.runOnce()).toMatchObject({
        failed: 1,
        dead: attempt === 3 ? 1 : 0,
        unavailable: false,
      });
      expect(await stateOf(id)).toEqual({
        attempts: attempt,
        published: false,
        dead: attempt === 3,
        last_error: "unknown_topic",
      });
      await dueNow(id);
    }
    expect(await r.runOnce()).toMatchObject({ claimed: 0 });
    const dead = r.log.lines.filter((l) => l.msg === "outbox.dead_letter");
    expect(dead).toEqual([
      {
        level: "error",
        msg: "outbox.dead_letter",
        fields: {
          outboxId: id,
          orgId: ORG_A,
          topic: "system.unknown",
          attempts: 3,
          lastError: "unknown_topic",
        },
      },
    ]);
    expect(await jobIds()).toEqual([]);
  });

  test("a row failure does not stop the batch: the other rows publish", async () => {
    const bad = await seedUnknown();
    const good = await enqueue(ORG_A, 2);
    const r = relay({ publisher: publisherOn(valkey) });
    expect(await r.runOnce()).toMatchObject({
      claimed: 3,
      published: 2,
      failed: 1,
      dead: 0,
    });
    expect(await jobIds()).toEqual([...good].sort());
    expect(await stateOf(bad)).toMatchObject({ attempts: 1 });
  });

  test("a payload BullMQ rejects (Valkey healthy): attempts rise, dead at N, last_error publish_rejected", async () => {
    const [id] = await enqueue(ORG_A);
    const real = publisherOn(valkey);
    const rejecting: Publisher = {
      ...real,
      publish: () => Promise.reject(new Error("Invalid job options")),
    };
    const r = relay({ publisher: rejecting, deadLetterAfter: 2 });
    expect(await r.runOnce()).toMatchObject({ failed: 1, dead: 0 });
    await dueNow(id ?? "");
    expect(await r.runOnce()).toMatchObject({ failed: 1, dead: 1 });
    expect(await stateOf(id ?? "")).toEqual({
      attempts: 2,
      published: false,
      dead: true,
      last_error: "publish_rejected",
    });
  });

  test("the default N is 10", async () => {
    const id = await seedUnknown();
    const r = relay({ publisher: publisherOn(valkey) });
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await r.runOnce();
      await dueNow(id);
    }
    expect(await stateOf(id)).toMatchObject({ attempts: 10, dead: true });
  });
});

describe("condition 6: the batch deadline", () => {
  test("past the deadline the relay commits what it published and stops; the rest stay pending, attempts 0", async () => {
    const rows = await enqueue(ORG_A, 10);
    const real = publisherOn(valkey);
    const slow: Publisher = {
      ...real,
      async publish(...args) {
        await new Promise((resolve) => setTimeout(resolve, 150));
        await real.publish(...args);
      },
    };
    const r = relay({ publisher: slow, batchDeadlineMs: 400 });
    const first = await r.runOnce();
    expect(first.deadlineHit).toBe(true);
    expect(first.published).toBeGreaterThan(0);
    expect(first.published).toBeLessThan(10);
    const states = await Promise.all(rows.map(stateOf));
    expect(states.filter((s) => s?.published)).toHaveLength(first.published);
    expect(states.every((s) => s?.attempts === 0)).toBe(true);
    // The next batches pick up the rest.
    let total = first.published;
    for (let run = 0; run < 10 && total < 10; run += 1) {
      total += (await r.runOnce()).published;
    }
    expect(total).toBe(10);
    expect(await jobIds()).toEqual([...rows].sort());
  });
});

describe("P5-03 (owner condition 5): sessions.revoked, a topic nothing consumes yet", () => {
  test("one row publishes once to queue sessions, where the job waits; no attempt burnt, no dead letter, nothing re-claimed", async () => {
    const sessionsQueue = new Queue<OutboxJobData>("sessions", {
      connection: openValkey({ reveal: () => stack.valkeyUrl() }),
    });
    closers.push(() => sessionsQueue.close());
    const r = relay({ publisher: publisherOn(valkey) });
    const id = ids.next();
    const payload = {
      sessionId: ids.next(),
      userId: USER,
      orgId: ORG_A,
      // A Keycloak session id is a UUID; a generated one (not a literal, so
      // the gitleaks pre-commit scan never mistakes it for a key).
      keycloakSid: ids.next(),
    };
    await app.withTx({ orgId: ORG_A, userId: USER, projectIds: [] }, (tx) =>
      insertOutbox(tx, "sessions.revoked", payload, id),
    );
    expect(await r.runOnce()).toMatchObject({
      claimed: 1,
      published: 1,
      failed: 0,
      dead: 0,
      unavailable: false,
    });
    expect(await stateOf(id)).toEqual({
      attempts: 0,
      published: true,
      dead: false,
      last_error: null,
    });
    const job = await sessionsQueue.getJob(id);
    expect(job?.name).toBe("sessions.revoked");
    expect(job?.data).toEqual({
      outboxId: id,
      orgId: ORG_A,
      topic: "sessions.revoked",
      payload,
    } satisfies OutboxJobData);
    expect(await job?.getState()).toBe("waiting");
    // Nothing consumes the queue yet (P5-04 does): the job waits, the row
    // is never claimed again, and the system queue saw nothing.
    for (let i = 0; i < 3; i += 1) {
      expect(await r.runOnce()).toMatchObject({ claimed: 0, published: 0 });
    }
    expect(await stateOf(id)).toMatchObject({ attempts: 0, dead: false });
    expect(await (await sessionsQueue.getJob(id))?.getState()).toBe("waiting");
    expect(
      await sessionsQueue.getJobCounts("waiting", "failed", "delayed"),
    ).toEqual({ waiting: 1, failed: 0, delayed: 0 });
    expect(await jobIds()).toEqual([]);
    expect(
      r.log.lines.filter((l) => l.level === "warn" || l.level === "error"),
    ).toEqual([]);
  });
});

describe("Done when 9: the runbook's re-drive SQL as bricx_relay (condition 2)", () => {
  /** The SQL between the runbook's redrive markers, with the id as $1. */
  function redriveSql(): string {
    const text = readFileSync(runbook, "utf8");
    // The fenced sql block right after the marker (string search: Semgrep's
    // parser rejects a regex literal holding backticks).
    const fence = "`".repeat(3);
    const marker = text.indexOf("<!-- redrive-sql -->");
    const open = text.indexOf(`${fence}sql\n`, marker);
    const close = text.indexOf(fence, open + fence.length);
    if (marker < 0 || open < 0 || close < 0) {
      throw new Error("runbook: no redrive-sql block");
    }
    expect(text.slice(marker, open).trim()).toBe("<!-- redrive-sql -->");
    const block = text.slice(open + fence.length + 4, close);
    expect(block).toContain(":'outbox_id'");
    return block.replaceAll(":'outbox_id'", "$1").trim().replace(/;$/, "");
  }

  test("a dead row comes back pending with attempts 0, and the relay publishes it", async () => {
    const id = ids.next();
    await asAdmin(
      `INSERT INTO bricx.outbox (id, org_id, topic, payload, attempts, dead_at, last_error)
       VALUES ($1, $2, 'system.ping', '{}', 10, now(), 'publish_rejected')`,
      [id, ORG_A],
    );
    const client = await stack.postgres.connectAs("bricx_relay");
    try {
      const result = await client.query(redriveSql(), [id]);
      expect(result.rowCount).toBe(1);
      // Re-running it is harmless: the row is no longer dead.
      expect((await client.query(redriveSql(), [id])).rowCount).toBe(0);
    } finally {
      await client.end();
    }
    expect(await stateOf(id)).toEqual({
      attempts: 0,
      published: false,
      dead: false,
      last_error: null,
    });
    expect(
      await relay({ publisher: publisherOn(valkey) }).runOnce(),
    ).toMatchObject({ published: 1 });
    expect(await jobIds()).toEqual([id]);
  });

  test("the same SQL as bricx_owner changes nothing (FORCE: the owner has no policy)", async () => {
    const id = ids.next();
    await asAdmin(
      `INSERT INTO bricx.outbox (id, org_id, topic, payload, attempts, dead_at, last_error)
       VALUES ($1, $2, 'system.ping', '{}', 10, now(), 'publish_rejected')`,
      [id, ORG_A],
    );
    const owner = await stack.postgres.connectAs("bricx_owner");
    try {
      expect((await owner.query(redriveSql(), [id])).rowCount).toBe(0);
    } finally {
      await owner.end();
    }
    expect(await stateOf(id)).toMatchObject({ dead: true });
  });
});
