// The ownership-transfers service without a database (P6-06c, ADR 0085):
// over plain fakes, the order of its checks (the members lock first, the
// caller is an ACTIVE owner by system_key, the typed name folded with NFKC
// and trim, the recipient and the previous role, one pending transfer, a
// due one expired lazily at the Clock), what one transaction writes (the
// row, the mfa checks, the delayed ownership.expire job, the audit
// events), the SoD refusal with one denial after the rollback (Q1), the
// 409 at expires_at with nothing written, and the pending read. End to
// end, against Postgres: ownership-transfers.int.test.ts.
import type { Tx } from "@bricx/db/database";
import { PinoLogger } from "nestjs-pino";
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import {
  type Identity,
  runWithRequestContext,
  setIdentity,
} from "../../src/common/db/request-context.js";
import {
  ApiError,
  ValidationError,
} from "../../src/common/errors/api-error.js";
import type { OwnershipTransferData } from "../../src/modules/ownership-transfers/ownership-transfers.dto.js";
import { OWNERSHIP_EXPIRE } from "../../src/modules/ownership-transfers/ownership-transfers.events.js";
import type { OwnershipTransfersRepository } from "../../src/modules/ownership-transfers/ownership-transfers.repository.js";
import {
  OwnershipTransfersService,
  TRANSFER_TTL_MS,
  foldName,
} from "../../src/modules/ownership-transfers/ownership-transfers.service.js";
import { grantsOf } from "../support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const OWNER = "0199e1a0-0000-7000-8000-000000000001";
const MEMBER = "0199e1a0-0000-7000-8000-000000000002";
const STRANGER = "0199e1a0-0000-7000-8000-000000000003";
const OWNER_M = "0199e1a0-0000-7000-8000-0000000000a1";
const MEMBER_M = "0199e1a0-0000-7000-8000-0000000000a2";
const OWNER_ROLE = "0199e1a0-0000-7000-8000-000000000100";
const ADMIN_ROLE = "0199e1a0-0000-7000-8000-000000000101";
const TRANSFER = "0199e1a0-0000-7000-8000-0000000000d1";
const SESSION = "0199e1a0-0000-7000-8000-00000000005e";
const LEGAL = "Acme Construction Ltd";
const NOW_MS = Date.UTC(2026, 10, 13, 12, 0, 0);
const NOW = new Date(NOW_MS).toISOString();
const LATER = new Date(NOW_MS + TRANSFER_TTL_MS).toISOString();

const identity = (userId: string, acr: "mfa" | "pwd" = "mfa"): Identity => ({
  orgId: ORG,
  userId,
  projectIds: [],
  allProjects: true,
  grants: grantsOf({ roles: ["owner"] }),
  membershipGrants: grantsOf({ roles: ["owner"] }),
  sessionId: SESSION,
  deviceId: undefined,
  acr,
});

const as = <T>(who: Identity, fn: () => Promise<T>) =>
  runWithRequestContext(
    { correlationId: "corr-1", ip: "127.0.0.1", deviceId: undefined },
    () => {
      setIdentity(who);
      return fn();
    },
  );

interface Member {
  id: string;
  roleId: string;
  systemKey: string | null;
  suspendedAt: string | null;
  expiresAt: string | null;
  external: boolean;
}

const owner = (over: Partial<Member> = {}): Member => ({
  id: OWNER_M,
  roleId: OWNER_ROLE,
  systemKey: "owner",
  suspendedAt: null,
  expiresAt: null,
  external: false,
  ...over,
});
const member = (over: Partial<Member> = {}): Member => ({
  id: MEMBER_M,
  roleId: ADMIN_ROLE,
  systemKey: null,
  suspendedAt: null,
  expiresAt: null,
  external: false,
  ...over,
});

const transfer = (
  over: Partial<OwnershipTransferData> = {},
): OwnershipTransferData => ({
  id: TRANSFER,
  status: "pending",
  initiatedBy: OWNER,
  toUserId: MEMBER,
  previousOwnerRoleId: ADMIN_ROLE,
  expiresAt: LATER,
  createdAt: NOW,
  settledAt: null,
  settledBy: null,
  cancelReason: null,
  ...over,
});

