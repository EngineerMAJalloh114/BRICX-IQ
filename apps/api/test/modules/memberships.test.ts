// The memberships module without a database (P5-05, ADR 0066; plan 3.2,
// 3.3, 3.5, 6.2): the boundary schemas, holdsAll() at project scope, the
// MFA computation (condition 1) and the service over plain fakes (the
// policy check before any transaction, what each call reads, writes,
// audits, enqueues and revokes, in what order, target protection and the
// last owner). The end-to-end behaviour is in memberships.int.test.ts.
import type { Tx } from "@bricx/db/database";
import { CATALOGUE } from "@bricx/permissions/catalogue";
import { MFA_KEY_PREFIX } from "@bricx/permissions/mfa";
import { ROLES } from "@bricx/permissions/roles";
import { PinoLogger } from "nestjs-pino";
import { pino } from "pino";
import { describe, expect, test } from "vitest";
import { abilityFor } from "../../src/common/auth/ability.js";
import { holdsAll } from "../../src/common/auth/holds.js";
import {
  type Identity,
  NoTenantContextError,
  runWithRequestContext,
  setIdentity,
} from "../../src/common/db/request-context.js";
import {
  ApiError,
  ValidationError,
} from "../../src/common/errors/api-error.js";
import {
  AssignProjectMember,
  CreateMember,
  MAX_OVERRIDE_LIST,
  UpdateMember,
  UpdateProjectMember,
} from "../../src/modules/memberships/memberships.dto.js";
import {
  type MembershipRow,
  MembershipsRepository,
  type ProjectMembershipRow,
} from "../../src/modules/memberships/memberships.repository.js";
import {
  MembershipsService,
  type OutboxWriter,
  type SessionsRevoker,
  mfaRequiredOf,
} from "../../src/modules/memberships/memberships.service.js";
import { RolesRepository } from "../../src/modules/roles/roles.repository.js";
import {
  type AuditRecorder,
  type TransactionRunner,
} from "../../src/modules/sessions/public-api.js";
import { grantsOf } from "../support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const TARGET = "0199e1a0-0000-7000-8000-000000000002";
const PROJECT = "0199e1a0-0000-7000-8000-000000000010";
const OTHER_PROJECT = "0199e1a0-0000-7000-8000-000000000011";
const ROLE = "0199e1a0-0000-7000-8000-000000000101";
const OWNER_ROLE = "0199e1a0-0000-7000-8000-000000000100";
const FIN_ROLE = "0199e1a0-0000-7000-8000-000000000102";
const MEMBERSHIP = "0199e1a0-0000-7000-8000-000000000201";
const PROJECT_MEMBERSHIP = "0199e1a0-0000-7000-8000-000000000301";
const SESSION = "0199e1a0-0000-7000-8000-00000000005e";
const GRANT_ORG = "0199e1a0-0000-7000-8000-000000000401";
const GRANT_PROJECT = "0199e1a0-0000-7000-8000-000000000402";
const T0 = "2026-10-21T10:00:00.000000Z";
const NOW_MS = Date.UTC(2026, 9, 22, 12, 0, 0);
const NOW = new Date(NOW_MS).toISOString();
const MILESTONE_READ = "project.milestone.read.project";
const MILESTONE_CREATE = "project.milestone.create.project";
const BUDGET_READ = "finance.budget.read.project";
/** A finance key the project manager bundle does not hold. */
const BUDGET_APPROVE = "finance.budget.approve.project";

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

describe("holdsAll() at project scope", () => {
  test("a project manager holds their project keys on their project, not on another, and not org-wide", () => {
    const ability = abilityFor(identity(["project_manager"], [PROJECT]));
    expect(
      holdsAll(ability, ORG, [MILESTONE_READ, MILESTONE_CREATE], PROJECT),
    ).toBeUndefined();
    expect(holdsAll(ability, ORG, [MILESTONE_READ], OTHER_PROJECT)).toBe(
      MILESTONE_READ,
    );
    expect(holdsAll(ability, ORG, [MILESTONE_READ])).toBe(MILESTONE_READ);
    expect(holdsAll(ability, ORG, [BUDGET_READ], PROJECT)).toBeUndefined();
    expect(holdsAll(ability, ORG, [BUDGET_APPROVE], PROJECT)).toBe(
      BUDGET_APPROVE,
    );
  });

  test("an org-wide holder holds the key on any project", () => {
    const ability = abilityFor(identity(["owner"]));
    expect(holdsAll(ability, ORG, [...CATALOGUE], PROJECT)).toBeUndefined();
  });
});

