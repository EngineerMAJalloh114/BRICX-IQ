// The memberships consumer and its 5-minute sweep (P6-06b, ADR 0084;
// Done-when DW10, DW12; owner conditions C8), over fakes:
// - payloads are checked before anything runs (a bad one is
//   unrecoverable: no retry, no value in the message);
// - an open membership past expires_at is recorded ONCE, in one bricx_app
//   transaction in its org (the row, then the audit event as `system`
//   with the outbox id as correlation), then one membership.expired line
//   with ids only;
// - a membership not yet due THROWS MembershipNotDueError (BullMQ
//   retries); a renewed, removed, permanent or already expired one
//   completes with membership.expire_noop; an unseen one with
//   membership.missing;
// - the notice job logs ids only (delivery is P12);
// - the sweep expires every due row with correlation sweep.<id> and
//   writes the missing notices, going on past a failing one, then fails;
// - the failed handler logs ids, counts and the SQLSTATE only;
// - the sweep is registered once on queue memberships.
// Live, against Postgres and Valkey: memberships.int.test.ts.
import type { Tx, TxContext } from "@bricx/db/database";
import {
  type DueMembership,
  type ExpiredMembership,
  MAX_MEMBERSHIPS_DUE,
  type MembershipExpireOutcome,
} from "@bricx/db/memberships";
import { OUTBOX_TOPICS } from "@bricx/db/outbox";
import { UnrecoverableError } from "bullmq";
import { describe, expect, test } from "vitest";
import {
  MEMBERSHIPS_EXPIRE,
  MEMBERSHIPS_EXPIRING,
  MEMBERSHIPS_QUEUE,
  MEMBERSHIPS_SWEEP,
  MEMBERSHIPS_SWEEP_EVERY_MS,
  MEMBERSHIPS_SWEEP_LIMIT,
  MEMBERSHIPS_SWEEP_SCHEDULER_ID,
  type MembershipDeps,
  type MembershipJob,
  MembershipNotDueError,
  onMembershipFailed,
  parseMembershipExpire,
  parseMembershipExpiring,
  processMembershipJob,
  scheduleMembershipSweep,
} from "../src/memberships/consumer.js";
import { dueMembershipReader } from "../src/memberships/due.js";
import {
  type MembershipStatements,
  createMembershipExpirer,
  subjectOf,
} from "../src/memberships/expiry.js";

const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
const ORG_B = "0199e1a0-0000-7000-8000-00000000000b";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const ROLE = "0199e1a0-0000-7000-8000-000000000101";
const PROJECT = "0199e1a0-0000-7000-8000-000000000010";
const M1 = "0199e1a0-0000-7000-8000-0000000000a1";
const M2 = "0199e1a0-0000-7000-8000-0000000000a2";
const OUTBOX = "0199e1a0-0000-7000-8000-0000000000e1";
const END = "2026-11-12T10:00:00.000Z";
const NEEDLE = "needle-6b10: a value that must stay out of the logs";

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

const row = (over: Partial<ExpiredMembership> = {}): ExpiredMembership => ({
  kind: "org",
  id: M1,
  orgId: ORG_A,
  userId: USER,
  roleId: ROLE,
  projectId: null,
  external: false,
  expiresAt: END,
  expiredAt: "2026-11-12T10:00:00.250Z",
  ...over,
});
const expired = (
  over: Partial<ExpiredMembership> = {},
): MembershipExpireOutcome => ({
  state: "expired",
  changed: true,
  membership: row(over),
});
const found = (
  state: MembershipExpireOutcome["state"],
): MembershipExpireOutcome => ({
  state,
  changed: false,
  membership: row({ expiredAt: null }),
});

type Answer = MembershipExpireOutcome | undefined | Error;