interface World {
  members?: Record<string, Member | undefined>;
  roles?: Record<string, { id: string; systemKey: string | null }>;
  legal?: string | undefined;
  pending?: OwnershipTransferData | undefined;
  found?: OwnershipTransferData | undefined;
  /** expireOwnershipTransfer's UPDATE answers a row (changed). */
  expires?: boolean;
  now?: number;
}

function harness(world: World = {}) {
  const calls: string[] = [];
  const enqueued: {
    topic: string;
    payload: unknown;
    notBefore?: string | undefined;
  }[] = [];
  const audits: {
    action: string;
    entityId: string;
    after?: unknown;
    system: boolean;
  }[] = [];
  const denials: { reason: string; entityId: string }[] = [];
  const settled: { status: string; by: string }[] = [];
  const swaps: unknown[] = [];
  const members = world.members ?? {
    [OWNER]: owner(),
    [MEMBER]: member(),
  };
  const roles = world.roles ?? {
    [ADMIN_ROLE]: { id: ADMIN_ROLE, systemKey: null },
    [OWNER_ROLE]: { id: OWNER_ROLE, systemKey: "owner" },
  };
  const tx = {
    execute: () => {
      calls.push("expire");
      return Promise.resolve({
        rows:
          world.expires === false
            ? []
            : [
                {
                  id: TRANSFER,
                  org_id: ORG,
                  initiated_by: OWNER,
                  to_user_id: MEMBER,
                  previous_owner_role_id: ADMIN_ROLE,
                  status: "expired",
                  expires_at: NOW,
                },
              ],
      });
    },
  } as unknown as Tx;
  const runner = {
    run: <T>(fn: (t: Tx) => Promise<T>) => {
      calls.push("tx");
      return fn(tx);
    },
  };
  const repository = {
    legalName: () => Promise.resolve("legal" in world ? world.legal : LEGAL),
    pending: () => Promise.resolve(world.pending),
    findForUpdate: (_tx: Tx, _org: string, id: string) =>
      Promise.resolve(world.found?.id === id ? world.found : undefined),
    insert: (
      _tx: Tx,
      input: {
        id: string;
        initiatedBy: string;
        toUserId: string;
        previousOwnerRoleId: string;
        expiresAt: string;
        now: string;
      },
    ) => {
      calls.push("insert");
      return Promise.resolve(
        transfer({
          id: input.id,
          initiatedBy: input.initiatedBy,
          toUserId: input.toUserId,
          previousOwnerRoleId: input.previousOwnerRoleId,
          expiresAt: input.expiresAt,
          createdAt: input.now,
        }),
      );
    },
    settle: (
      _tx: Tx,
      _org: string,
      id: string,
      s: { status: "accepted" | "declined" | "cancelled"; by: string },
      now: string,
    ) => {
      calls.push("settle");
      settled.push(s);
      return Promise.resolve(
        transfer({
          id,
          status: s.status,
          settledBy: s.by,
          settledAt: now,
          cancelReason: s.status === "cancelled" ? "manual" : null,
        }),
      );
    },
  } as unknown as OwnershipTransfersRepository;
  const membersPort = {
    lockOrg: () => {
      calls.push("lock");
      return Promise.resolve();
    },
    findOrgOfUser: (_tx: Tx, _org: string, userId: string) =>
      Promise.resolve(members[userId]),
    transferOwnership: (_tx: Tx, _org: string, swap: unknown) => {
      calls.push("swap");
      swaps.push(swap);
      return Promise.resolve();
    },
  };
  const rolesPort = {
    findOpen: (_tx: Tx, _org: string, id: string) => Promise.resolve(roles[id]),
  };
  const logger = new PinoLogger<never>({
    pinoHttp: { logger: pino({ level: "silent" }) },
  });
  const service = new OwnershipTransfersService(
    runner,
    repository,
    membersPort as never,
    rolesPort as never,
    {
      record: (
        _tx: Tx,
        e: { action: string; entityId: string; after?: unknown },
      ) => {
        audits.push({ ...e, system: false });
        return Promise.resolve();
      },
      recordSystem: (
        _tx: Tx,
        e: { action: string; entityId: string; after?: unknown },
      ) => {
        audits.push({ ...e, system: true });
        return Promise.resolve();
      },
    } as never,
    {
      enqueue: (
        _tx: Tx,
        topic: string,
        payload: unknown,
        options?: { notBefore?: string },
      ) => {
        enqueued.push({ topic, payload, notBefore: options?.notBefore });
        return Promise.resolve();
      },
    } as never,
    {
      record: (d: { reason: string; entityId: string }) => {
        calls.push("denial");
        denials.push(d);
        return Promise.resolve();
      },
    } as never,
    { now: () => world.now ?? NOW_MS },
    logger,
  );
  return {
    service,
    calls,
    enqueued,
    audits,
    denials,
    settled,
    swaps,
  };
}