describe("mfaRequiredOf(): requiresMfa over the org bundle and every project membership's effective keys (condition 1)", () => {
  test("a finance key in the org role, in a project role, or added by an override requires MFA; removed by an override it does not", () => {
    expect(mfaRequiredOf({ org: [BUDGET_READ], projects: [] })).toBe(true);
    expect(mfaRequiredOf({ org: ["org.member.read.org"], projects: [] })).toBe(
      false,
    );
    expect(
      mfaRequiredOf({
        org: [],
        projects: [{ bundle: [BUDGET_READ], overrides: {} }],
      }),
    ).toBe(true);
    expect(
      mfaRequiredOf({
        org: [],
        projects: [{ bundle: [], overrides: { add: [BUDGET_READ] } }],
      }),
    ).toBe(true);
    expect(
      mfaRequiredOf({
        org: [],
        projects: [
          { bundle: [BUDGET_READ], overrides: { remove: [BUDGET_READ] } },
        ],
      }),
    ).toBe(false);
    expect(mfaRequiredOf({ org: undefined, projects: [] })).toBe(false);
    expect(MFA_KEY_PREFIX).toBe("finance.");
  });
});

describe("the boundary schemas", () => {
  test("a create takes a user and a role id (UUIDv7), nothing else; an update takes a role id", () => {
    expect(
      CreateMember.schema.safeParse({ userId: TARGET, roleId: ROLE }).success,
    ).toBe(true);
    expect(CreateMember.schema.safeParse({ userId: TARGET }).success).toBe(
      false,
    );
    expect(
      CreateMember.schema.safeParse({ userId: "nope", roleId: ROLE }).success,
    ).toBe(false);
    expect(
      CreateMember.schema.safeParse({ userId: TARGET, roleId: ROLE, x: 1 })
        .success,
    ).toBe(false);
    expect(UpdateMember.schema.safeParse({ roleId: ROLE }).success).toBe(true);
    expect(UpdateMember.schema.safeParse({}).success).toBe(false);
  });

  test("an assignment takes a user, a role and optional overrides (catalogue keys, unique, at most MAX_OVERRIDE_LIST each); an update takes a role and/or overrides", () => {
    const valid = {
      userId: TARGET,
      roleId: ROLE,
      overrides: { add: [MILESTONE_CREATE], remove: [MILESTONE_READ] },
    };
    expect(AssignProjectMember.schema.parse(valid)).toEqual(valid);
    expect(
      AssignProjectMember.schema.safeParse({ userId: TARGET, roleId: ROLE })
        .success,
    ).toBe(true);
    expect(
      AssignProjectMember.schema.safeParse({
        ...valid,
        overrides: { add: ["nope"] },
      }).success,
    ).toBe(false);
    expect(
      AssignProjectMember.schema.safeParse({
        ...valid,
        overrides: { add: [MILESTONE_READ, MILESTONE_READ] },
      }).success,
    ).toBe(false);
    expect(
      AssignProjectMember.schema.safeParse({
        ...valid,
        overrides: { other: [] },
      }).success,
    ).toBe(false);
    expect(
      AssignProjectMember.schema.safeParse({
        ...valid,
        overrides: { add: CATALOGUE.slice(0, MAX_OVERRIDE_LIST + 1) },
      }).success,
    ).toBe(false);
    expect(MAX_OVERRIDE_LIST).toBe(50);
    expect(UpdateProjectMember.schema.safeParse({ roleId: ROLE }).success).toBe(
      true,
    );
    expect(
      UpdateProjectMember.schema.safeParse({ overrides: {} }).success,
    ).toBe(true);
    expect(UpdateProjectMember.schema.safeParse({}).success).toBe(false);
  });
});

