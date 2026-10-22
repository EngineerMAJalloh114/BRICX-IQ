// The access_grants.expire consumer and the 5-minute sweep (P5-06, D-G,
// owner conditions 3, 4 and 6, ADR 0067; Done-when DW4), over fakes:
// - the payload is checked before anything runs (a bad one is
//   unrecoverable: no retry);
// - an open grant past expires_at is expired ONCE, in one bricx_app
//   transaction in the grant's org (the row, the audit event as `system`
//   with the outbox id as correlation, the users.mfa_check row), then one
//   access.expired line with ids only;
// - a grant not yet due (condition 3) THROWS AccessNotDueError: BullMQ
//   retries it with the topic's delivery options; it never completes as a
//   no-op;
// - a replayed, revoked or already expired grant completes with one
//   access.expire_noop line; a grant the transaction cannot see with
//   access.grant_missing;
// - the sweep job reads the due grants through the relay's transaction and
//   expires each with a `sweep.<grant id>` correlation, going on past a
//   failing one;
// - the failed handler logs ids, counts and the SQLSTATE only; a message
//   never reaches the lines (condition 6);
// - the sweep is registered once (upsertJobScheduler, condition 6).
// Live, against Postgres, Valkey and Keycloak: access.int.test.ts.
import type {
  DueAccessGrant,
  ExpireOutcome,
  ExpiredAccessGrant,
} from "@bricx/db/access-grants";
import { MAX_DUE } from "@bricx/db/access-grants";
import type { Tx, TxContext } from "@bricx/db/database";
import { OUTBOX_TOPICS } from "@bricx/db/outbox";
import { UnrecoverableError } from "bullmq";
import { describe, expect, test } from "vitest";
import {
  ACCESS_GRANTS_EXPIRE,
  ACCESS_QUEUE,
  ACCESS_SWEEP,
  type AccessDeps,
  type AccessJob,
  AccessNotDueError,
  SWEEP_EVERY_MS,
  SWEEP_LIMIT,
  SWEEP_SCHEDULER_ID,
  onAccessFailed,
  parseAccessExpire,
  processAccessJob,
  scheduleSweep,
} from "../src/access/consumer.js";
import { dueReader } from "../src/access/due.js";
import {
  ACCESS_GRANT_EXPIRE_ACTION,
  ACCESS_GRANT_SUBJECT,
  type ExpiryStatements,
  createAccessExpirer,
} from "../src/access/expiry.js";

const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const GRANTER = "0199e1a0-0000-7000-8000-000000000002";
const GRANT = "0199e1a0-0000-7000-8000-0000000000a1";
const GRANT_B = "0199e1a0-0000-7000-8000-0000000000a2";
const OUTBOX = "0199e1a0-0000-7000-8000-0000000000e1";
const NEEDLE = "needle-5c2e: a value that must stay out of the logs";