async function failure(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (error) {
    return error;
  }
  throw new Error("expected a failure");
}

const codeOf = async (work: () => Promise<unknown>): Promise<string> => {
  const error = await failure(work);
  if (error instanceof ApiError) return error.code;
  if (error instanceof ValidationError) {
    return `422:${JSON.stringify(error.envelope.issues?.[0]?.path)}`;
  }
  throw error;
};

const startInput = (over: Record<string, string> = {}) => ({
  toUserId: MEMBER,
  previousOwnerRoleId: ADMIN_ROLE,
  organisationName: LEGAL,
  ...over,
});

describe("foldName", () => {
  test("NFKC then trim: a fullwidth name with spaces folds to the plain one", () => {
    expect(foldName("  Ａｃｍｅ  ")).toBe("Acme");
  });
});

describe("start", () => {
  test("an active owner starts: lock first; the row, the recipient's mfa check, the delayed expire job at expires_at, one audit event", async () => {
    const h = harness();
    const t = await as(identity(OWNER), () =>
      h.service.start(startInput({ organisationName: ` ${LEGAL} ` })),
    );
    expect(t).toMatchObject({
      status: "pending",
      initiatedBy: OWNER,
      toUserId: MEMBER,
      previousOwnerRoleId: ADMIN_ROLE,
      expiresAt: LATER,
    });
    expect(h.calls).toEqual(["tx", "lock", "insert"]);
    expect(h.enqueued).toEqual([
      {
        topic: "users.mfa_check",
        payload: { userId: MEMBER },
        notBefore: undefined,
      },
      {
        topic: OWNERSHIP_EXPIRE,
        payload: { transferId: t.id, toUserId: MEMBER, expiresAt: LATER },
        notBefore: LATER,
      },
    ]);
    expect(h.audits.map((a) => [a.action, a.system])).toEqual([
      ["org.ownership_transfer.start", false],
    ]);
  });

  test("not an active owner (by system_key): 403 with one ownership_not_owner denial after the rollback; nothing written", async () => {
    for (const caller of [
      member(),
      owner({ suspendedAt: NOW }),
      owner({ systemKey: null }),
      undefined,
    ]) {
      const h = harness({ members: { [OWNER]: caller, [MEMBER]: member() } });
      expect(
        await codeOf(() =>
          as(identity(OWNER), () => h.service.start(startInput())),
        ),
      ).toBe("forbidden");
      expect(h.denials).toEqual([
        expect.objectContaining({
          reason: "ownership_not_owner",
          entityId: ORG,
        }),
      ]);
      expect(h.calls).toEqual(["tx", "lock", "denial"]);
    }
  });

  test("refusals in order: the name (422), self (422), the recipient (404, 409), the role (404, 422), one pending (409)", async () => {
    const cases: [World, Record<string, string>, string][] = [
      [{}, { organisationName: "Acme" }, '422:["organisationName"]'],
      [{ legal: undefined }, {}, '422:["organisationName"]'],
      [{}, { toUserId: OWNER }, '422:["toUserId"]'],
      [{}, { toUserId: STRANGER }, "not_found"],
      [
        { members: { [OWNER]: owner(), [MEMBER]: member({ external: true }) } },
        {},
        "request.conflict",
      ],
      [
        {
          members: { [OWNER]: owner(), [MEMBER]: member({ expiresAt: LATER }) },
        },
        {},
        "request.conflict",
      ],
      [{}, { previousOwnerRoleId: STRANGER }, "not_found"],
      [{}, { previousOwnerRoleId: OWNER_ROLE }, '422:["previousOwnerRoleId"]'],
      [{ pending: transfer() }, {}, "ownership.transfer_pending"],
    ];
    for (const [world, over, code] of cases) {
      const h = harness(world);
      expect(
        await codeOf(() =>
          as(identity(OWNER), () => h.service.start(startInput(over))),
        ),
        JSON.stringify(over),
      ).toBe(code);
      expect(h.calls).not.toContain("insert");
      expect(h.audits).toEqual([]);
    }
  });

  test("a pending transfer due at the Clock is expired first (one expire event as system, the recipient's mfa check), then the start goes on", async () => {
    const h = harness({ pending: transfer({ expiresAt: NOW }) });
    await as(identity(OWNER), () => h.service.start(startInput()));
    expect(h.calls).toEqual(["tx", "lock", "expire", "insert"]);
    expect(h.audits.map((a) => [a.action, a.system])).toEqual([
      ["org.ownership_transfer.expire", true],
      ["org.ownership_transfer.start", false],
    ]);
    expect(h.enqueued.map((e) => e.topic)).toEqual([
      "users.mfa_check",
      "users.mfa_check",
      OWNERSHIP_EXPIRE,
    ]);
  });

  test("a due transfer the job already settled: no second expire event, the start goes on", async () => {
    const h = harness({
      pending: transfer({ expiresAt: NOW }),
      expires: false,
    });
    await as(identity(OWNER), () => h.service.start(startInput()));
    expect(h.audits.map((a) => a.action)).toEqual([
      "org.ownership_transfer.start",
    ]);
  });
});