function fakes(
  answers: Record<string, Answer> = { [M1]: expired() },
  due: DueMembership[] | Error = [],
  expiring: DueMembership[] = [],
  notices: Record<string, boolean | Error> = {},
): MembershipDeps & { calls: string[]; logger: ReturnType<typeof recorder> } {
  const calls: string[] = [];
  return {
    calls,
    expirer: {
      expire: (membership, correlationId, scheduledFor) => {
        calls.push(
          `expire:${membership.kind}:${membership.id}:${membership.orgId}:${membership.userId}:${correlationId}:${scheduledFor ?? "-"}`,
        );
        const answer = Object.hasOwn(answers, membership.id)
          ? answers[membership.id]
          : undefined;
        return answer instanceof Error
          ? Promise.reject(answer)
          : Promise.resolve(answer);
      },
      notify: (membership) => {
        calls.push(`notify:${membership.kind}:${membership.id}`);
        const answer = notices[membership.id] ?? true;
        return answer instanceof Error
          ? Promise.reject(answer)
          : Promise.resolve(answer);
      },
    },
    due: {
      due: (limit) => {
        calls.push(`due:${String(limit)}`);
        return due instanceof Error
          ? Promise.reject(due)
          : Promise.resolve(due);
      },
      expiring: (limit) => {
        calls.push(`expiring:${String(limit)}`);
        return Promise.resolve(expiring);
      },
    },
    logger: recorder(),
  };
}

const EXPIRE_PAYLOAD = {
  kind: "org",
  membershipId: M1,
  userId: USER,
  expiresAt: END,
};
const job = (
  payload: unknown = EXPIRE_PAYLOAD,
  over: Partial<MembershipJob> = {},
): MembershipJob => ({
  name: MEMBERSHIPS_EXPIRE,
  data: { outboxId: OUTBOX, orgId: ORG_A, topic: MEMBERSHIPS_EXPIRE, payload },
  attemptsMade: 0,
  opts: { attempts: 40 },
  ...over,
});
const NOTICE_PAYLOAD = { kind: "project", membershipId: M2, userId: USER };
const noticeJob = (payload: unknown = NOTICE_PAYLOAD): MembershipJob => ({
  name: MEMBERSHIPS_EXPIRING,
  data: {
    outboxId: OUTBOX,
    orgId: ORG_A,
    topic: MEMBERSHIPS_EXPIRING,
    payload,
  },
  attemptsMade: 0,
  opts: { attempts: 5 },
});
const sweepJob = (over: Partial<MembershipJob> = {}): MembershipJob => ({
  name: MEMBERSHIPS_SWEEP,
  data: {},
  attemptsMade: 0,
  opts: {},
  ...over,
});

describe("the queue, the topics and the sweep's constants", () => {
  test("both topics are registered on queue memberships; the sweep is the worker's own job, every 5 minutes, at most 100 rows of each kind (inside the database's cap)", () => {
    expect(MEMBERSHIPS_QUEUE).toBe("memberships");
    expect(OUTBOX_TOPICS[MEMBERSHIPS_EXPIRE]?.queue).toBe(MEMBERSHIPS_QUEUE);
    expect(OUTBOX_TOPICS[MEMBERSHIPS_EXPIRING]?.queue).toBe(MEMBERSHIPS_QUEUE);
    expect(MEMBERSHIPS_EXPIRE).toBe("memberships.expire");
    expect(MEMBERSHIPS_EXPIRING).toBe("memberships.expiring");
    expect(MEMBERSHIPS_SWEEP).toBe("memberships.sweep");
    expect(MEMBERSHIPS_SWEEP_SCHEDULER_ID).toBe("memberships.sweep");
    expect(OUTBOX_TOPICS[MEMBERSHIPS_SWEEP]).toBeUndefined();
    expect(MEMBERSHIPS_SWEEP_EVERY_MS).toBe(300_000);
    expect(MEMBERSHIPS_SWEEP_LIMIT).toBe(100);
    expect(MEMBERSHIPS_SWEEP_LIMIT).toBeLessThanOrEqual(MAX_MEMBERSHIPS_DUE);
  });
});

