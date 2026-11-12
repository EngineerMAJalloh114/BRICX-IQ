// P6-06b (ADR 0084; Done-when DW17, owner answer Q7): the member activity
// read's service and reader bounds, without a database (the events, RLS
// and the cross-tenant cases are member-activity.int.test.ts).
// - org.audit.read at org scope is checked before any transaction;
// - the membership names the user (404 unknown); the reader is asked for
//   that user's membership ids in THIS org only, one row more than the
//   page, with the cursor as a bigint;
// - the answer is the fixed projection plus byMember; nextCursor is the
//   last item's seq only when a further row exists;
// - the query schema bounds limit (1..100) and cursor (a positive integer
//   of at most 18 digits); the reader refuses a limit outside 1..101.
import type { Tx } from "@bricx/db/database";
import { describe, expect, test } from "vitest";
import {
  type Identity,
  runWithRequestContext,
  setIdentity,
} from "../../src/common/db/request-context.js";
import {
  ACTIVITY_READ_MAX,
  type ActivityRow,
  AuditActivityReader,
} from "../../src/modules/audit/public-api.js";
import {
  ACTIVITY_MEMBERSHIPS_MAX,
  MemberActivityService,
} from "../../src/modules/memberships/member-activity.service.js";
import {
  ACTIVITY_DEFAULT_LIMIT,
  ACTIVITY_MAX_LIMIT,
  ActivityQuery,
} from "../../src/modules/memberships/memberships.dto.js";
import { grantsOf } from "../support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const TARGET = "0199e1a0-0000-7000-8000-000000000002";
const MEMBERSHIP = "0199e1a0-0000-7000-8000-000000000201";
const PROJECT_MEMBERSHIP = "0199e1a0-0000-7000-8000-000000000301";
const TX = {} as unknown as Tx;

const identity = (roles: readonly string[]): Identity => {
  const grants = grantsOf({ roles, projects: [] });
  return {
    userId: USER,
    orgId: ORG,
    projectIds: [],
    allProjects: false,
    grants,
    membershipGrants: grants,
    sessionId: "0199e1a0-0000-7000-8000-00000000005e",
    deviceId: undefined,
    acr: "mfa",
  };
};
const as = <T>(who: Identity, fn: () => Promise<T>) =>
  runWithRequestContext(
    { correlationId: "corr-1", ip: "127.0.0.1", deviceId: undefined },
    async () => {
      setIdentity(who);
      return fn();
    },
  );

const event = (seq: number, actorId: string | null): ActivityRow => ({
  seq: BigInt(seq),
  occurredAt: "2026-11-11T10:00:00.000Z",
  action: "org.member.suspend",
  entityType: "org.member",
  entityId: MEMBERSHIP,
  actorType: actorId === null ? "system" : "user",
  actorId,
  correlationId: `corr-${String(seq)}`,
});

function build(rows: readonly ActivityRow[], known = true) {
  const calls: unknown[] = [];
  const service = new MemberActivityService(
    {
      run: (fn) => {
        calls.push("tx");
        return fn(TX);
      },
    },
    {
      findOrgAny: (_tx, orgId, id) => {
        calls.push(["find", orgId, id]);
        return Promise.resolve(known ? { id, userId: TARGET } : undefined);
      },
      membershipIdsOf: (_tx, orgId, userId, limit) => {
        calls.push(["ids", orgId, userId, limit]);
        return Promise.resolve({
          org: [MEMBERSHIP],
          project: [PROJECT_MEMBERSHIP],
        });
      },
    },
    {
      list: (_tx, subject, page) => {
        calls.push(["read", subject, page]);
        return Promise.resolve(rows.slice(0, page.limit));
      },
    },
  );
  return { service, calls };
}