type Logged = { level: string; msg: string; fields: Record<string, unknown> };
function recorder() {
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

const row = (over: Partial<ExpiredAccessGrant> = {}): ExpiredAccessGrant => ({
  id: GRANT,
  orgId: ORG_A,
  userId: USER,
  permission: "org.role.read.org",
  scopeId: null,
  grantedBy: GRANTER,
  startsAt: "2026-10-22T10:00:00.000Z",
  expiresAt: "2026-10-22T10:01:00.000Z",
  revokedAt: null,
  revokedBy: null,
  expiredAt: "2026-10-22T10:01:00.250Z",
  ...over,
});

const expired = (id = GRANT): ExpireOutcome => ({
  state: "expired",
  changed: true,
  grant: row({ id }),
});
const found = (
  state: ExpireOutcome["state"],
  over: Partial<ExpiredAccessGrant> = {},
): ExpireOutcome => ({
  state,
  changed: false,
  grant: row({ expiredAt: null, ...over }),
});

type Answer = ExpireOutcome | undefined | Error;

/** The consumer's dependencies: an expirer and a due reader answering per grant id. */
function fakes(
  answers: Record<string, Answer> = { [GRANT]: expired() },
  due: DueAccessGrant[] | Error = [],
): AccessDeps & { calls: string[]; logger: ReturnType<typeof recorder> } {
  const calls: string[] = [];
  return {
    calls,
    expirer: {
      expire: (grant, correlationId) => {
        calls.push(`expire:${grant.id}:${grant.orgId}:${grant.userId}:${correlationId}`);
        const answer = Object.hasOwn(answers, grant.id)
          ? answers[grant.id]
          : undefined;
        return answer instanceof Error
          ? Promise.reject(answer)
          : Promise.resolve(answer);
      },
    },
    due: {
      read: (limit) => {
        calls.push(`due:${String(limit)}`);
        return due instanceof Error
          ? Promise.reject(due)
          : Promise.resolve(due);
      },
    },
    logger: recorder(),
  };
}

const job = (
  payload: unknown = { grantId: GRANT, userId: USER },
  over: Partial<AccessJob> = {},
): AccessJob => ({
  name: ACCESS_GRANTS_EXPIRE,
  data: { outboxId: OUTBOX, orgId: ORG_A, topic: ACCESS_GRANTS_EXPIRE, payload },
  attemptsMade: 0,
  opts: { attempts: 40 },
  ...over,
});

const sweepJob = (over: Partial<AccessJob> = {}): AccessJob => ({
  name: ACCESS_SWEEP,
  data: {},
  attemptsMade: 0,
  opts: {},
  ...over,
});

describe("the queue and the sweep's constants", () => {
  test("access_grants.expire is consumed from queue access, as the topic registers it", () => {
    expect(ACCESS_QUEUE).toBe("access");
    expect(OUTBOX_TOPICS["access_grants.expire"]?.queue).toBe(ACCESS_QUEUE);
    expect(ACCESS_GRANTS_EXPIRE).toBe("access_grants.expire");
  });

  test("the sweep runs every 5 minutes, reads at most 100 due grants (inside the database's cap), under one scheduler id", () => {
    expect(SWEEP_EVERY_MS).toBe(300_000);
    expect(SWEEP_LIMIT).toBe(100);
    expect(SWEEP_LIMIT).toBeLessThanOrEqual(MAX_DUE);
    expect(ACCESS_SWEEP).toBe("access_grants.sweep");
    expect(SWEEP_SCHEDULER_ID).toBe("access_grants.sweep");
    // Not an outbox topic: the sweep is the worker's own job.
    expect(OUTBOX_TOPICS[ACCESS_SWEEP]).toBeUndefined();
  });
});

describe("parseAccessExpire()", () => {
  test("accepts the registered payload and the row's org", () => {
    expect(parseAccessExpire(job())).toEqual({
      grantId: GRANT,
      userId: USER,
      orgId: ORG_A,
    });
  });

  test.each([
    ["another job name", job(undefined, { name: ACCESS_SWEEP })],
    ["a missing field", job({ grantId: GRANT })],
    ["an extra field", job({ grantId: GRANT, userId: USER, force: true })],
    ["a non-string id", job({ grantId: 7, userId: USER })],
    ["an id that is no UUID", job({ grantId: "not-a-uuid", userId: USER })],
    ["a user id that is no UUID", job({ grantId: GRANT, userId: NEEDLE })],
    ["a non-object payload", job("x")],
    ["no data", job(undefined, { data: undefined })],
    [
      "a data org that is no UUID",
      job(undefined, {
        data: { outboxId: OUTBOX, orgId: "org", topic: ACCESS_GRANTS_EXPIRE, payload: { grantId: GRANT, userId: USER } },
      }),
    ],
  ])("rejects %s as unrecoverable, naming no value", (_name, bad) => {
    let caught: unknown;
    try {
      parseAccessExpire(bad);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnrecoverableError);
    expect(String(caught)).not.toContain(NEEDLE);
    expect(String(caught)).not.toContain(GRANT);
  });
});

describe("processAccessJob(): an expire job", () => {
  test("an open grant past expires_at: the expirer ran once, in the job's org for its user with the outbox id as correlation; one access.expired line, ids only", async () => {
    const deps = fakes();
    await processAccessJob(job(), deps);
    expect(deps.calls).toEqual([`expire:${GRANT}:${ORG_A}:${USER}:${OUTBOX}`]);
    expect(deps.logger.lines).toEqual([
      {
        level: "info",
        msg: "access.expired",
        fields: {
          outboxId: OUTBOX,
          grantId: GRANT,
          userId: USER,
          orgId: ORG_A,
          source: "job",
          attempt: 1,
        },
      },
    ]);
  });

  test.each([["open"], ["pending"]] as const)(
    "a grant not yet due (%s): AccessNotDueError, no retry-free completion, nothing logged as done (condition 3)",
    async (state) => {
      const deps = fakes({ [GRANT]: found(state) });
      let caught: unknown;
      try {
        await processAccessJob(job(), deps);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(AccessNotDueError);
      expect(caught).not.toBeInstanceOf(UnrecoverableError);
      expect(caught).toMatchObject({ code: "access.expire_not_due", state });
      expect(String(caught)).not.toContain(GRANT);
      expect(deps.calls).toHaveLength(1);
      expect(deps.logger.lines).toEqual([]);
    },
  );

  test.each([
    ["revoked", found("revoked", { revokedAt: "2026-10-22T10:00:30.000Z", revokedBy: GRANTER })],
    ["expired", found("expired", { expiredAt: "2026-10-22T10:01:00.250Z" })],
  ] as const)(
    "a %s grant (a replay, or revoked first): one access.expire_noop line with the state, the job completes",
    async (state, outcome) => {
      const deps = fakes({ [GRANT]: outcome });
      await processAccessJob(job(), deps);
      expect(deps.logger.lines).toEqual([
        {
          level: "info",
          msg: "access.expire_noop",
          fields: { outboxId: OUTBOX, grantId: GRANT, state },
        },
      ]);
    },
  );

  test("a grant the transaction cannot see: access.grant_missing at warn, the job completes", async () => {
    const deps = fakes({});
    await processAccessJob(job(), deps);
    expect(deps.logger.lines).toEqual([
      {
        level: "warn",
        msg: "access.grant_missing",
        fields: { outboxId: OUTBOX, grantId: GRANT },
      },
    ]);
  });

  test("the expirer's failure propagates unchanged (BullMQ retries); nothing is logged here", async () => {
    const failure = new Error(NEEDLE);
    const deps = fakes({ [GRANT]: failure });
    await expect(processAccessJob(job(), deps)).rejects.toBe(failure);
    expect(deps.logger.lines).toEqual([]);
  });

  test("a rejected payload runs nothing", async () => {
    const deps = fakes();
    await expect(processAccessJob(job({}), deps)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(deps.calls).toEqual([]);
  });
});

describe("processAccessJob(): the sweep job", () => {
  const dueA: DueAccessGrant = { id: GRANT, orgId: ORG_A, userId: USER };
  const dueB: DueAccessGrant = {
    id: GRANT_B,
    orgId: "0199e1a0-0000-7000-8000-00000000000b",
    userId: GRANTER,
  };

  test("reads up to SWEEP_LIMIT due grants through the reader and expires each in its own org with correlation sweep.<grant id>; one access.expired line per change and one access.sweep line with the counts", async () => {
    const deps = fakes(
      { [GRANT]: expired(), [GRANT_B]: found("expired") },
      [dueA, dueB],
    );
    await processAccessJob(sweepJob(), deps);
    expect(deps.calls).toEqual([
      `due:${String(SWEEP_LIMIT)}`,
      `expire:${GRANT}:${ORG_A}:${USER}:sweep.${GRANT}`,
      `expire:${GRANT_B}:${dueB.orgId}:${GRANTER}:sweep.${GRANT_B}`,
    ]);
    expect(deps.logger.lines).toEqual([
      {
        level: "info",
        msg: "access.expired",
        fields: {
          grantId: GRANT,
          userId: USER,
          orgId: ORG_A,
          source: "sweep",
        },
      },
      {
        level: "info",
        msg: "access.sweep",
        fields: { due: 2, expired: 1, skipped: 1, failed: 0 },
      },
    ]);
  });

  test("nothing due: one access.sweep line at debug", async () => {
    const deps = fakes({}, []);
    await processAccessJob(sweepJob(), deps);
    expect(deps.calls).toEqual([`due:${String(SWEEP_LIMIT)}`]);
    expect(deps.logger.lines).toEqual([
      {
        level: "debug",
        msg: "access.sweep",
        fields: { due: 0, expired: 0, skipped: 0, failed: 0 },
      },
    ]);
  });

  test("a failing grant does not stop the sweep: the rest is expired, the counts say so, then the job fails (the next run retries it); no message in the lines", async () => {
    const deps = fakes(
      { [GRANT]: new Error(NEEDLE), [GRANT_B]: expired(GRANT_B) },
      [dueA, dueB],
    );
    let caught: unknown;
    try {
      await processAccessJob(sweepJob(), deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain(NEEDLE);
    expect(deps.calls).toHaveLength(3);
    expect(deps.logger.lines.map((l) => l.msg)).toEqual([
      "access.expired",
      "access.sweep",
    ]);
    expect(deps.logger.lines[1]?.fields).toEqual({
      due: 2,
      expired: 1,
      skipped: 0,
      failed: 1,
    });
    expect(JSON.stringify(deps.logger.lines)).not.toContain(NEEDLE);
  });

  test("the reader's failure propagates (the job fails; the next run reads again)", async () => {
    const failure = new Error("database unavailable");
    const deps = fakes({}, failure);
    await expect(processAccessJob(sweepJob(), deps)).rejects.toBe(failure);
    expect(deps.logger.lines).toEqual([]);
  });
});

describe("onAccessFailed()", () => {
  const pgError = (code: string) => Object.assign(new Error(NEEDLE), { code });

  test("a rejected payload: access.rejected at error, the outbox id only", () => {
    const log = recorder();
    onAccessFailed(job(), new UnrecoverableError(NEEDLE), log);
    expect(log.lines).toEqual([
      { level: "error", msg: "access.rejected", fields: { outboxId: OUTBOX } },
    ]);
  });

  test("a grant not yet due, attempts left: one access.retry line at debug saying so", () => {
    const log = recorder();
    onAccessFailed(
      job(undefined, { attemptsMade: 1 }),
      new AccessNotDueError("open"),
      log,
    );
    expect(log.lines).toEqual([
      {
        level: "debug",
        msg: "access.retry",
        fields: { outboxId: OUTBOX, grantId: GRANT, attempt: 1, notDue: true, sqlstate: undefined },
      },
    ]);
  });

  test("a database failure with attempts left: access.retry with the SQLSTATE, never the message", () => {
    const log = recorder();
    onAccessFailed(job(undefined, { attemptsMade: 3 }), pgError("40001"), log);
    expect(log.lines).toEqual([
      {
        level: "debug",
        msg: "access.retry",
        fields: { outboxId: OUTBOX, grantId: GRANT, attempt: 3, notDue: false, sqlstate: "40001" },
      },
    ]);
    expect(JSON.stringify(log.lines)).not.toContain(NEEDLE);
  });

  test("the last failure: access.expire_failed at error with ids, attempts and the SQLSTATE (P13-05 alerts on it)", () => {
    const log = recorder();
    onAccessFailed(job(undefined, { attemptsMade: 40 }), pgError("57014"), log);
    expect(log.lines).toEqual([
      {
        level: "error",
        msg: "access.expire_failed",
        fields: { outboxId: OUTBOX, grantId: GRANT, attempts: 40, sqlstate: "57014" },
      },
    ]);
    expect(JSON.stringify(log.lines)).not.toContain(NEEDLE);
  });

  test("a sweep job's failure: access.sweep_failed at error, the attempt count only", () => {
    const log = recorder();
    onAccessFailed(sweepJob({ attemptsMade: 1 }), new Error(NEEDLE), log);
    expect(log.lines).toEqual([
      { level: "error", msg: "access.sweep_failed", fields: { attempts: 1 } },
    ]);
  });

  test("no job (BullMQ lost it): the line still comes, with undefined ids", () => {
    const log = recorder();
    onAccessFailed(undefined, new Error(NEEDLE), log);
    expect(log.lines).toEqual([
      {
        level: "error",
        msg: "access.expire_failed",
        fields: { outboxId: undefined, grantId: undefined, attempts: undefined, sqlstate: undefined },
      },
    ]);
  });
});

describe("scheduleSweep()", () => {
  test("registers the sweep through the publisher: queue access, the scheduler id, every 5 minutes, the sweep job name (the publisher upserts, so N workers share one schedule)", async () => {
    const calls: unknown[] = [];
    await scheduleSweep({
      schedule: (queue, schedulerId, everyMs, name) => {
        calls.push([queue, schedulerId, everyMs, name]);
        return Promise.resolve();
      },
    });
    expect(calls).toEqual([
      [ACCESS_QUEUE, SWEEP_SCHEDULER_ID, SWEEP_EVERY_MS, ACCESS_SWEEP],
    ]);
  });
});

describe("createAccessExpirer(): one transaction per grant", () => {
  // A transaction handle the fakes pass through; nothing here runs SQL.
  const TX = { tag: "tx" } as unknown as Tx;
  const CLOCK = { now: () => 1_792_000_000_000 };

  function world(outcome: ExpireOutcome | undefined, throwIn?: keyof ExpiryStatements) {
    const calls: string[] = [];
    const contexts: TxContext[] = [];
    const events: unknown[] = [];
    let nextId = 0;
    const statements: ExpiryStatements = {
      expire: (tx, grantId) => {
        calls.push(`expire:${grantId}`);
        if (throwIn === "expire") return Promise.reject(new Error(NEEDLE));
        expect(tx).toBe(TX);
        return Promise.resolve(outcome);
      },
      record: (tx, options, event, origin) => {
        calls.push("record");
        expect(tx).toBe(TX);
        events.push({ options, event, origin });
        if (throwIn === "record") return Promise.reject(new Error(NEEDLE));
        return Promise.resolve({ id: "e", seq: "1", hash: "00" });
      },
      enqueue: (tx, topic, payload, id) => {
        calls.push(`enqueue:${topic}:${JSON.stringify(payload)}:${id}`);
        expect(tx).toBe(TX);
        return Promise.resolve();
      },
    };
    const database = {
      withTx<T>(context: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T> {
        contexts.push(context);
        calls.push("tx");
        return fn(TX);
      },
    };
    const expirer = createAccessExpirer({
      database,
      clock: CLOCK,
      ids: { next: () => `id-${String((nextId += 1))}` },
      statements,
    });
    return { expirer, calls, contexts, events };
  }

  test("changed: one withTx() in the grant's org as its user with no projects; the update, then the audit event as `system` with before/after and the correlation, then one users.mfa_check row, in that order", async () => {
    const w = world(expired());
    const outcome = await w.expirer.expire(
      { id: GRANT, orgId: ORG_A, userId: USER },
      OUTBOX,
    );
    expect(outcome).toEqual(expired());
    expect(w.contexts).toEqual([{ orgId: ORG_A, userId: USER, projectIds: [] }]);
    expect(w.calls).toEqual([
      "tx",
      `expire:${GRANT}`,
      "record",
      `enqueue:users.mfa_check:${JSON.stringify({ userId: USER })}:id-1`,
    ]);
    expect(w.events).toEqual([
      {
        options: { clock: CLOCK, ids: expect.anything(), actor: "system" },
        event: {
          action: ACCESS_GRANT_EXPIRE_ACTION,
          entityType: ACCESS_GRANT_SUBJECT,
          entityId: GRANT,
          before: row({ expiredAt: null }),
          after: row(),
        },
        origin: { correlationId: OUTBOX },
      },
    ]);
    expect(ACCESS_GRANT_EXPIRE_ACTION).toBe("org.access_grant.expire");
    expect(ACCESS_GRANT_SUBJECT).toBe("org.access_grant");
    // The reason is never read, so it can never be audited twice or logged.
    expect(JSON.stringify(w.events)).not.toContain("reason");
  });

  test("not changed (open, pending, revoked, expired): the state comes back, no event and no row are written", async () => {
    for (const state of ["open", "pending", "revoked", "expired"] as const) {
      const w = world(found(state));
      expect(
        await w.expirer.expire({ id: GRANT, orgId: ORG_A, userId: USER }, OUTBOX),
      ).toMatchObject({ state, changed: false });
      expect(w.calls).toEqual(["tx", `expire:${GRANT}`]);
    }
  });

  test("no row: undefined, nothing written", async () => {
    const w = world(undefined);
    expect(
      await w.expirer.expire({ id: GRANT, orgId: ORG_A, userId: USER }, OUTBOX),
    ).toBeUndefined();
    expect(w.calls).toEqual(["tx", `expire:${GRANT}`]);
  });

  test("a failing statement rolls the transaction back (the error propagates; nothing after it runs)", async () => {
    const w = world(expired(), "record");
    await expect(
      w.expirer.expire({ id: GRANT, orgId: ORG_A, userId: USER }, OUTBOX),
    ).rejects.toThrow(NEEDLE);
    expect(w.calls).toEqual(["tx", `expire:${GRANT}`, "record"]);
  });
});

describe("dueReader(): the sweep's read through the relay's transaction", () => {
  test("reads app.access_grants_due(limit) inside withRelayTx() and maps the rows", async () => {
    const calls: string[] = [];
    // A transaction whose execute() answers the function's rows; the SQL
    // text itself is proven live (access.int.test.ts).
    const tx = {
      execute: () => {
        calls.push("execute");
        return Promise.resolve({
          rows: [{ id: GRANT, org_id: ORG_A, user_id: USER }],
        });
      },
    } as unknown as Tx;
    const reader = dueReader({
      withRelayTx: <T>(fn: (t: Tx) => Promise<T>) => {
        calls.push("relayTx");
        return fn(tx);
      },
    });
    expect(await reader.read(100)).toEqual([
      { id: GRANT, orgId: ORG_A, userId: USER },
    ]);
    expect(calls).toEqual(["relayTx", "execute"]);
  });

  test("a limit outside 1..MAX_DUE is refused before any transaction", async () => {
    const reader = dueReader({
      withRelayTx: () => Promise.reject(new Error("must not open")),
    });
    await expect(reader.read(0)).rejects.toThrow(RangeError);
    await expect(reader.read(MAX_DUE + 1)).rejects.toThrow(RangeError);
  });
});
