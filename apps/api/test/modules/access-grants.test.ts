// Access grants: unit tests (P5-06, ADR 0067). The boundary schemas, the
// scope rule, the policies over abilityFor(), the service over plain
// fakes (what each call checks, reads, writes, enqueues and audits, and
// in what order; the reason never logged), the controllers' delegation
// and the module's wiring. The end-to-end behaviour on Postgres is in
// access-grants.int.test.ts.
import type { Tx } from "@bricx/db/database";
import { parseAtBoundary } from "@bricx/validation/error-envelope";
import { MODULE_METADATA } from "@nestjs/common/constants.js";
import { PinoLogger } from "nestjs-pino";
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import type { z } from "zod";
import {
  type Identity,
  NoTenantContextError,
  runWithRequestContext,
  setIdentity,
} from "../../src/common/db/request-context.js";
import {
  AccessGrantsController,
  MyAccessGrantsController,
} from "../../src/modules/access-grants/access-grants.controller.js";
import {
  AccessGrant,
  AccessGrantList,
  AccessGrantParams,
  CreateAccessGrant,
  GRANT_LIST_LIMIT,
  ListAccessGrantsQuery,
  REASON_MAX,
} from "../../src/modules/access-grants/access-grants.dto.js";
import { ACCESS_GRANTS_EXPIRE } from "../../src/modules/access-grants/access-grants.events.js";
import {
  SUBJECT,
  assertCan,
} from "../../src/modules/access-grants/access-grants.policies.js";
import {
  type AccessGrantRow,
  AccessGrantsRepository,
} from "../../src/modules/access-grants/access-grants.repository.js";
import {
  ACCESS_GRANT_MAX_SECONDS,
  ACCESS_GRANTS_MAX_PER_USER,
  type AccessGrantsPort,
  AccessGrantsService,
  type MembershipsReader,
  type OutboxWriter,
  scopeOf,
} from "../../src/modules/access-grants/access-grants.service.js";
import { AccessGrantsModule } from "../../src/modules/access-grants/public-api.js";
import type {
  AuditRecorder,
  TransactionRunner,
} from "../../src/modules/sessions/public-api.js";
import { grantsOf } from "../support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const TARGET = "0199e1a0-0000-7000-8000-000000000002";
const OTHER = "0199e1a0-0000-7000-8000-000000000003";
const PROJECT = "0199e1a0-0000-7000-8000-000000000020";
const PROJECT_2 = "0199e1a0-0000-7000-8000-000000000021";
const GRANT = "0199e1a0-0000-7000-8000-000000000030";
const SESSION = "0199e1a0-0000-7000-8000-00000000005e";
const NOW_MS = Date.UTC(2026, 9, 22, 12, 0, 0);
const NOW = new Date(NOW_MS).toISOString();
const at = (seconds: number) => new Date(NOW_MS + seconds * 1000).toISOString();
const MEMBER_READ = "org.member.read.org";
const BUDGET_APPROVE = "finance.budget.approve.project";
const REASON = "needle-reason: cover";
const MAX_SECONDS = 7_200;
const CAP = 2;

const identity = (
  roles: readonly string[],
  projects: readonly string[] = [],
  extra: Partial<Identity> = {},
): Identity => ({
  orgId: ORG,
  userId: USER,
  projectIds: [...projects],
  allProjects: false,
  grants: grantsOf({ roles, projects }),
  sessionId: SESSION,
  deviceId: undefined,
  ...extra,
});
const owner = identity(["owner"]);
const auditor = identity(["auditor"]);
const manager = identity(["project_manager"], [PROJECT]);
/** An owner without the finance keys: grants, but holds no finance.* key. */
const noFinance: Identity = {
  ...owner,
  grants: owner.grants.filter((g) => !g.permission.startsWith("finance.")),
};

