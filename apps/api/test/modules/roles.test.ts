// The roles module without a database (P5-05, ADR 0066; plan 3.1-3.3):
// holdsAll() (the escalation rule: an editor grants only what they hold at
// org scope), financeChanged() (whether an edit moves the MFA requirement
// of the role's members, D5) and the boundary schemas (key, name and a
// bundle of catalogue keys, unique, bounded).
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
import { ApiError } from "../../src/common/errors/api-error.js";
import {
  CreateRole,
  ROLE_KEY_MAX,
  ROLE_NAME_MAX,
  UpdateRole,
} from "../../src/modules/roles/roles.dto.js";
import { USERS_MFA_CHECK } from "../../src/modules/roles/roles.events.js";
import {
  type NewRole,
  type RoleRow,
  RolesRepository,
} from "../../src/modules/roles/roles.repository.js";
import {
  MAX_MFA_FANOUT,
  type OutboxWriter,
  RolesService,
  financeChanged,
} from "../../src/modules/roles/roles.service.js";
import {
  type AuditRecorder,
  type TransactionRunner,
} from "../../src/modules/sessions/public-api.js";
import { grantsOf } from "../support/auth.js";

const ORG = "0199e1a0-0000-7000-8000-00000000000a";
const USER = "0199e1a0-0000-7000-8000-000000000001";
const PROJECT = "0199e1a0-0000-7000-8000-000000000010";

const identity = (
  roles: readonly string[],
  projects: readonly string[] = [],
): Identity => ({
  orgId: ORG,
  userId: USER,
  projectIds: [...projects],
  allProjects: false,
  grants: grantsOf({ roles, projects }),
  sessionId: "0199e1a0-0000-7000-8000-00000000005e",
  deviceId: undefined,
});

describe("holdsAll(): every key held at org scope, else the first refused", () => {
  test("an owner holds every catalogue key, at any scope", () => {
    const ability = abilityFor(identity(["owner"]));
    expect(holdsAll(ability, ORG, CATALOGUE)).toBeUndefined();
    expect(holdsAll(ability, ORG, [])).toBeUndefined();
  });

  test("a project manager holds nothing at org scope but their org keys: a project key of theirs is refused (it is held on their projects only)", () => {
    const ability = abilityFor(identity(["project_manager"], [PROJECT]));
    expect(
      holdsAll(ability, ORG, ["supply.material.read.org"]),
    ).toBeUndefined();
    expect(
      holdsAll(ability, ORG, [
        "supply.material.read.org",
        "project.milestone.read.project",
        "project.milestone.create.project",
      ]),
    ).toBe("project.milestone.read.project");
  });

  test("an auditor holds its reads at org scope, in any scope spelling, and no write", () => {
    const ability = abilityFor(identity(["auditor"]));
    expect(
      holdsAll(ability, ORG, [
        "project.milestone.read.org",
        "project.milestone.read.project",
        "field.dailylog.read.site",
      ]),
    ).toBeUndefined();
    expect(
      holdsAll(ability, ORG, [
        "project.milestone.read.org",
        "project.milestone.create.project",
      ]),
    ).toBe("project.milestone.create.project");
  });

  test("a key the catalogue does not know is refused, never a throw", () => {
    const ability = abilityFor(identity(["owner"]));
    expect(holdsAll(ability, ORG, ["nope.nope.nope.org"])).toBe(
      "nope.nope.nope.org",
    );
    expect(holdsAll(ability, ORG, ["org.role.manage"])).toBe("org.role.manage");
  });

  test("the identity holds nothing without grants", () => {
    const ability = abilityFor(identity([]));
    expect(holdsAll(ability, ORG, ["org.role.read.org"])).toBe(
      "org.role.read.org",
    );
  });
});

describe("financeChanged(): the finance.* keys of a bundle moved", () => {
  test("adding or removing a finance key changes it; other keys do not; order does not matter", () => {
    const before = ["org.role.read.org", "finance.budget.read.project"];
    expect(financeChanged(before, [...before].reverse())).toBe(false);
    expect(financeChanged(before, ["org.role.read.org"])).toBe(true);
    expect(
      financeChanged(before, [...before, "finance.budget.update.project"]),
    ).toBe(true);
    expect(financeChanged(before, [...before, "org.member.read.org"])).toBe(
      false,
    );
    expect(financeChanged([], [])).toBe(false);
    expect(financeChanged(ROLES.accountant, ROLES.auditor)).toBe(true);
  });
});