describe("parseMembershipExpire() and parseMembershipExpiring()", () => {
  test("accept the registered payloads and the row's org", () => {
    expect(parseMembershipExpire(job())).toEqual({
      kind: "org",
      id: M1,
      orgId: ORG_A,
      userId: USER,
      expiresAt: END,
    });
    expect(parseMembershipExpiring(noticeJob())).toEqual({
      kind: "project",
      id: M2,
      orgId: ORG_A,
      userId: USER,
    });
  });

  test.each([
    ["another job name", job(undefined, { name: MEMBERSHIPS_SWEEP })],
    ["a missing field", job({ kind: "org", membershipId: M1, userId: USER })],
    ["an extra field", job({ ...EXPIRE_PAYLOAD, force: true })],
    ["an unknown kind", job({ ...EXPIRE_PAYLOAD, kind: "site" })],
    ["a non-string id", job({ ...EXPIRE_PAYLOAD, membershipId: 7 })],
    ["an id that is no UUID", job({ ...EXPIRE_PAYLOAD, membershipId: NEEDLE })],
    ["a user id that is no UUID", job({ ...EXPIRE_PAYLOAD, userId: NEEDLE })],
    [
      "an end that is no instant",
      job({ ...EXPIRE_PAYLOAD, expiresAt: NEEDLE }),
    ],
    [
      "an end without milliseconds",
      job({ ...EXPIRE_PAYLOAD, expiresAt: "2026-11-12T10:00:00Z" }),
    ],
    ["a non-object payload", job("x")],
    ["a null payload", job(null)],
    ["no data", job(undefined, { data: undefined })],
    [
      "a data org that is no UUID",
      job(undefined, {
        data: {
          outboxId: OUTBOX,
          orgId: "org",
          topic: MEMBERSHIPS_EXPIRE,
          payload: EXPIRE_PAYLOAD,
        },
      }),
    ],
  ])("expire rejects %s as unrecoverable, naming no value", (_name, bad) => {
    let caught: unknown;
    try {
      parseMembershipExpire(bad);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnrecoverableError);
    expect(String(caught)).not.toContain("needle");
    expect(String(caught)).not.toContain(M1);
  });

  test.each([
    ["the expire payload (four keys)", noticeJob(EXPIRE_PAYLOAD)],
    ["a missing user", noticeJob({ kind: "org", membershipId: M2 })],
    ["an unknown kind", noticeJob({ ...NOTICE_PAYLOAD, kind: "x" })],
    ["the expire job's name", job(NOTICE_PAYLOAD)],
  ])("the notice rejects %s as unrecoverable", (_name, bad) => {
    expect(() => parseMembershipExpiring(bad)).toThrow(UnrecoverableError);
  });
});