describe("pending", () => {
  test("the recipient and an active owner read it; anyone else, none pending or a due one is 404", async () => {
    const live = harness({ pending: transfer() });
    expect(
      await as(identity(MEMBER), () => live.service.pending()),
    ).toMatchObject({ id: TRANSFER });
    expect(
      await as(identity(OWNER), () => live.service.pending()),
    ).toMatchObject({ id: TRANSFER });
    expect(
      await codeOf(() => as(identity(STRANGER), () => live.service.pending())),
    ).toBe("not_found");
    for (const world of [
      {},
      { pending: transfer({ expiresAt: NOW }) },
    ] as World[]) {
      const h = harness(world);
      expect(
        await codeOf(() => as(identity(OWNER), () => h.service.pending())),
      ).toBe("not_found");
    }
  });
});

describe("accept", () => {
  test("the recipient accepts: settle, one role swap, both mfa checks, two member updates and the accept event", async () => {
    const h = harness({ found: transfer() });
    const t = await as(identity(MEMBER), () =>
      h.service.accept(TRANSFER, { organisationName: LEGAL }),
    );
    expect(t).toMatchObject({ status: "accepted", settledBy: MEMBER });
    expect(h.calls).toEqual(["tx", "lock", "settle", "swap"]);
    expect(h.swaps).toEqual([
      {
        recipientMembershipId: MEMBER_M,
        ownerRoleId: OWNER_ROLE,
        initiatorMembershipId: OWNER_M,
        previousRoleId: ADMIN_ROLE,
      },
    ]);
    expect(h.enqueued.map((e) => e.payload)).toEqual([
      { userId: MEMBER },
      { userId: OWNER },
    ]);
    expect(h.audits.map((a) => [a.action, a.entityId])).toEqual([
      ["org.member.update", MEMBER_M],
      ["org.member.update", OWNER_M],
      ["org.ownership_transfer.accept", TRANSFER],
    ]);
  });

  test("SoD (Q1): the initiator is 403 with one ownership_self_accept denial; nothing settled", async () => {
    const h = harness({ found: transfer() });
    expect(
      await codeOf(() =>
        as(identity(OWNER), () =>
          h.service.accept(TRANSFER, { organisationName: LEGAL }),
        ),
      ),
    ).toBe("forbidden");
    expect(h.denials).toEqual([
      expect.objectContaining({
        reason: "ownership_self_accept",
        entityId: TRANSFER,
      }),
    ]);
    expect(h.settled).toEqual([]);
  });

  test("refusals: unknown or someone else's (404), settled (409), at expires_at (409, nothing written), the name (422), a party no longer in place (409)", async () => {
    const cases: [World, string, string][] = [
      [{}, MEMBER, "not_found"],
      [{ found: transfer() }, STRANGER, "not_found"],
      [{ found: transfer({ status: "declined" }) }, MEMBER, "request.conflict"],
      [{ found: transfer({ expiresAt: NOW }) }, MEMBER, "request.conflict"],
      [
        { found: transfer(), legal: "Other" },
        MEMBER,
        '422:["organisationName"]',
      ],
      [
        {
          found: transfer(),
          members: { [OWNER]: owner(), [MEMBER]: member({ suspendedAt: NOW }) },
        },
        MEMBER,
        "request.conflict",
      ],
      [
        {
          found: transfer(),
          members: { [OWNER]: member({ id: OWNER_M }), [MEMBER]: member() },
        },
        MEMBER,
        "request.conflict",
      ],
      [
        {
          found: transfer({ previousOwnerRoleId: OWNER_ROLE }),
        },
        MEMBER,
        "request.conflict",
      ],
      [{ found: transfer(), roles: {} }, MEMBER, "request.conflict"],
    ];
    for (const [world, who, code] of cases) {
      const h = harness(world);
      expect(
        await codeOf(() =>
          as(identity(who), () =>
            h.service.accept(TRANSFER, { organisationName: LEGAL }),
          ),
        ),
      ).toBe(code);
      expect(h.settled).toEqual([]);
      expect(h.audits).toEqual([]);
      expect(h.enqueued).toEqual([]);
    }
  });
});