describe("the boundary schemas", () => {
  const valid = {
    key: "site_lead",
    name: "Site lead",
    permissions: ["project.milestone.read.project", "org.role.read.org"],
  };

  test("a valid create parses; the bounds are the table's", () => {
    expect(CreateRole.schema.parse(valid)).toEqual(valid);
    expect(ROLE_KEY_MAX).toBe(64);
    expect(ROLE_NAME_MAX).toBe(100);
    expect(
      CreateRole.schema.safeParse({
        ...valid,
        key: `a${"b".repeat(ROLE_KEY_MAX - 1)}`,
        name: "n".repeat(ROLE_NAME_MAX),
        permissions: [],
      }).success,
    ).toBe(true);
  });

  test.each([
    ["a key starting with a digit", { key: "1abc" }],
    ["a key with a capital", { key: "Site" }],
    ["a key with a dash", { key: "site-lead" }],
    ["an empty key", { key: "" }],
    ["a key too long", { key: `a${"b".repeat(ROLE_KEY_MAX)}` }],
    ["an empty name", { name: "" }],
    ["a name too long", { name: "n".repeat(ROLE_NAME_MAX + 1) }],
    [
      "a permission the catalogue lacks",
      { permissions: ["nope.nope.nope.org"] },
    ],
    ["a permission without a scope", { permissions: ["org.role.read"] }],
    [
      "a duplicate permission",
      { permissions: ["org.role.read.org", "org.role.read.org"] },
    ],
    [
      "too many permissions",
      { permissions: [...CATALOGUE, "org.role.read.org"] },
    ],
    ["a permission that is not a string", { permissions: [7] }],
    ["an unknown field", { systemKey: "owner" }],
  ])("%s is refused", (_what, patch) => {
    expect(CreateRole.schema.safeParse({ ...valid, ...patch }).success).toBe(
      false,
    );
  });

  test("an update takes a name, permissions or both, and nothing else", () => {
    expect(UpdateRole.schema.safeParse({ name: "New" }).success).toBe(true);
    expect(UpdateRole.schema.safeParse({ permissions: [] }).success).toBe(true);
    expect(UpdateRole.schema.safeParse({}).success).toBe(false);
    expect(UpdateRole.schema.safeParse({ key: "other" }).success).toBe(false);
  });
});