describe("MembershipsService", () => {
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
    readonly outbox: { topic: string; payload: unknown }[];
  }
  // The fake transaction handle: the fakes never use it (one disclosed
  // cast; a drizzle transaction cannot be built without a connection).
  const TX = {} as unknown as Tx;

  const row = (over: Partial<MembershipRow> = {}): MembershipRow => ({
    id: MEMBERSHIP,
    userId: TARGET,
    roleId: ROLE,
    systemKey: null,
    createdAt: T0,
    removedAt: null,
    ...over,
  });
  const projectRow = (
    over: Partial<ProjectMembershipRow> = {},
  ): ProjectMembershipRow => ({
    id: PROJECT_MEMBERSHIP,
    projectId: PROJECT,
    userId: TARGET,
    roleId: ROLE,
    systemKey: null,
    overrides: {},
    createdAt: T0,
    removedAt: null,
    ...over,
  });

  interface World {
    readonly members?: readonly MembershipRow[];
    readonly projectMembers?: readonly ProjectMembershipRow[];
    /** Open roles by id: the bundle (the owner's is virtual). */
    readonly roles?: Readonly<
      Record<
        string,
        { readonly systemKey?: string | null; readonly keys: readonly string[] }
      >
    >;
    readonly owners?: number;
    readonly users?: readonly string[];
    readonly sessionsToClose?: readonly string[];
    /** Open elevations of the target (PR #71 review, amendment 2). */
    readonly grants?: readonly {
      readonly id: string;
      readonly userId: string;
      readonly scopeId: string | null;
    }[];
  }

  function fakes(world: World = {}) {
    lines.length = 0;
    const writes: Writes = { calls: [], audit: [], outbox: [] };
    const members = [...(world.members ?? [row()])];
    const projectMembers = [...(world.projectMembers ?? [])];
    const roles = world.roles ?? {
      [ROLE]: { keys: [MILESTONE_READ] },
      [OWNER_ROLE]: { systemKey: "owner", keys: [] },
      [FIN_ROLE]: { keys: [BUDGET_READ] },
    };
    const known = world.users ?? [USER, TARGET];
    const systemKeyOf = (roleId: string) => roles[roleId]?.systemKey ?? null;
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
      enqueue: (_tx, topic, payload) => {
        writes.calls.push(`outbox:${topic}`);
        writes.outbox.push({ topic, payload });
        return Promise.resolve("job");
      },
    };
    const sessions: SessionsRevoker = {
      revokeOfUserInTx: (_tx, _identity, userId) => {
        writes.calls.push(`revoke:${userId}`);
        return Promise.resolve([...(world.sessionsToClose ?? [])]);
      },
    };
    const clock = { now: () => NOW_MS };
    const rolesRepo = Object.assign(new RolesRepository(), {
      findOpen: (_tx: Tx, _orgId: string, id: string) => {
        writes.calls.push(`role:${id}`);
        const role = roles[id];
        return Promise.resolve(
          role === undefined
            ? undefined
            : {
                id,
                key: "k",
                name: "n",
                systemKey: role.systemKey ?? null,
                createdAt: T0,
                updatedAt: T0,
                archivedAt: null,
              },
        );
      },
      bundles: (_tx: Tx, _orgId: string, ids: readonly string[]) => {
        writes.calls.push(`bundles:${ids.length.toString()}`);
        const out = new Map<string, readonly string[]>();
        for (const id of ids) {
          const role = roles[id];
          if (role !== undefined) out.set(id, role.keys);
        }
        return Promise.resolve(out);
      },
    });
    const repo = Object.assign(new MembershipsRepository(), {
      listOrg: () => {
        writes.calls.push("list");
        return Promise.resolve(members.filter((m) => m.removedAt === null));
      },
      findOrg: (_tx: Tx, _orgId: string, id: string) => {
        writes.calls.push(`find:${id}`);
        return Promise.resolve(
          members.find((m) => m.id === id && m.removedAt === null),
        );
      },
      insertOrg: (
        _tx: Tx,
        input: {
          id: string;
          orgId: string;
          userId: string;
          roleId: string;
          now: string;
        },
      ) => {
        writes.calls.push("insert");
        // The users FK: an unknown user is not_found, as the repository maps 23503.
        if (!known.includes(input.userId))
          return Promise.reject(new ApiError("not_found"));
        if (
          members.some((m) => m.userId === input.userId && m.removedAt === null)
        ) {
          return Promise.reject(new ApiError("request.conflict"));
        }
        const made = row({
          id: input.id,
          userId: input.userId,
          roleId: input.roleId,
          systemKey: systemKeyOf(input.roleId),
          createdAt: input.now,
        });
        members.push(made);
        return Promise.resolve(made);
      },
      setOrgRole: (_tx: Tx, _orgId: string, id: string, roleId: string) => {
        writes.calls.push(`setRole:${roleId}`);
        const at = members.findIndex((m) => m.id === id);
        const updated = row({
          ...members[at],
          roleId,
          systemKey: systemKeyOf(roleId),
        });
        members[at] = updated;
        return Promise.resolve(updated);
      },
      removeOrg: (_tx: Tx, _orgId: string, id: string, now: string) => {
        writes.calls.push("remove");
        const at = members.findIndex(
          (m) => m.id === id && m.removedAt === null,
        );
        if (at < 0) return Promise.resolve(undefined);
        members[at] = row({ ...members[at], removedAt: now });
        return Promise.resolve({ id });
      },
      endAccessGrantsOf: (
        _tx: Tx,
        _orgId: string,
        userId: string,
        by: string,
        now: string,
        projectId?: string,
      ) => {
        writes.calls.push(`endGrants:${userId}:${projectId ?? "org"}`);
        return Promise.resolve(
          (world.grants ?? [])
            .filter(
              (g) =>
                g.userId === userId &&
                (projectId === undefined || g.scopeId === projectId),
            )
            .map((g) => ({ id: g.id, revokedAt: now, revokedBy: by })),
        );
      },
      removeProjectsOfUser: (_tx: Tx, _orgId: string, userId: string) => {
        writes.calls.push(`removeProjects:${userId}`);
        return Promise.resolve(
          projectMembers.filter(
            (m) => m.userId === userId && m.removedAt === null,
          ).length,
        );
      },
      lockOrg: () => {
        writes.calls.push("lock");
        return Promise.resolve();
      },
      countOpenOwners: () => {
        writes.calls.push("owners");
        return Promise.resolve(world.owners ?? 2);
      },
      listProject: (_tx: Tx, _orgId: string, projectId: string) => {
        writes.calls.push(`listProject:${projectId}`);
        return Promise.resolve(
          projectMembers.filter(
            (m) => m.projectId === projectId && m.removedAt === null,
          ),
        );
      },
      findProject: (_tx: Tx, _orgId: string, projectId: string, id: string) => {
        writes.calls.push(`findProject:${id}`);
        return Promise.resolve(
          projectMembers.find(
            (m) =>
              m.id === id && m.projectId === projectId && m.removedAt === null,
          ),
        );
      },
      insertProject: (
        _tx: Tx,
        input: {
          id: string;
          projectId: string;
          userId: string;
          roleId: string;
          overrides: { add: string[]; remove: string[] };
          now: string;
        },
      ) => {
        writes.calls.push("insertProject");
        const made = projectRow({
          id: input.id,
          projectId: input.projectId,
          userId: input.userId,
          roleId: input.roleId,
          systemKey: systemKeyOf(input.roleId),
          overrides: input.overrides,
          createdAt: input.now,
        });
        projectMembers.push(made);
        return Promise.resolve(made);
      },
      updateProject: (
        _tx: Tx,
        _orgId: string,
        id: string,
        patch: {
          roleId: string;
          systemKey: string | null;
          overrides: { add: string[]; remove: string[] };
        },
      ) => {
        writes.calls.push(`updateProject:${patch.roleId}`);
        const at = projectMembers.findIndex((m) => m.id === id);
        const updated = projectRow({
          ...projectMembers[at],
          roleId: patch.roleId,
          systemKey: patch.systemKey,
          overrides: patch.overrides,
        });
        projectMembers[at] = updated;
        return Promise.resolve(updated);
      },
      removeProject: (_tx: Tx, _orgId: string, id: string, now: string) => {
        writes.calls.push("removeProject");
        const at = projectMembers.findIndex(
          (m) => m.id === id && m.removedAt === null,
        );
        if (at < 0) return Promise.resolve(undefined);
        projectMembers[at] = projectRow({
          ...projectMembers[at],
          removedAt: now,
        });
        return Promise.resolve({ id });
      },
      accessRowsOf: (_tx: Tx, _orgId: string, userIds: readonly string[]) => {
        writes.calls.push(`access:${userIds.length.toString()}`);
        return Promise.resolve({
          memberships: members.filter(
            (m) => userIds.includes(m.userId) && m.removedAt === null,
          ),
          projects: projectMembers.filter(
            (m) => userIds.includes(m.userId) && m.removedAt === null,
          ),
        });
      },
      listMine: () => {
        writes.calls.push("mine");
        return Promise.resolve({ memberships: [], projects: [] });
      },
    });
    const service = new MembershipsService(
      runner,
      repo,
      rolesRepo,
      audit,
      outbox,
      sessions,
      clock,
      logger,
    );
    return { writes, service };
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

  /** A row as the API answers it (no system key). */
  const member = (over: Partial<MembershipRow> = {}, mfaRequired = false) => {
    const { id, userId, roleId, createdAt, removedAt } = row(over);
    return { id, userId, roleId, createdAt, removedAt, mfaRequired };
  };

  const owner = identity(["owner"]);
  const auditor = identity(["auditor"]);
  const manager = identity(["project_manager"], [PROJECT]);
  /** An owner without the finance keys: manages members but holds no finance.* key. */
  const noFinance: Identity = {
    ...owner,
    grants: owner.grants.filter(
      (grant) => !grant.permission.startsWith(MFA_KEY_PREFIX),
    ),
  };

  test("list: the open memberships with mfaRequired; a reader may; a project manager may not; nobody without an identity", async () => {
    const f = fakes({
      members: [row(), row({ id: SESSION, userId: USER, roleId: FIN_ROLE })],
    });
    const listed = await asIdentity(auditor, () => f.service.list());
    expect(listed).toEqual([
      member(),
      member({ id: SESSION, userId: USER, roleId: FIN_ROLE }, true),
    ]);
    expect(f.writes.calls).toEqual(["tx", "list", "access:2", "bundles:2"]);
    const g = fakes();
    await expect(
      asIdentity(manager, () => g.service.list()),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      asIdentity(undefined, () => g.service.list()),
    ).rejects.toBeInstanceOf(NoTenantContextError);
    expect(g.writes.calls).toEqual([]);
  });

  test("invite: the role, the user, the insert, the outbox row, then the audit event last; an unknown user or role is not_found; a reader is forbidden before any transaction", async () => {
    const f = fakes({ members: [] });
    const made = await asIdentity(owner, () =>
      f.service.invite({ userId: TARGET, roleId: ROLE }),
    );
    expect(made).toMatchObject({
      userId: TARGET,
      roleId: ROLE,
      createdAt: NOW,
      mfaRequired: false,
    });
    expect(f.writes.calls).toEqual([
      "tx",
      `role:${ROLE}`,
      "bundles:1",
      "insert",
      "access:1",
      "bundles:1",
      "outbox:users.mfa_check",
      "audit:org.member.invite",
    ]);
    expect(f.writes.outbox).toEqual([
      { topic: "users.mfa_check", payload: { userId: TARGET } },
    ]);
    expect(f.writes.audit[0]).toEqual({
      action: "org.member.invite",
      entityId: made.id,
      before: undefined,
      after: { userId: TARGET, roleId: ROLE },
    });
    await expect(
      asIdentity(owner, () =>
        f.service.invite({ userId: SESSION, roleId: ROLE }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      asIdentity(owner, () =>
        f.service.invite({ userId: TARGET, roleId: SESSION }),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    const g = fakes();
    await expect(
      asIdentity(auditor, () =>
        g.service.invite({ userId: TARGET, roleId: ROLE }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(g.writes.calls).toEqual([]);
  });

  test("invite: escalation: a role with a key the editor does not hold is forbidden after the role is read and before any write, with one grants.escalation line", async () => {
    const f = fakes({ members: [] });
    await expect(
      asIdentity(noFinance, () =>
        f.service.invite({ userId: TARGET, roleId: FIN_ROLE }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(f.writes.calls).toEqual(["tx", `role:${FIN_ROLE}`, "bundles:1"]);
    expect(warnings()).toEqual([
      expect.objectContaining({
        msg: "grants.escalation",
        userId: USER,
        orgId: ORG,
        key: BUDGET_READ,
      }),
    ]);
    // The virtual owner role: its bundle is ROLES.owner from code (held by an owner only).
    const g = fakes({ members: [] });
    await expect(
      asIdentity(noFinance, () =>
        g.service.invite({ userId: TARGET, roleId: OWNER_ROLE }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const h = fakes({ members: [] });
    expect(
      (
        await asIdentity(owner, () =>
          h.service.invite({ userId: TARGET, roleId: OWNER_ROLE }),
        )
      ).mfaRequired,
    ).toBe(true);
    expect(ROLES.owner.some((k) => k.startsWith(MFA_KEY_PREFIX))).toBe(true);
  });

  test("update: target protection (condition 3): the editor must hold every key of the current role; then escalation on the new role; the same role writes nothing", async () => {
    const f = fakes({ members: [row({ roleId: FIN_ROLE })] });
    await expect(
      asIdentity(noFinance, () =>
        f.service.update(MEMBERSHIP, { roleId: ROLE }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(f.writes.calls).toEqual(["tx", `find:${MEMBERSHIP}`, "bundles:1"]);
    expect(warnings().map((w) => w["key"])).toEqual([BUDGET_READ]);
    const g = fakes();
    await expect(
      asIdentity(noFinance, () =>
        g.service.update(MEMBERSHIP, { roleId: FIN_ROLE }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(g.writes.calls).toEqual([
      "tx",
      `find:${MEMBERSHIP}`,
      "bundles:1",
      `role:${FIN_ROLE}`,
      "bundles:1",
    ]);
    const h = fakes();
    const same = await asIdentity(owner, () =>
      h.service.update(MEMBERSHIP, { roleId: ROLE }),
    );
    expect(same).toEqual(member());
    expect(h.writes.audit).toEqual([]);
    expect(h.writes.outbox).toEqual([]);
  });

  test("update: a role change sets the role, enqueues users.mfa_check and audits before and after; demoting the last owner is request.conflict under the org lock; an unknown membership is not_found", async () => {
    const f = fakes();
    const changed = await asIdentity(owner, () =>
      f.service.update(MEMBERSHIP, { roleId: FIN_ROLE }),
    );
    expect(changed).toMatchObject({ roleId: FIN_ROLE, mfaRequired: true });
    expect(f.writes.calls).toEqual([
      "tx",
      `find:${MEMBERSHIP}`,
      "bundles:1",
      `role:${FIN_ROLE}`,
      "bundles:1",
      `setRole:${FIN_ROLE}`,
      "access:1",
      "bundles:1",
      "outbox:users.mfa_check",
      "audit:org.member.update",
    ]);
    expect(f.writes.audit[0]).toEqual({
      action: "org.member.update",
      entityId: MEMBERSHIP,
      before: { userId: TARGET, roleId: ROLE },
      after: { userId: TARGET, roleId: FIN_ROLE },
    });
    const g = fakes({
      members: [row({ roleId: OWNER_ROLE, systemKey: "owner" })],
      owners: 1,
    });
    await expect(
      asIdentity(owner, () => g.service.update(MEMBERSHIP, { roleId: ROLE })),
    ).rejects.toMatchObject({ code: "request.conflict" });
    expect(g.writes.calls).toEqual([
      "tx",
      `find:${MEMBERSHIP}`,
      `role:${ROLE}`,
      "bundles:1",
      "lock",
      "owners",
    ]);
    const h = fakes({
      members: [row({ roleId: OWNER_ROLE, systemKey: "owner" })],
      owners: 2,
    });
    expect(
      (
        await asIdentity(owner, () =>
          h.service.update(MEMBERSHIP, { roleId: ROLE }),
        )
      ).roleId,
    ).toBe(ROLE);
    await expect(
      asIdentity(owner, () => h.service.update(SESSION, { roleId: ROLE })),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("remove: target protection; the last owner is request.conflict; else the project rows close, the row closes, the sessions are revoked, users.mfa_check goes out and org.member.remove is audited last", async () => {
    const f = fakes({ members: [row({ roleId: FIN_ROLE })] });
    await expect(
      asIdentity(noFinance, () => f.service.remove(MEMBERSHIP)),
    ).rejects.toMatchObject({ code: "forbidden" });
    const g = fakes({
      members: [row({ roleId: OWNER_ROLE, systemKey: "owner" })],
      owners: 1,
    });
    await expect(
      asIdentity(owner, () => g.service.remove(MEMBERSHIP)),
    ).rejects.toMatchObject({ code: "request.conflict" });
    expect(g.writes.calls.at(-1)).toBe("owners");
    const h = fakes({
      projectMembers: [projectRow()],
      sessionsToClose: ["s1", "s2"],
      grants: [
        { id: GRANT_ORG, userId: TARGET, scopeId: null },
        { id: GRANT_PROJECT, userId: TARGET, scopeId: PROJECT },
      ],
    });
    await asIdentity(owner, () => h.service.remove(MEMBERSHIP));
    // PR #71 review, amendment 2: every open elevation of the user in the
    // org ends in the same transaction, revoked by the remover, one
    // org.access_grant.revoke event each; still one users.mfa_check.
    expect(h.writes.calls).toEqual([
      "tx",
      `find:${MEMBERSHIP}`,
      "bundles:1",
      `removeProjects:${TARGET}`,
      "remove",
      `endGrants:${TARGET}:org`,
      `revoke:${TARGET}`,
      "outbox:users.mfa_check",
      "audit:org.access_grant.revoke",
      "audit:org.access_grant.revoke",
      "audit:org.member.remove",
    ]);
    expect(h.writes.audit).toEqual([
      ...[GRANT_ORG, GRANT_PROJECT].map((id) => ({
        action: "org.access_grant.revoke",
        entityId: id,
        before: { revokedAt: null, revokedBy: null },
        after: {
          revokedAt: NOW,
          revokedBy: USER,
          cause: "org.member.remove",
        },
      })),
      {
        action: "org.member.remove",
        entityId: MEMBERSHIP,
        before: { userId: TARGET, roleId: ROLE },
        after: {
          projectMembershipsClosed: 1,
          sessionsClosed: 2,
          accessGrantsRevoked: 2,
        },
      },
    ]);
    await expect(
      asIdentity(owner, () => h.service.remove(MEMBERSHIP)),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      asIdentity(auditor, () => h.service.remove(MEMBERSHIP)),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("assign: the project policy at org or project scope; the user must be an org member; overrides validated against the bundle (422 with a path) and held by the editor (403); the owner role takes none", async () => {
    const f = fakes({ members: [row()] });
    const made = await asIdentity(manager, () =>
      f.service.assign(PROJECT, {
        userId: TARGET,
        roleId: ROLE,
        overrides: { add: [MILESTONE_CREATE] },
      }),
    );
    expect(made).toMatchObject({
      projectId: PROJECT,
      userId: TARGET,
      roleId: ROLE,
      mfaRequired: false,
    });
    expect(f.writes.calls).toEqual([
      "tx",
      `role:${ROLE}`,
      "bundles:1",
      "access:1",
      "insertProject",
      "access:1",
      "bundles:1",
      "outbox:users.mfa_check",
      "audit:project.member.assign",
    ]);
    expect(f.writes.audit[0]?.after).toEqual({
      userId: TARGET,
      projectId: PROJECT,
      roleId: ROLE,
      overrides: { add: [MILESTONE_CREATE], remove: [] },
    });
    await expect(
      asIdentity(manager, () =>
        f.service.assign(OTHER_PROJECT, { userId: TARGET, roleId: ROLE }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const g = fakes({ members: [] });
    await expect(
      asIdentity(owner, () =>
        g.service.assign(PROJECT, { userId: TARGET, roleId: ROLE }),
      ),
    ).rejects.toMatchObject({ code: "request.conflict" });
    const h = fakes();
    const invalid = asIdentity(owner, () =>
      h.service.assign(PROJECT, {
        userId: TARGET,
        roleId: ROLE,
        overrides: { add: [MILESTONE_READ] },
      }),
    );
    await expect(invalid).rejects.toBeInstanceOf(ValidationError);
    await expect(invalid).rejects.toMatchObject({
      envelope: {
        code: "validation_failed",
        issues: [{ path: ["overrides", "add"], code: "invalid_value" }],
      },
    });
    await expect(
      asIdentity(manager, () =>
        h.service.assign(PROJECT, {
          userId: TARGET,
          roleId: ROLE,
          overrides: { add: [BUDGET_APPROVE] },
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      asIdentity(owner, () =>
        h.service.assign(PROJECT, {
          userId: TARGET,
          roleId: OWNER_ROLE,
          overrides: { add: [MILESTONE_CREATE] },
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(h.writes.audit).toEqual([]);
  });

  test("updateProject: target protection and escalation at project scope; a changed role or overrides are audited with before and after; unassign closes the row, audits, revokes nothing", async () => {
    const f = fakes({ projectMembers: [projectRow({ roleId: FIN_ROLE })] });
    await expect(
      asIdentity(noFinance, () =>
        f.service.updateProject(PROJECT, PROJECT_MEMBERSHIP, { roleId: ROLE }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const g = fakes({
      projectMembers: [projectRow()],
      grants: [
        { id: GRANT_ORG, userId: TARGET, scopeId: null },
        { id: GRANT_PROJECT, userId: TARGET, scopeId: PROJECT },
      ],
    });
    const changed = await asIdentity(manager, () =>
      g.service.updateProject(PROJECT, PROJECT_MEMBERSHIP, {
        overrides: { add: [MILESTONE_CREATE] },
      }),
    );
    expect(changed.id).toBe(PROJECT_MEMBERSHIP);
    expect(g.writes.audit[0]).toMatchObject({
      action: "project.member.assign",
      before: {
        userId: TARGET,
        projectId: PROJECT,
        roleId: ROLE,
        overrides: { add: [], remove: [] },
      },
    });
    expect(g.writes.outbox).toHaveLength(1);
    await expect(
      asIdentity(manager, () =>
        g.service.updateProject(PROJECT, PROJECT_MEMBERSHIP, {
          overrides: { add: [BUDGET_APPROVE] },
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      asIdentity(manager, () =>
        g.service.updateProject(OTHER_PROJECT, PROJECT_MEMBERSHIP, {
          roleId: ROLE,
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    const unchanged = await asIdentity(manager, () =>
      g.service.updateProject(PROJECT, PROJECT_MEMBERSHIP, { roleId: ROLE }),
    );
    expect(unchanged.roleId).toBe(ROLE);
    expect(g.writes.audit).toHaveLength(1);
    await asIdentity(manager, () =>
      g.service.unassign(PROJECT, PROJECT_MEMBERSHIP),
    );
    expect(g.writes.calls.filter((c) => c.startsWith("revoke"))).toEqual([]);
    // PR #71 review, amendment 2: the user's open elevations scoped to
    // this project end (the org one stands), one event each, before the
    // unassign event.
    expect(g.writes.calls.slice(-4)).toEqual([
      `endGrants:${TARGET}:${PROJECT}`,
      "outbox:users.mfa_check",
      "audit:org.access_grant.revoke",
      "audit:project.member.unassign",
    ]);
    expect(g.writes.audit.at(-2)).toEqual({
      action: "org.access_grant.revoke",
      entityId: GRANT_PROJECT,
      before: { revokedAt: null, revokedBy: null },
      after: {
        revokedAt: NOW,
        revokedBy: USER,
        cause: "project.member.unassign",
      },
    });
    expect(g.writes.audit.at(-1)).toMatchObject({
      action: "project.member.unassign",
      entityId: PROJECT_MEMBERSHIP,
      after: { accessGrantsRevoked: 1 },
    });
    await expect(
      asIdentity(manager, () =>
        g.service.unassign(PROJECT, PROJECT_MEMBERSHIP),
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("listMine: the caller's rows without any grant", async () => {
    const f = fakes();
    expect(await asIdentity(identity([]), () => f.service.listMine())).toEqual(
      [],
    );
    expect(f.writes.calls).toEqual(["tx", "mine"]);
  });
});