describe("scopeOf(): the scope rule (D-B)", () => {
  test("an org key on an org-level resource takes no scope; a project key on a project- or site-level resource needs one; the rest is refused at the field", () => {
    expect(scopeOf(MEMBER_READ, undefined)).toEqual({ scope: "org" });
    expect(scopeOf(MEMBER_READ, PROJECT)).toEqual({ refused: "scopeId" });
    expect(scopeOf(BUDGET_APPROVE, PROJECT)).toEqual({ scope: "project" });
    expect(scopeOf(BUDGET_APPROVE, undefined)).toEqual({ refused: "scopeId" });
    expect(scopeOf("field.dailylog.read.project", PROJECT)).toEqual({
      scope: "project",
    });
    expect(scopeOf("project.project.read.org", undefined)).toEqual({
      refused: "permission",
    });
    expect(scopeOf("field.dailylog.read.site", PROJECT)).toEqual({
      refused: "permission",
    });
    expect(scopeOf("field.dailylog.create.own", undefined)).toEqual({
      refused: "permission",
    });
    expect(scopeOf("nope.nope.nope.org", undefined)).toEqual({
      refused: "permission",
    });
    expect(scopeOf("", undefined)).toEqual({ refused: "permission" });
  });
});

describe("the boundary schemas", () => {
  const parse = <S extends z.ZodType>(schema: S, input: unknown) =>
    parseAtBoundary(schema, input);
  const body = (over: Record<string, unknown> = {}) => ({
    userId: TARGET,
    permission: MEMBER_READ,
    reason: REASON,
    expiresAt: at(3600),
    ...over,
  });

  test("a create takes a user, a catalogue key, an optional project scope, a reason of 1..REASON_MAX and UTC instants; nothing else", () => {
    expect(parse(CreateAccessGrant.schema, body()).success).toBe(true);
    expect(
      parse(CreateAccessGrant.schema, body({ scopeId: PROJECT, startsAt: NOW }))
        .success,
    ).toBe(true);
    expect(
      parse(
        CreateAccessGrant.schema,
        body({ expiresAt: "2026-10-22T13:00:00Z" }),
      ).success,
    ).toBe(true);
    const issuesOf = (input: unknown) => {
      const result = parse(CreateAccessGrant.schema, input);
      return result.success
        ? []
        : (result.envelope.issues ?? []).map(
            (i) => `${i.path.join(".")}:${i.code}`,
          );
    };
    expect(issuesOf(body({ reason: "" }))).toEqual(["reason:invalid_value"]);
    expect(issuesOf(body({ reason: "x".repeat(REASON_MAX + 1) }))).toEqual([
      "reason:invalid_value",
    ]);
    expect(issuesOf(body({ permission: "nope.nope.nope.org" }))).toEqual([
      "permission:invalid_value",
    ]);
    expect(issuesOf(body({ scopeId: "p1" }))).toEqual([
      "scopeId:invalid_value",
    ]);
    expect(issuesOf(body({ expiresAt: "2026-10-22 13:00" }))).toEqual([
      "expiresAt:invalid_value",
    ]);
    expect(issuesOf(body({ expiresAt: "2026-13-45T13:00:00Z" }))).toEqual([
      "expiresAt:invalid_value",
    ]);
    expect(issuesOf(body({ expiresAt: "2026-10-22T13:00:00+01:00" }))).toEqual([
      "expiresAt:invalid_value",
    ]);
    expect(issuesOf(body({ userId: undefined }))).toEqual(["userId:required"]);
    expect(issuesOf(body({ extra: 1 }))).toEqual([":unknown_field"]);
    expect(issuesOf(body({ startsAt: 5 }))).toEqual(["startsAt:invalid_value"]);
  });

  test("params take an id; the list query an optional userId; the responses are strict", () => {
    expect(parse(AccessGrantParams.schema, { id: GRANT }).success).toBe(true);
    expect(parse(AccessGrantParams.schema, { id: "nope" }).success).toBe(false);
    expect(parse(ListAccessGrantsQuery.schema, {}).success).toBe(true);
    expect(
      parse(ListAccessGrantsQuery.schema, { userId: TARGET }).success,
    ).toBe(true);
    expect(parse(ListAccessGrantsQuery.schema, { userId: "x" }).success).toBe(
      false,
    );
    expect(parse(ListAccessGrantsQuery.schema, { page: 1 }).success).toBe(
      false,
    );
    const grant = AccessGrantsService.present(row(), NOW_MS);
    expect(parse(AccessGrant.schema, grant).success).toBe(true);
    expect(parse(AccessGrant.schema, { ...grant, extra: 1 }).success).toBe(
      false,
    );
    expect(parse(AccessGrantList.schema, { items: [grant] }).success).toBe(
      true,
    );
    expect(GRANT_LIST_LIMIT).toBe(100);
  });
});