describe("MemberActivityService.list()", () => {
  test("no org.audit.read: forbidden before any transaction (a member admin's keys are not enough)", async () => {
    const { service, calls } = build([]);
    await expect(
      as(identity(["site_engineer"]), () => service.list(MEMBERSHIP, {})),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toEqual([]);
  });

  test("an unknown membership is not_found and the reader is never asked", async () => {
    const { service, calls } = build([], false);
    await expect(
      as(identity(["auditor"]), () => service.list(MEMBERSHIP, {})),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(calls).toEqual(["tx", ["find", ORG, MEMBERSHIP]]);
  });

  test("the reader is asked for the member's user id and membership ids in the caller's org, one row more than the page, with the cursor as a bigint; the default page is 50", async () => {
    const { service, calls } = build([]);
    const answer = await as(identity(["auditor"]), () =>
      service.list(MEMBERSHIP, { cursor: "42" }),
    );
    expect(answer).toEqual({ items: [], nextCursor: null });
    expect(calls).toEqual([
      "tx",
      ["find", ORG, MEMBERSHIP],
      ["ids", ORG, TARGET, ACTIVITY_MEMBERSHIPS_MAX],
      [
        "read",
        {
          orgId: ORG,
          userId: TARGET,
          orgMembershipIds: [MEMBERSHIP],
          projectMembershipIds: [PROJECT_MEMBERSHIP],
        },
        { before: 42n, limit: ACTIVITY_DEFAULT_LIMIT + 1 },
      ],
    ]);
    expect(ACTIVITY_DEFAULT_LIMIT).toBe(50);
    expect(ACTIVITY_MAX_LIMIT + 1).toBe(ACTIVITY_READ_MAX);
  });

  test("the projection: seq as a string, byMember only when the member was the actor, a system event is 'system'; never the actor's id; nextCursor only when a further row exists", async () => {
    const rows = [event(9, TARGET), event(7, USER), event(5, null)];
    const { service } = build(rows);
    const full = await as(identity(["auditor"]), () =>
      service.list(MEMBERSHIP, { limit: 3 }),
    );
    expect(full.nextCursor).toBeNull();
    expect(full.items).toEqual([
      {
        seq: "9",
        occurredAt: "2026-11-11T10:00:00.000Z",
        action: "org.member.suspend",
        entityType: "org.member",
        entityId: MEMBERSHIP,
        actorType: "user",
        byMember: true,
        correlationId: "corr-9",
      },
      expect.objectContaining({ seq: "7", actorType: "user", byMember: false }),
      expect.objectContaining({
        seq: "5",
        actorType: "system",
        byMember: false,
      }),
    ]);
    expect(JSON.stringify(full)).not.toContain(USER);
    const paged = await as(identity(["auditor"]), () =>
      service.list(MEMBERSHIP, { limit: 2 }),
    );
    expect(paged.items.map((i) => i.seq)).toEqual(["9", "7"]);
    expect(paged.nextCursor).toBe("7");
  });
});

describe("the activity query and the reader's bound", () => {
  test("limit 1..100 and cursor a positive integer of at most 18 digits; anything else, or an unknown field, is refused", () => {
    const parse = (query: unknown) => ActivityQuery.schema.safeParse(query);
    expect(parse({}).success).toBe(true);
    expect(parse({ limit: "1" }).data).toEqual({ limit: 1 });
    expect(parse({ limit: "100", cursor: "999999999999999999" }).data).toEqual({
      limit: 100,
      cursor: "999999999999999999",
    });
    for (const bad of [
      { limit: "0" },
      { limit: "101" },
      { limit: "1000" },
      { limit: "1.5" },
      { limit: "-1" },
      { limit: 5 },
      { cursor: "0" },
      { cursor: "01" },
      { cursor: "1234567890123456789" },
      { cursor: "1e3" },
      { offset: "1" },
    ]) {
      expect(parse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  test("AuditActivityReader refuses a limit outside 1..101 before any statement", async () => {
    const reader = new AuditActivityReader();
    const subject = {
      orgId: ORG,
      userId: TARGET,
      orgMembershipIds: [],
      projectMembershipIds: [],
    };
    for (const limit of [0, -1, ACTIVITY_READ_MAX + 1, 1.5, Number.NaN]) {
      await expect(reader.list(TX, subject, { limit })).rejects.toThrow(
        RangeError,
      );
    }
  });
});