// RolesService over plain fakes (plan 3.5): the policy check before any
// transaction, what each call reads, writes, audits and enqueues, in what
// order, and the escalation line. The end-to-end behaviour on Postgres is
// in roles.int.test.ts.
describe("RolesService", () => {
  const ROLE = "0199e1a0-0000-7000-8000-000000000101";
  const OWNER_ROLE = "0199e1a0-0000-7000-8000-000000000100";
  const MEMBER = "0199e1a0-0000-7000-8000-000000000201";
  const OTHER_MEMBER = "0199e1a0-0000-7000-8000-000000000202";
  const T0 = "2026-10-21T10:00:00.000000Z";
  const NOW_MS = Date.UTC(2026, 9, 22, 12, 0, 0);
  const NOW = new Date(NOW_MS).toISOString();
  const READ = "org.role.read.org";
  const MEMBER_READ = "org.member.read.org";
  const BUDGET_READ = "finance.budget.read.project";
  const BUDGET_UPDATE = "finance.budget.update.project";

  // One pino logger per file, its lines kept (nestjs-pino builds one root
  // logger per module registry; vitest gives each file its own).
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
    readonly granted: { roleId: string; permission: string }[];
    readonly revoked: { roleId: string; keys: readonly string[] }[];
  }
  // The fake transaction handle: the fakes never use it (one disclosed
  // cast; a drizzle transaction cannot be built without a connection).
  const TX = {} as unknown as Tx;

  const row = (over: Partial<RoleRow> = {}): RoleRow => ({
    id: ROLE,
    key: "site_lead",
    name: "Site lead",
    systemKey: null,
    createdAt: T0,
    updatedAt: T0,
    archivedAt: null,
    ...over,
  });
  const ownerRow = (): RoleRow =>
    row({ id: OWNER_ROLE, key: "owner", name: "Owner", systemKey: "owner" });

  interface World {
    readonly rows?: readonly RoleRow[];
    readonly bundles?: Readonly<Record<string, readonly string[]>>;
    readonly members?: readonly string[];
    /** The archive statement matched no open row (closed meanwhile). */
    readonly archiveReturnsNothing?: boolean;
  }

  function fakes(world: World = {}) {
    lines.length = 0;
    const writes: Writes = {
      calls: [],
      audit: [],
      outbox: [],
      granted: [],
      revoked: [],
    };
    const rows = world.rows ?? [row()];
    const bundles = new Map(
      Object.entries(world.bundles ?? { [ROLE]: [READ, BUDGET_READ] }),
    );
    const members = world.members ?? [];
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
    const clock = { now: () => NOW_MS };
    const repository = Object.assign(new RolesRepository(), {
      list: (_tx: Tx, orgId: string) => {
        writes.calls.push(`list:${orgId}`);
        return Promise.resolve(rows.filter((r) => r.archivedAt === null));
      },
      findOpen: (_tx: Tx, orgId: string, id: string) => {
        writes.calls.push(`find:${orgId}:${id}`);
        return Promise.resolve(
          rows.find((r) => r.id === id && r.archivedAt === null),
        );
      },
      bundles: (_tx: Tx, _orgId: string, ids: readonly string[]) => {
        writes.calls.push(`bundles:${ids.join(",")}`);
        const out = new Map<string, readonly string[]>();
        for (const id of ids) {
          const keys = bundles.get(id);
          if (keys !== undefined) out.set(id, keys);
        }
        return Promise.resolve(out);
      },
      insert: (_tx: Tx, role: NewRole) => {
        writes.calls.push(`insert:${role.key}`);
        if (rows.some((r) => r.key === role.key)) {
          return Promise.reject(new ApiError("request.conflict"));
        }
        return Promise.resolve(
          row({
            id: role.id,
            key: role.key,
            name: role.name,
            createdAt: role.now,
            updatedAt: role.now,
          }),
        );
      },
      grant: (
        _tx: Tx,
        _orgId: string,
        roleId: string,
        granted: readonly { permission: string }[],
      ) => {
        writes.calls.push(
          `grant:${granted.map((g) => g.permission).join(",")}`,
        );
        for (const g of granted)
          writes.granted.push({ roleId, permission: g.permission });
        return Promise.resolve();
      },
      revoke: (
        _tx: Tx,
        _orgId: string,
        roleId: string,
        keys: readonly string[],
      ) => {
        writes.calls.push(`revoke:${keys.join(",")}`);
        writes.revoked.push({ roleId, keys });
        return Promise.resolve();
      },
      touch: (
        _tx: Tx,
        _orgId: string,
        id: string,
        patch: { name?: string | undefined; now: string },
      ) => {
        writes.calls.push(`touch:${patch.name ?? ""}`);
        const found = rows.find((r) => r.id === id);
        if (found === undefined) return Promise.reject(new Error("no row"));
        return Promise.resolve(
          row({
            ...found,
            ...(patch.name === undefined ? {} : { name: patch.name }),
            updatedAt: patch.now,
          }),
        );
      },
      archive: (_tx: Tx, _orgId: string, id: string, now: string) => {
        writes.calls.push("archive");
        const found = rows.find((r) => r.id === id && r.archivedAt === null);
        return Promise.resolve(
          found === undefined || world.archiveReturnsNothing === true
            ? undefined
            : row({ ...found, archivedAt: now, updatedAt: now }),
        );
      },
      memberUserIds: (
        _tx: Tx,
        _orgId: string,
        _roleId: string,
        limit: number,
      ) => {
        writes.calls.push(`members:${String(limit)}`);
        return Promise.resolve(members.slice(0, limit));
      },
    });
    const service = new RolesService(
      runner,
      repository,
      audit,
      outbox,
      clock,
      logger,
    );
    return { writes, service };
  }

  /**
   * Runs `fn` inside a request whose identity is `identity`. The policy
   * check throws before the promise exists (create, update and archive are
   * not async), so the callback is: a sync throw becomes a rejection.
   */
  const asIdentity = <T>(who: Identity | undefined, fn: () => Promise<T>) =>
    runWithRequestContext(
      { correlationId: "corr-1", ip: "127.0.0.1", deviceId: undefined },
      async () => {
        if (who !== undefined) setIdentity(who);
        return fn();
      },
    );

  const owner = identity(["owner"]);
  const auditor = identity(["auditor"]);
  const manager = identity(["project_manager"], [PROJECT]);
  /** An editor who may manage roles but holds no finance.* key. */
  const noFinance: Identity = {
    ...owner,
    grants: owner.grants.filter(
      (grant) => !grant.permission.startsWith(MFA_KEY_PREFIX),
    ),
  };

  test("list: the open roles with their bundles sorted, the owner's from code; a reader may, a project manager may not, and nobody without an identity", async () => {
    const f = fakes({
      rows: [ownerRow(), row()],
      bundles: {
        [ROLE]: [BUDGET_READ, READ],
        [OWNER_ROLE]: ["nope.nope.nope.org"],
      },
    });
    const listed = await asIdentity(owner, () => f.service.list());
    expect(listed.map((r) => r.id)).toEqual([OWNER_ROLE, ROLE]);
    expect(listed[0]?.permissions).toEqual([...ROLES.owner].sort());
    expect(listed[1]).toEqual({ ...row(), permissions: [BUDGET_READ, READ] });
    expect(f.writes.calls).toEqual([
      "tx",
      `list:${ORG}`,
      `bundles:${OWNER_ROLE},${ROLE}`,
    ]);

    expect((await asIdentity(auditor, () => f.service.list())).length).toBe(2);
    const g = fakes();
    await expect(
      asIdentity(manager, () => g.service.list()),
    ).rejects.toMatchObject({ code: "forbidden" });
    await expect(
      asIdentity(undefined, () => g.service.list()),
    ).rejects.toBeInstanceOf(NoTenantContextError);
    expect(g.writes.calls).toEqual([]);
  });

  test("get: one open role, else not_found", async () => {
    const f = fakes();
    expect(await asIdentity(auditor, () => f.service.get(ROLE))).toEqual({
      ...row(),
      permissions: [BUDGET_READ, READ],
    });
    await expect(
      asIdentity(auditor, () => f.service.get(OWNER_ROLE)),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  test("create: insert, the deduplicated sorted bundle, then the audit event, last; a taken key is request.conflict", async () => {
    const f = fakes();
    const made = await asIdentity(owner, () =>
      f.service.create({
        key: "lead",
        name: "Lead",
        permissions: [READ, MEMBER_READ, READ],
      }),
    );
    expect(made).toMatchObject({
      key: "lead",
      name: "Lead",
      systemKey: null,
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
    });
    expect(made.permissions).toEqual([MEMBER_READ, READ]);
    expect(f.writes.calls).toEqual([
      "tx",
      "insert:lead",
      `grant:${MEMBER_READ},${READ}`,
      "audit:org.role.create",
    ]);
    expect(f.writes.audit[0]).toEqual({
      action: "org.role.create",
      entityId: made.id,
      before: undefined,
      after: { key: "lead", name: "Lead", permissions: [MEMBER_READ, READ] },
    });
    expect(f.writes.granted.map((g) => g.roleId)).toEqual([made.id, made.id]);
    await expect(
      asIdentity(owner, () =>
        f.service.create({ key: "site_lead", name: "Again", permissions: [] }),
      ),
    ).rejects.toMatchObject({ code: "request.conflict" });
  });

  test("create: a reader is forbidden before any transaction; an editor granting a key they do not hold is forbidden before any transaction, with one grants.escalation line naming the first refused key", async () => {
    const f = fakes();
    await expect(
      asIdentity(auditor, () =>
        f.service.create({ key: "lead", name: "Lead", permissions: [READ] }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(f.writes.calls).toEqual([]);
    expect(warnings()).toEqual([]);

    await expect(
      asIdentity(noFinance, () =>
        f.service.create({
          key: "lead",
          name: "Lead",
          permissions: [READ, BUDGET_READ, BUDGET_UPDATE],
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(f.writes.calls).toEqual([]);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0]).toMatchObject({
      msg: "grants.escalation",
      userId: USER,
      orgId: ORG,
      key: BUDGET_READ,
      context: "roles",
    });
    expect(JSON.stringify(warnings()[0])).not.toContain(BUDGET_UPDATE);
  });

  test("update: the owner role is request.conflict; an unchanged update writes and audits nothing", async () => {
    const f = fakes({ rows: [ownerRow(), row()] });
    await expect(
      asIdentity(owner, () => f.service.update(OWNER_ROLE, { name: "X" })),
    ).rejects.toMatchObject({
      code: "request.conflict",
    });
    const same = await asIdentity(owner, () =>
      f.service.update(ROLE, {
        name: "Site lead",
        permissions: [BUDGET_READ, READ],
      }),
    );
    expect(same).toEqual({ ...row(), permissions: [BUDGET_READ, READ] });
    expect(
      f.writes.calls.filter(
        (c) =>
          !c.startsWith("tx") &&
          !c.startsWith("find") &&
          !c.startsWith("bundles"),
      ),
    ).toEqual([]);
    expect(f.writes.audit).toEqual([]);
    await expect(
      asIdentity(owner, () => f.service.update(MEMBER, { name: "X" })),
    ).rejects.toMatchObject({
      code: "not_found",
    });
  });

  test("update: a rename alone touches the row and audits before and after; no revoke, grant or outbox", async () => {
    const f = fakes();
    const renamed = await asIdentity(owner, () =>
      f.service.update(ROLE, { name: "Lead" }),
    );
    expect(renamed).toEqual({
      ...row({ name: "Lead", updatedAt: NOW }),
      permissions: [BUDGET_READ, READ],
    });
    expect(f.writes.calls).toEqual([
      "tx",
      `find:${ORG}:${ROLE}`,
      `bundles:${ROLE}`,
      "revoke:",
      "grant:",
      "touch:Lead",
      "audit:org.role.update",
    ]);
    expect(f.writes.revoked).toEqual([{ roleId: ROLE, keys: [] }]);
    expect(f.writes.granted).toEqual([]);
    expect(f.writes.outbox).toEqual([]);
    expect(f.writes.audit[0]).toEqual({
      action: "org.role.update",
      entityId: ROLE,
      before: {
        key: "site_lead",
        name: "Site lead",
        permissions: [BUDGET_READ, READ],
      },
      after: {
        key: "site_lead",
        name: "Lead",
        permissions: [BUDGET_READ, READ],
      },
    });
  });

  test("update: a bundle change revokes the dropped keys and grants the added ones; a finance move enqueues users.mfa_check once per member, before the audit event", async () => {
    const f = fakes({ members: [MEMBER, OTHER_MEMBER] });
    const changed = await asIdentity(owner, () =>
      f.service.update(ROLE, {
        permissions: [READ, MEMBER_READ, BUDGET_UPDATE],
      }),
    );
    expect(changed.permissions).toEqual([BUDGET_UPDATE, MEMBER_READ, READ]);
    expect(f.writes.calls).toEqual([
      "tx",
      `find:${ORG}:${ROLE}`,
      `bundles:${ROLE}`,
      `revoke:${BUDGET_READ}`,
      `grant:${BUDGET_UPDATE},${MEMBER_READ}`,
      "touch:",
      `members:${String(MAX_MFA_FANOUT + 1)}`,
      "outbox:users.mfa_check",
      "outbox:users.mfa_check",
      "audit:org.role.update",
    ]);
    expect(f.writes.outbox).toEqual([
      { topic: USERS_MFA_CHECK, payload: { userId: MEMBER } },
      { topic: USERS_MFA_CHECK, payload: { userId: OTHER_MEMBER } },
    ]);

    // No finance move: no member lookup, no outbox row.
    const g = fakes({ members: [MEMBER] });
    await asIdentity(owner, () =>
      g.service.update(ROLE, { permissions: [READ, BUDGET_READ, MEMBER_READ] }),
    );
    expect(
      g.writes.calls.some(
        (c) => c.startsWith("members") || c.startsWith("outbox"),
      ),
    ).toBe(false);
    expect(g.writes.audit).toHaveLength(1);
  });

  test("update: a finance move over MAX_MFA_FANOUT members is request.conflict, nothing enqueued or audited", async () => {
    const members = Array.from(
      { length: MAX_MFA_FANOUT + 1 },
      (_, i) => `0199e1a0-0000-7000-8000-${String(i).padStart(12, "0")}`,
    );
    const f = fakes({ members });
    await expect(
      asIdentity(owner, () => f.service.update(ROLE, { permissions: [READ] })),
    ).rejects.toMatchObject({
      code: "request.conflict",
    });
    expect(f.writes.outbox).toEqual([]);
    expect(f.writes.audit).toEqual([]);
    expect(MAX_MFA_FANOUT).toBe(1000);
  });

  test("update: an added key the editor does not hold is forbidden after the read and before any write, logged once; a kept key they do not hold is not re-checked", async () => {
    const f = fakes();
    await expect(
      asIdentity(noFinance, () =>
        f.service.update(ROLE, {
          permissions: [READ, BUDGET_READ, BUDGET_UPDATE],
        }),
      ),
    ).rejects.toMatchObject({ code: "forbidden" });
    expect(f.writes.calls).toEqual([
      "tx",
      `find:${ORG}:${ROLE}`,
      `bundles:${ROLE}`,
    ]);
    expect(warnings().map((w) => w["key"])).toEqual([BUDGET_UPDATE]);

    const g = fakes();
    const kept = await asIdentity(noFinance, () =>
      g.service.update(ROLE, { permissions: [READ, BUDGET_READ, MEMBER_READ] }),
    );
    expect(kept.permissions).toEqual([BUDGET_READ, MEMBER_READ, READ]);
    expect(warnings()).toEqual([]);
    await expect(
      asIdentity(auditor, () => g.service.update(ROLE, { name: "X" })),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("archive: the owner role and a role in use are request.conflict; an unused role is archived and audited with its bundle; a reader may not", async () => {
    const f = fakes({ rows: [ownerRow(), row()], members: [MEMBER] });
    await expect(
      asIdentity(owner, () => f.service.archive(OWNER_ROLE)),
    ).rejects.toMatchObject({ code: "request.conflict" });
    await expect(
      asIdentity(owner, () => f.service.archive(ROLE)),
    ).rejects.toMatchObject({ code: "request.conflict" });
    expect(f.writes.calls.filter((c) => c === "archive")).toEqual([]);
    expect(f.writes.audit).toEqual([]);

    const g = fakes();
    const gone = await asIdentity(owner, () => g.service.archive(ROLE));
    expect(gone).toEqual({
      ...row({ archivedAt: NOW, updatedAt: NOW }),
      permissions: [BUDGET_READ, READ],
    });
    expect(g.writes.calls).toEqual([
      "tx",
      `find:${ORG}:${ROLE}`,
      `bundles:${ROLE}`,
      "members:1",
      "archive",
      "audit:org.role.archive",
    ]);
    expect(g.writes.audit[0]).toEqual({
      action: "org.role.archive",
      entityId: ROLE,
      before: {
        key: "site_lead",
        name: "Site lead",
        permissions: [BUDGET_READ, READ],
      },
      after: undefined,
    });
    await expect(
      asIdentity(owner, () => g.service.archive(MEMBER)),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      asIdentity(auditor, () => g.service.archive(ROLE)),
    ).rejects.toMatchObject({ code: "forbidden" });
  });

  test("archive: a row closed between the read and the update is not_found", async () => {
    const f = fakes({ archiveReturnsNothing: true });
    await expect(
      asIdentity(owner, () => f.service.archive(ROLE)),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(f.writes.audit).toEqual([]);
  });
});