describe("the policies", () => {
  test("org.access_grant.read / grant / revoke at org scope: the owner all three, the auditor read, a project manager none", () => {
    expect(SUBJECT).toBe("org.access_grant");
    for (const action of ["read", "grant", "revoke"] as const) {
      expect(() => assertCan(owner, action)).not.toThrow();
      expect(() => assertCan(manager, action)).toThrow(
        expect.objectContaining({ code: "forbidden" }),
      );
    }
    expect(() => assertCan(auditor, "read")).not.toThrow();
    expect(() => assertCan(auditor, "grant")).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
    expect(() => assertCan(auditor, "revoke")).toThrow(
      expect.objectContaining({ code: "forbidden" }),
    );
  });
});

const row = (over: Partial<AccessGrantRow> = {}): AccessGrantRow => ({
  id: GRANT,
  orgId: ORG,
  userId: TARGET,
  permission: MEMBER_READ,
  scopeId: null,
  reason: REASON,
  grantedBy: USER,
  startsAt: at(-60),
  expiresAt: at(3540),
  revokedAt: null,
  revokedBy: null,
  expiredAt: null,
  createdAt: at(-60),
  ...over,
});

describe("AccessGrantsService.present(): active at the instant", () => {
  test("started, not ended, not revoked", () => {
    expect(AccessGrantsService.present(row(), NOW_MS).active).toBe(true);
    expect(
      AccessGrantsService.present(row({ startsAt: NOW }), NOW_MS).active,
    ).toBe(true);
    expect(
      AccessGrantsService.present(row({ startsAt: at(1) }), NOW_MS).active,
    ).toBe(false);
    expect(
      AccessGrantsService.present(row({ expiresAt: NOW }), NOW_MS).active,
    ).toBe(false);
    expect(
      AccessGrantsService.present(row({ expiresAt: at(1) }), NOW_MS).active,
    ).toBe(true);
    expect(
      AccessGrantsService.present(
        row({ revokedAt: at(-1), revokedBy: USER }),
        NOW_MS,
      ).active,
    ).toBe(false);
    // The worker's record alone does not end a grant the clock says is open.
    expect(
      AccessGrantsService.present(row({ expiredAt: at(-1) }), NOW_MS).active,
    ).toBe(true);
    expect(Object.keys(AccessGrantsService.present(row(), NOW_MS))).toEqual([
      "id",
      "orgId",
      "userId",
      "permission",
      "scopeId",
      "reason",
      "grantedBy",
      "startsAt",
      "expiresAt",
      "revokedAt",
      "revokedBy",
      "expiredAt",
      "active",
      "createdAt",
    ]);
  });
});