describe("decline and cancel", () => {
  test("the recipient declines: settled declined, the recipient's mfa check, one event", async () => {
    const h = harness({ found: transfer() });
    expect(
      await as(identity(MEMBER), () => h.service.decline(TRANSFER)),
    ).toMatchObject({ status: "declined", settledBy: MEMBER });
    expect(h.audits.map((a) => a.action)).toEqual([
      "org.ownership_transfer.decline",
    ]);
    expect(h.enqueued.map((e) => e.payload)).toEqual([{ userId: MEMBER }]);
  });

  test("decline refusals: not the recipient or unknown (404), settled or due (409)", async () => {
    const cases: [World, string, string][] = [
      [{}, MEMBER, "not_found"],
      [{ found: transfer() }, OWNER, "not_found"],
      [
        { found: transfer({ status: "cancelled" }) },
        MEMBER,
        "request.conflict",
      ],
      [{ found: transfer({ expiresAt: NOW }) }, MEMBER, "request.conflict"],
    ];
    for (const [world, who, code] of cases) {
      const h = harness(world);
      expect(
        await codeOf(() =>
          as(identity(who), () => h.service.decline(TRANSFER)),
        ),
      ).toBe(code);
      expect(h.settled).toEqual([]);
    }
  });

  test("an active owner cancels at acr mfa: settled cancelled (manual), the recipient's mfa check, one event", async () => {
    const h = harness({ found: transfer() });
    expect(
      await as(identity(OWNER), () => h.service.cancel(TRANSFER)),
    ).toMatchObject({ status: "cancelled", cancelReason: "manual" });
    expect(h.audits).toEqual([
      expect.objectContaining({
        action: "org.ownership_transfer.cancel",
        after: expect.objectContaining({ cause: "manual" }) as unknown,
      }),
    ]);
  });

  test("cancel refusals: unknown (404); settled or due (409) before the caller is checked; a non-owner (403); acr pwd (step-up)", async () => {
    const cases: [World, Identity, string][] = [
      [{}, identity(OWNER), "not_found"],
      [
        {
          found: transfer({ status: "accepted" }),
          members: { [OWNER]: member(), [MEMBER]: owner() },
        },
        identity(OWNER),
        "request.conflict",
      ],
      [
        { found: transfer({ expiresAt: NOW }) },
        identity(OWNER),
        "request.conflict",
      ],
      [{ found: transfer() }, identity(MEMBER), "forbidden"],
      [
        { found: transfer() },
        identity(OWNER, "pwd"),
        "permission.step_up_required",
      ],
    ];
    for (const [world, who, code] of cases) {
      const h = harness(world);
      expect(
        await codeOf(() => as(who, () => h.service.cancel(TRANSFER))),
      ).toBe(code);
      expect(h.settled).toEqual([]);
    }
  });
});