describe("processMembershipJob(): an expire job", () => {
  test("a due membership: the expirer ran once, in the job's org for its user, with the outbox id as correlation and the end the job was made for; one membership.expired line, ids only", async () => {
    const deps = fakes();
    await processMembershipJob(job(), deps);
    expect(deps.calls).toEqual([
      `expire:org:${M1}:${ORG_A}:${USER}:${OUTBOX}:${END}`,
    ]);
    expect(deps.logger.lines).toEqual([
      {
        level: "info",
        msg: "membership.expired",
        fields: {
          outboxId: OUTBOX,
          membershipId: M1,
          kind: "org",
          userId: USER,
          orgId: ORG_A,
          source: "job",
          attempt: 1,
        },
      },
    ]);
  });

  test("a membership not yet due (an early job): MembershipNotDueError, so BullMQ retries; never completed as a no-op, nothing logged as done", async () => {
    const deps = fakes({ [M1]: found("open") });
    let caught: unknown;
    try {
      await processMembershipJob(job(), deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(MembershipNotDueError);
    expect(caught).not.toBeInstanceOf(UnrecoverableError);
    expect(caught).toMatchObject({
      code: "membership.expire_not_due",
      name: "MembershipNotDueError",
    });
    expect(String(caught)).not.toContain(M1);
    expect(deps.logger.lines).toEqual([]);
  });

  test.each([["renewed"], ["removed"], ["permanent"], ["expired"]] as const)(
    "a %s membership (a stale job or a replay): one membership.expire_noop line with the state, the job completes",
    async (state) => {
      const deps = fakes({ [M1]: found(state) });
      await processMembershipJob(job(), deps);
      expect(deps.logger.lines).toEqual([
        {
          level: "info",
          msg: "membership.expire_noop",
          fields: { outboxId: OUTBOX, membershipId: M1, kind: "org", state },
        },
      ]);
    },
  );

  test("a membership the transaction cannot see: membership.missing at warn, the job completes", async () => {
    const deps = fakes({});
    await processMembershipJob(job(), deps);
    expect(deps.logger.lines).toEqual([
      {
        level: "warn",
        msg: "membership.missing",
        fields: { outboxId: OUTBOX, membershipId: M1, kind: "org" },
      },
    ]);
  });

  test("the expirer's failure propagates unchanged; a rejected payload runs nothing", async () => {
    const failure = new Error(NEEDLE);
    const failing = fakes({ [M1]: failure });
    await expect(processMembershipJob(job(), failing)).rejects.toBe(failure);
    expect(failing.logger.lines).toEqual([]);
    const deps = fakes();
    await expect(processMembershipJob(job({}), deps)).rejects.toBeInstanceOf(
      UnrecoverableError,
    );
    expect(deps.calls).toEqual([]);
  });
});

describe("processMembershipJob(): the notice job", () => {
  test("one membership.expiring line with the ids (delivery is P12); nothing is written", async () => {
    const deps = fakes();
    await processMembershipJob(noticeJob(), deps);
    expect(deps.calls).toEqual([]);
    expect(deps.logger.lines).toEqual([
      {
        level: "info",
        msg: "membership.expiring",
        fields: {
          outboxId: OUTBOX,
          membershipId: M2,
          kind: "project",
          userId: USER,
          orgId: ORG_A,
        },
      },
    ]);
  });

  test("a bad notice payload is unrecoverable and logs nothing", async () => {
    const deps = fakes();
    await expect(
      processMembershipJob(noticeJob({ kind: "org" }), deps),
    ).rejects.toBeInstanceOf(UnrecoverableError);
    expect(deps.logger.lines).toEqual([]);
  });
});

describe("processMembershipJob(): the sweep job", () => {
  const dueA: DueMembership = {
    kind: "org",
    id: M1,
    orgId: ORG_A,
    userId: USER,
  };
  const dueB: DueMembership = {
    kind: "project",
    id: M2,
    orgId: ORG_B,
    userId: USER,
  };

  test("every due membership of every org is recorded in its own org with correlation sweep.<id> (no scheduled end), then every missing notice is written; one line per expiry and one membership.sweep line with the counts", async () => {
    const deps = fakes(
      { [M1]: expired(), [M2]: found("expired") },
      [dueA, dueB],
      [dueB, dueA],
      { [M1]: false },
    );
    await processMembershipJob(sweepJob(), deps);
    expect(deps.calls).toEqual([
      `due:${String(MEMBERSHIPS_SWEEP_LIMIT)}`,
      `expire:org:${M1}:${ORG_A}:${USER}:sweep.${M1}:-`,
      `expire:project:${M2}:${ORG_B}:${USER}:sweep.${M2}:-`,
      `expiring:${String(MEMBERSHIPS_SWEEP_LIMIT)}`,
      `notify:project:${M2}`,
      `notify:org:${M1}`,
    ]);
    expect(deps.logger.lines).toEqual([
      {
        level: "info",
        msg: "membership.expired",
        fields: {
          membershipId: M1,
          kind: "org",
          userId: USER,
          orgId: ORG_A,
          source: "sweep",
        },
      },
      {
        level: "info",
        msg: "membership.sweep",
        fields: {
          due: 2,
          expired: 1,
          expiring: 2,
          notified: 1,
          skipped: 2,
          failed: 0,
        },
      },
    ]);
  });

  test("nothing due and nothing expiring: one membership.sweep line at debug", async () => {
    const deps = fakes({}, [], []);
    await processMembershipJob(sweepJob(), deps);
    expect(deps.logger.lines).toEqual([
      {
        level: "debug",
        msg: "membership.sweep",
        fields: {
          due: 0,
          expired: 0,
          expiring: 0,
          notified: 0,
          skipped: 0,
          failed: 0,
        },
      },
    ]);
  });

  test("a failing expiry or notice does not stop the sweep: the rest is done, the counts say so, then the job fails (the next run retries); no message in the lines", async () => {
    const deps = fakes(
      { [M1]: new Error(NEEDLE), [M2]: expired({ id: M2, kind: "project" }) },
      [dueA, dueB],
      [dueA, dueB],
      { [M1]: new Error(NEEDLE) },
    );
    let caught: unknown;
    try {
      await processMembershipJob(sweepJob(), deps);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(String(caught)).not.toContain("needle");
    expect(deps.calls).toHaveLength(6);
    expect(deps.logger.lines.at(-1)).toEqual({
      level: "info",
      msg: "membership.sweep",
      fields: {
        due: 2,
        expired: 1,
        expiring: 2,
        notified: 1,
        skipped: 0,
        failed: 2,
      },
    });
    expect(JSON.stringify(deps.logger.lines)).not.toContain("needle");
  });

  test("the reader's failure propagates (the job fails; the next run reads again)", async () => {
    const failure = new Error("database unavailable");
    const deps = fakes({}, failure);
    await expect(processMembershipJob(sweepJob(), deps)).rejects.toBe(failure);
    expect(deps.logger.lines).toEqual([]);
  });
});

describe("onMembershipFailed()", () => {
  const pgError = (code: string) => Object.assign(new Error(NEEDLE), { code });

  test("a rejected payload: membership.rejected at error, the outbox id only", () => {
    const log = recorder();
    onMembershipFailed(job(), new UnrecoverableError(NEEDLE), log);
    expect(log.lines).toEqual([
      {
        level: "error",
        msg: "membership.rejected",
        fields: { outboxId: OUTBOX },
      },
    ]);
  });

  test("not yet due, attempts left: one membership.retry line at debug saying so; a database failure carries the SQLSTATE, never the message", () => {
    const log = recorder();
    onMembershipFailed(
      job(undefined, { attemptsMade: 1 }),
      new MembershipNotDueError(),
      log,
    );
    onMembershipFailed(
      job(undefined, { attemptsMade: 3 }),
      pgError("40001"),
      log,
    );
    expect(log.lines).toEqual([
      {
        level: "debug",
        msg: "membership.retry",
        fields: {
          outboxId: OUTBOX,
          membershipId: M1,
          attempt: 1,
          notDue: true,
          sqlstate: undefined,
        },
      },
      {
        level: "debug",
        msg: "membership.retry",
        fields: {
          outboxId: OUTBOX,
          membershipId: M1,
          attempt: 3,
          notDue: false,
          sqlstate: "40001",
        },
      },
    ]);
    expect(JSON.stringify(log.lines)).not.toContain("needle");
  });

  test("the last failure: membership.expire_failed at error with ids, attempts and the SQLSTATE; a sweep's failure: membership.sweep_failed with the attempt count; no job: undefined ids", () => {
    const log = recorder();
    onMembershipFailed(
      job(undefined, { attemptsMade: 40 }),
      pgError("57014"),
      log,
    );
    onMembershipFailed(sweepJob({ attemptsMade: 1 }), new Error(NEEDLE), log);
    onMembershipFailed(undefined, new Error(NEEDLE), log);
    expect(log.lines).toEqual([
      {
        level: "error",
        msg: "membership.expire_failed",
        fields: {
          outboxId: OUTBOX,
          membershipId: M1,
          attempts: 40,
          sqlstate: "57014",
        },
      },
      {
        level: "error",
        msg: "membership.sweep_failed",
        fields: { attempts: 1 },
      },
      {
        level: "error",
        msg: "membership.expire_failed",
        fields: {
          outboxId: undefined,
          membershipId: undefined,
          attempts: undefined,
          sqlstate: undefined,
        },
      },
    ]);
    expect(JSON.stringify(log.lines)).not.toContain("needle");
  });
});

describe("scheduleMembershipSweep()", () => {
  test("registers the sweep through the publisher: queue memberships, the scheduler id, every 5 minutes, the sweep job name", async () => {
    const calls: unknown[] = [];
    await scheduleMembershipSweep({
      schedule: (queue, schedulerId, everyMs, name) => {
        calls.push([queue, schedulerId, everyMs, name]);
        return Promise.resolve();
      },
    });
    expect(calls).toEqual([
      [
        MEMBERSHIPS_QUEUE,
        MEMBERSHIPS_SWEEP_SCHEDULER_ID,
        MEMBERSHIPS_SWEEP_EVERY_MS,
        MEMBERSHIPS_SWEEP,
      ],
    ]);
  });
});

describe("createMembershipExpirer(): one transaction per membership", () => {
  // A transaction handle the fakes pass through; nothing here runs SQL.
  const TX = { tag: "tx" } as unknown as Tx;
  const due: DueMembership = {
    kind: "project",
    id: M2,
    orgId: ORG_B,
    userId: USER,
  };

  function build(
    outcome: MembershipExpireOutcome | undefined,
    options: { claimed?: boolean; failAt?: "record" | "enqueue" } = {},
  ) {
    const calls: unknown[] = [];
    let committed = 0;
    let nextId = 0;
    const statements: MembershipStatements = {
      expire: (tx, kind, id, scheduledFor) => {
        calls.push(["expire", tx === TX, kind, id, scheduledFor]);
        return Promise.resolve(outcome);
      },
      record: (tx, recorder, event, origin) => {
        calls.push(["record", tx === TX, recorder.actor, event, origin]);
        if (options.failAt === "record") return Promise.reject(new Error("x"));
        return Promise.resolve({ id: "e", seq: 1n, hash: "h" } as never);
      },
      claimNotice: (tx, kind, id) => {
        calls.push(["claim", tx === TX, kind, id]);
        return Promise.resolve(options.claimed ?? true);
      },
      enqueue: (tx, topic, payload, id) => {
        calls.push(["enqueue", tx === TX, topic, payload, id]);
        if (options.failAt === "enqueue") return Promise.reject(new Error("x"));
        return Promise.resolve();
      },
    };
    const expirer = createMembershipExpirer({
      database: {
        withTx: async <T>(context: TxContext, fn: (tx: Tx) => Promise<T>) => {
          calls.push(["tx", context]);
          const result = await fn(TX);
          committed += 1;
          return result;
        },
      },
      clock: { now: () => 0 },
      ids: {
        next: () => {
          nextId += 1;
          return `id-${String(nextId)}`;
        },
      },
      statements,
    });
    return { expirer, calls, committed: () => committed };
  }
  const context = {
    orgId: ORG_B,
    userId: USER,
    projectIds: [],
    allProjects: true,
  };

  test("subjects: org.member and project.member", () => {
    expect(subjectOf("org")).toBe("org.member");
    expect(subjectOf("project")).toBe("project.member");
  });

  test("a due membership: one transaction in its org as its user; the row first, then ONE audit event as system (project.member.expire, before expiredAt null, after the row, the given correlation)", async () => {
    const membership = row({
      kind: "project",
      id: M2,
      orgId: ORG_B,
      projectId: PROJECT,
    });
    const f = build({ state: "expired", changed: true, membership });
    const outcome = await f.expirer.expire(due, "sweep.x", END);
    expect(outcome?.changed).toBe(true);
    expect(f.calls).toEqual([
      ["tx", context],
      ["expire", true, "project", M2, END],
      [
        "record",
        true,
        "system",
        {
          action: "project.member.expire",
          entityType: "project.member",
          entityId: M2,
          before: { ...membership, expiredAt: null },
          after: membership,
        },
        { correlationId: "sweep.x" },
      ],
    ]);
    expect(f.committed()).toBe(1);
  });

  test("no change (not due, renewed, removed, expired) or no row: no audit event", async () => {
    for (const outcome of [found("open"), found("renewed"), undefined]) {
      const f = build(outcome);
      expect(await f.expirer.expire(due, "c")).toBe(outcome);
      expect(f.calls.map((c) => (c as unknown[])[0])).toEqual(["tx", "expire"]);
    }
  });

  test("the audit event failing fails the transaction: never expired without its event", async () => {
    const f = build(expired(), { failAt: "record" });
    await expect(f.expirer.expire(due, "c")).rejects.toThrow();
    expect(f.committed()).toBe(0);
  });

  test("notify: the row's one notice is claimed first, then one memberships.expiring outbox row with ids only; a row already claimed writes nothing (false); a failing insert fails the claim's transaction", async () => {
    const f = build(undefined);
    expect(await f.expirer.notify(due)).toBe(true);
    expect(f.calls).toEqual([
      ["tx", context],
      ["claim", true, "project", M2],
      [
        "enqueue",
        true,
        "memberships.expiring",
        { kind: "project", membershipId: M2, userId: USER },
        "id-1",
      ],
    ]);
    const taken = build(undefined, { claimed: false });
    expect(await taken.expirer.notify(due)).toBe(false);
    expect(taken.calls.map((c) => (c as unknown[])[0])).toEqual([
      "tx",
      "claim",
    ]);
    const failing = build(undefined, { failAt: "enqueue" });
    await expect(failing.expirer.notify(due)).rejects.toThrow();
    expect(failing.committed()).toBe(0);
  });
});

describe("dueMembershipReader()", () => {
  test("a limit outside 1..1000 is refused before the relay transaction opens", async () => {
    let opened = 0;
    const reader = dueMembershipReader({
      withRelayTx: () => {
        opened += 1;
        return Promise.reject(new Error("unreachable"));
      },
    });
    for (const limit of [0, -1, MAX_MEMBERSHIPS_DUE + 1, 1.5, Number.NaN]) {
      await expect(reader.due(limit)).rejects.toThrow(RangeError);
      await expect(reader.expiring(limit)).rejects.toThrow(RangeError);
    }
    expect(opened).toBe(0);
    await expect(reader.due(1)).rejects.toThrow("unreachable");
    await expect(reader.expiring(MAX_MEMBERSHIPS_DUE)).rejects.toThrow(
      "unreachable",
    );
    expect(opened).toBe(2);
  });
});