describe("AccessGrantsService", () => {
  const lines: string[] = [];
  const logger = new PinoLogger<never>({
    pinoHttp: {
      logger: pino(
        { level: "warn" },
        { write: (line: string) => lines.push(line) },
      ),
    },
  });
  const warnings = () =>
    lines.map((line) => JSON.parse(line) as Record<string, unknown>);

  interface Writes {
    readonly calls: string[];
    readonly audit: {
      action: string;
      entityId?: string | undefined;
      before?: unknown;
      after?: unknown;
    }[];
    readonly outbox: { topic: string; payload: unknown; options: unknown }[];
  }
  // The fake transaction handle: the fakes never use it (one disclosed
  // cast; a drizzle transaction cannot be built without a connection).
  const TX = {} as unknown as Tx;

  interface World {
    readonly grants?: readonly AccessGrantRow[];
    /** Users with an open org membership (TARGET by default). */
    readonly members?: readonly string[];
    /** Open project memberships, user to projects. */
    readonly projects?: Readonly<Record<string, readonly string[]>>;
    /** Users rows (the FK): TARGET and OTHER by default. */
    readonly users?: readonly string[];
    readonly open?: number;
  }

  function fakes(world: World = {}) {
    lines.length = 0;
    const writes: Writes = { calls: [], audit: [], outbox: [] };
    const grants = [...(world.grants ?? [])];
    const members = world.members ?? [TARGET];
    const projects = world.projects ?? { [TARGET]: [PROJECT] };
    const users = world.users ?? [TARGET, OTHER];
    const runner: TransactionRunner = {
      run: (fn) => {
        writes.calls.push("tx");
        return fn(TX);
      },
    };
    const audit: AuditRecorder = {
      record: (_tx, event) => {
        writes.calls.push(`audit:${event.action}`);
        writes.audit.push({
          action: event.action,
          entityId: event.entityId,
          before: event.before,
          after: event.after,
        });
        return Promise.resolve({ id: "x", seq: "1", hash: "h" });
      },
    };
    const outbox: OutboxWriter = {
      enqueue: (_tx, topic, payload, options) => {
        writes.calls.push(`outbox:${topic}`);
        writes.outbox.push({ topic, payload, options });
        return Promise.resolve("job");
      },
    };
    const memberships: MembershipsReader = {
      accessRowsOf: (_tx, _orgId, userIds) => {
        writes.calls.push(`access:${userIds.length.toString()}`);
        return Promise.resolve({
          memberships: userIds
            .filter((u) => members.includes(u))
            .map((userId) => ({
              id: "m",
              userId,
              roleId: "r",
              systemKey: null,
              createdAt: NOW,
              removedAt: null,
            })),
          projects: userIds.flatMap((userId) =>
            (projects[userId] ?? []).map((projectId) => ({
              id: "pm",
              projectId,
              userId,
              roleId: "r",
              systemKey: null,
              overrides: {},
              createdAt: NOW,
              removedAt: null,
            })),
          ),
        });
      },
    };
    const clock = { now: () => NOW_MS };
    const repo = Object.assign(new AccessGrantsRepository(), {
      insert: (
        _tx: Tx,
        input: Omit<
          AccessGrantRow,
          "revokedAt" | "revokedBy" | "expiredAt" | "createdAt"
        > & {
          now: string;
        },
      ) => {
        writes.calls.push("insert");
        if (!users.includes(input.userId)) {
          return Promise.reject(new Error("api error: not_found"));
        }
        const made = row({
          id: input.id,
          userId: input.userId,
          permission: input.permission,
          scopeId: input.scopeId,
          reason: input.reason,
          grantedBy: input.grantedBy,
          startsAt: input.startsAt,
          expiresAt: input.expiresAt,
          createdAt: input.now,
        });
        grants.push(made);
        return Promise.resolve(made);
      },
      find: (_tx: Tx, _orgId: string, id: string) => {
        writes.calls.push(`find:${id}`);
        return Promise.resolve(grants.find((g) => g.id === id));
      },
      list: (_tx: Tx, _orgId: string, instant: string, userId?: string) => {
        writes.calls.push(`list:${instant}:${userId ?? "*"}`);
        return Promise.resolve(
          grants.filter(
            (g) =>
              g.revokedAt === null &&
              g.expiresAt > instant &&
              (userId === undefined || g.userId === userId),
          ),
        );
      },
      listMine: (_tx: Tx, _orgId: string, userId: string, instant: string) => {
        writes.calls.push(`mine:${userId}:${instant}`);
        return Promise.resolve(grants.filter((g) => g.userId === userId));
      },
      countOpen: (_tx: Tx, _orgId: string, userId: string) => {
        writes.calls.push(`count:${userId}`);
        return Promise.resolve(world.open ?? 0);
      },
      revoke: (
        _tx: Tx,
        _orgId: string,
        id: string,
        by: string,
        now: string,
      ) => {
        writes.calls.push(`revoke:${id}`);
        const index = grants.findIndex(
          (g) => g.id === id && g.revokedAt === null && g.expiredAt === null,
        );
        if (index < 0) return Promise.resolve(undefined);
        const updated = row({
          ...grants[index],
          revokedAt: now,
          revokedBy: by,
        });
        grants[index] = updated;
        return Promise.resolve(updated);
      },
    });
    const service = new AccessGrantsService(
      runner,
      repo,
      memberships,
      audit,
      outbox,
      clock,
      logger,
      CAP,
      MAX_SECONDS,
    );
    return { writes, service, grants };
  }

  /** Runs `fn` inside a request whose identity is `identity` (a sync policy throw becomes a rejection). */
  const asIdentity = <T>(who: Identity | undefined, fn: () => Promise<T>) =>
    runWithRequestContext(
      { correlationId: "corr-1", ip: "127.0.0.1", deviceId: undefined },
      async () => {
        if (who !== undefined) setIdentity(who);
        return fn();
      },
    );

  const input = (over: Record<string, unknown> = {}) =>
    CreateAccessGrant.schema.parse({
      userId: TARGET,
      permission: MEMBER_READ,
      reason: REASON,
      expiresAt: at(3600),
      ...over,
    });

  test("list: the open rows at the clock with active; a reader may, ?userId= is passed on; a project manager may not; nobody without an identity", async () => {
    const f = fakes({
      grants: [row(), row({ id: SESSION, startsAt: at(60) })],
    });
    const listed = await asIdentity(auditor, () => f.service.list({}));
    expect(listed.map((g) => [g.id, g.active])).toEqual([
      [GRANT, true],
      [SESSION, false],
    ]);
    expect(f.writes.calls).toEqual(["tx", `list:${NOW}:*`]);
    await asIdentity(owner, () => f.service.list({ userId: OTHER }));
    expect(f.writes.calls.at(-1)).toBe(`list:${NOW}:${OTHER}`);
    const g = fakes();
    await expect(
      asIdentity(manager, () => g.service.list({})),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      asIdentity(undefined, () => g.service.list({})),
    ).rejects.toBeInstanceOf(NoTenantContextError);
    expect(g.writes.calls).toEqual([]);
  });

  test("get: one row whatever its state, not_found otherwise; a reader may", async () => {
    const f = fakes({ grants: [row({ revokedAt: at(-1), revokedBy: USER })] });
    const got = await asIdentity(auditor, () => f.service.get(GRANT));
    expect(got).toMatchObject({ id: GRANT, active: false, revokedBy: USER });
    await expect(
      asIdentity(owner, () => f.service.get(SESSION)),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      asIdentity(manager, () => f.service.get(GRANT)),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("grant: the cap count under the lock, the insert, the membership check, the expire row due at expiresAt, the mfa check, then the audit event last with the reason; startsAt defaults to now; nothing logged", async () => {
    const f = fakes();
    const made = await asIdentity(owner, () => f.service.grant(input()));
    expect(made).toMatchObject({
      userId: TARGET,
      permission: MEMBER_READ,
      scopeId: null,
      reason: REASON,
      grantedBy: USER,
      startsAt: NOW,
      expiresAt: at(3600),
      createdAt: NOW,
      active: true,
    });
    expect(f.writes.calls).toEqual([
      "tx",
      `count:${TARGET}`,
      "insert",
      "access:1",
      `outbox:${ACCESS_GRANTS_EXPIRE}`,
      "outbox:users.mfa_check",
      "audit:org.access_grant.grant",
    ]);
    expect(f.writes.outbox).toEqual([
      {
        topic: ACCESS_GRANTS_EXPIRE,
        payload: { grantId: made.id, userId: TARGET },
        options: { notBefore: at(3600) },
      },
      {
        topic: "users.mfa_check",
        payload: { userId: TARGET },
        options: undefined,
      },
    ]);
    expect(f.writes.audit).toEqual([
      {
        action: "org.access_grant.grant",
        entityId: made.id,
        before: undefined,
        after: {
          userId: TARGET,
          permission: MEMBER_READ,
          scopeId: null,
          startsAt: NOW,
          expiresAt: at(3600),
          reason: REASON,
        },
      },
    ]);
    expect(lines).toEqual([]);
    // A project scope: the key on the project the user belongs to.
    const scoped = await asIdentity(owner, () =>
      f.service.grant(
        input({
          permission: BUDGET_APPROVE,
          scopeId: PROJECT,
          startsAt: at(120),
        }),
      ),
    );
    expect(scoped).toMatchObject({
      scopeId: PROJECT,
      startsAt: at(120),
      active: false,
    });
  });

  test("grant: the policy (403 before any transaction), self-grant (422 userId), the scope rule (422 permission / scopeId), startsAt over 30 days ahead (422 startsAt), the window (422 expiresAt)", async () => {
    const f = fakes();
    const issueOf = async (who: Identity, over: Record<string, unknown>) => {
      try {
        await asIdentity(who, () => f.service.grant(input(over)));
      } catch (error) {
        const e = error as {
          code?: string;
          envelope?: { issues: { path: string[] }[] };
        };
        return e.envelope?.issues.map((i) => i.path.join(".")) ?? [e.code];
      }
      return [];
    };
    expect(await issueOf(auditor, {})).toEqual(["forbidden"]);
    expect(await issueOf(owner, { userId: USER })).toEqual(["userId"]);
    expect(await issueOf(owner, { permission: BUDGET_APPROVE })).toEqual([
      "scopeId",
    ]);
    expect(await issueOf(owner, { scopeId: PROJECT })).toEqual(["scopeId"]);
    expect(
      await issueOf(owner, { permission: "project.project.read.org" }),
    ).toEqual(["permission"]);
    expect(
      await issueOf(owner, { permission: "field.dailylog.create.own" }),
    ).toEqual(["permission"]);
    expect(
      await issueOf(owner, {
        startsAt: at(30 * 86_400 + 1),
        expiresAt: at(30 * 86_400 + 61),
      }),
    ).toEqual(["startsAt"]);
    expect(await issueOf(owner, { expiresAt: at(59) })).toEqual(["expiresAt"]);
    expect(await issueOf(owner, { expiresAt: at(MAX_SECONDS + 1) })).toEqual([
      "expiresAt",
    ]);
    expect(await issueOf(owner, { expiresAt: at(-60) })).toEqual(["expiresAt"]);
    expect(
      await issueOf(owner, { startsAt: at(600), expiresAt: at(659) }),
    ).toEqual(["expiresAt"]);
    expect(f.writes.calls).toEqual([]);
    // The bounds themselves pass.
    expect(await issueOf(owner, { expiresAt: at(60) })).toEqual([]);
    expect(await issueOf(owner, { expiresAt: at(MAX_SECONDS) })).toEqual([]);
    expect(
      await issueOf(owner, {
        startsAt: at(30 * 86_400),
        expiresAt: at(30 * 86_400 + 60),
      }),
    ).toEqual([]);
  });

  test("grant: escalation: a key the granter does not hold at org scope is forbidden before any transaction, with one grants.escalation line naming it and never the reason", async () => {
    const f = fakes();
    await expect(
      asIdentity(noFinance, () =>
        f.service.grant(
          input({ permission: BUDGET_APPROVE, scopeId: PROJECT }),
        ),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(f.writes.calls).toEqual([]);
    expect(warnings()).toEqual([
      expect.objectContaining({
        msg: "grants.escalation",
        userId: USER,
        orgId: ORG,
        key: BUDGET_APPROVE,
      }),
    ]);
    expect(lines.join("\n")).not.toContain("needle-reason");
  });

  test("grant: the cap is request.conflict after the count and before the insert; an unknown user is not_found; no org membership, or no membership of the scope project, is request.conflict after the insert (the transaction rolls back)", async () => {
    const capped = fakes({ open: CAP });
    await expect(
      asIdentity(owner, () => capped.service.grant(input())),
    ).rejects.toMatchObject({ code: "request.conflict" });
    expect(capped.writes.calls).toEqual(["tx", `count:${TARGET}`]);
    const f = fakes();
    await expect(
      asIdentity(owner, () => f.service.grant(input({ userId: SESSION }))),
    ).rejects.toThrow("not_found");
    expect(f.writes.calls).toEqual(["tx", `count:${SESSION}`, "insert"]);
    const g = fakes();
    await expect(
      asIdentity(owner, () => g.service.grant(input({ userId: OTHER }))),
    ).rejects.toMatchObject({ code: "request.conflict" });
    expect(g.writes.calls).toEqual([
      "tx",
      `count:${OTHER}`,
      "insert",
      "access:1",
    ]);
    expect(g.writes.outbox).toEqual([]);
    expect(g.writes.audit).toEqual([]);
    const h = fakes();
    await expect(
      asIdentity(owner, () =>
        h.service.grant(
          input({ permission: BUDGET_APPROVE, scopeId: PROJECT_2 }),
        ),
      ),
    ).rejects.toMatchObject({ code: "request.conflict" });
    expect(h.writes.outbox).toEqual([]);
  });

  test("revoke: the revoke policy only (no key held); the row, the update, the mfa check, then the audit event with before and after; revoked or expired rows are request.conflict; unknown is not_found", async () => {
    const f = fakes({
      grants: [
        row({ permission: BUDGET_APPROVE, scopeId: PROJECT }),
        row({ id: SESSION, expiredAt: at(-1), expiresAt: at(-2) }),
      ],
    });
    await asIdentity(noFinance, () => f.service.revoke(GRANT));
    expect(f.writes.calls).toEqual([
      "tx",
      `find:${GRANT}`,
      `revoke:${GRANT}`,
      "outbox:users.mfa_check",
      "audit:org.access_grant.revoke",
    ]);
    expect(f.writes.audit).toEqual([
      {
        action: "org.access_grant.revoke",
        entityId: GRANT,
        before: { revokedAt: null, revokedBy: null },
        after: { revokedAt: NOW, revokedBy: USER },
      },
    ]);
    expect(f.writes.outbox).toEqual([
      {
        topic: "users.mfa_check",
        payload: { userId: TARGET },
        options: undefined,
      },
    ]);
    await expect(
      asIdentity(owner, () => f.service.revoke(GRANT)),
    ).rejects.toMatchObject({ code: "request.conflict" });
    await expect(
      asIdentity(owner, () => f.service.revoke(SESSION)),
    ).rejects.toMatchObject({ code: "request.conflict" });
    await expect(
      asIdentity(owner, () => f.service.revoke(OTHER)),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      asIdentity(auditor, () => f.service.revoke(GRANT)),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(lines).toEqual([]);
  });

  test("listMine: the caller's rows at the clock without any grant", async () => {
    const f = fakes({ grants: [row({ userId: USER })] });
    const mine = await asIdentity(manager, () => f.service.listMine());
    expect(mine.map((g) => g.id)).toEqual([GRANT]);
    expect(f.writes.calls).toEqual(["tx", `mine:${USER}:${NOW}`]);
  });
});

describe("the controllers delegate", () => {
  test("every route calls its service method with the parsed input", async () => {
    const calls: unknown[] = [];
    const port: AccessGrantsPort = {
      list: (query) => {
        calls.push(["list", query]);
        return Promise.resolve([]);
      },
      grant: (body) => {
        calls.push(["grant", body]);
        return Promise.resolve(AccessGrantsService.present(row(), NOW_MS));
      },
      get: (id) => {
        calls.push(["get", id]);
        return Promise.resolve(AccessGrantsService.present(row(), NOW_MS));
      },
      revoke: (id) => {
        calls.push(["revoke", id]);
        return Promise.resolve();
      },
      listMine: () => {
        calls.push(["mine"]);
        return Promise.resolve([]);
      },
    };
    const controller = new AccessGrantsController(port);
    const body = CreateAccessGrant.schema.parse({
      userId: TARGET,
      permission: MEMBER_READ,
      reason: REASON,
      expiresAt: at(3600),
    });
    expect(await controller.list({ userId: TARGET })).toEqual({ items: [] });
    expect((await controller.grant(body)).id).toBe(GRANT);
    expect((await controller.get({ id: GRANT })).id).toBe(GRANT);
    await controller.revoke({ id: GRANT });
    expect(await new MyAccessGrantsController(port).list()).toEqual({
      items: [],
    });
    expect(calls).toEqual([
      ["list", { userId: TARGET }],
      ["grant", body],
      ["get", GRANT],
      ["revoke", GRANT],
      ["mine"],
    ]);
  });
});

describe("the module", () => {
  test("forRoot wires both controllers, the service, the repository and the two config values", () => {
    const module = AccessGrantsModule.forRoot({
      maxPerUser: 7,
      maxSeconds: 600,
    });
    expect(module.controllers).toEqual([
      AccessGrantsController,
      MyAccessGrantsController,
    ]);
    expect(module.providers).toEqual([
      AccessGrantsService,
      AccessGrantsRepository,
      { provide: ACCESS_GRANTS_MAX_PER_USER, useValue: 7 },
      { provide: ACCESS_GRANT_MAX_SECONDS, useValue: 600 },
    ]);
    expect(
      Reflect.getMetadata(MODULE_METADATA.IMPORTS, AccessGrantsModule),
    ).toBeUndefined();
    expect(module.imports).toHaveLength(3);
  });
});
