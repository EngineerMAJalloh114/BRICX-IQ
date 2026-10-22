// The roles module end to end (P5-05, ADR 0066; plan 3.1, 3.2, 3.5, 3.6;
// Done-when DW2), against compose.yml's Postgres with the production
// journal, through the real app with the production grants source
// (seeded memberships, test/support applyAccess). org.role.read.org
// lists and reads open roles with their open keys (the owner's bundle
// from code); org.role.manage.org creates, edits and archives bundles,
// granting only keys the editor holds at org scope (403 grants.escalation
// otherwise); the owner role is 409 for any change; a role in use cannot
// be archived (409); every change is one audit event in the org chain
// with before and after; an edit that moves a finance.* key enqueues one
// users.mfa_check per member of the role (owner condition 7).
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { ROLES } from "@bricx/permissions/roles";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  REPLAYED_HEADER,
} from "../../src/common/idempotency/decorator.js";
import { Role, RoleList } from "../../src/modules/roles/roles.dto.js";
import { apiEnv } from "../env.js";
import { fakeProbes } from "../probes.js";
import {
  fixedRevocations,
  TestIssuer,
  applyAccess,
  bearer,
  seedId,
  seedRole,
  seedUsers,
} from "../support/auth.js";

const HOOK_MS = 300_000;
const ORG_A = "0199e1a0-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1a0-0000-7000-8000-0000000000b1";
const PROJECT = "0199e1a0-0000-7000-8000-0000000000a3";
const users = {
  owner: "0199e1a0-0000-7000-8000-0000000000e1",
  auditor: "0199e1a0-0000-7000-8000-0000000000e2",
  editor: "0199e1a0-0000-7000-8000-0000000000e3",
  manager: "0199e1a0-0000-7000-8000-0000000000e4",
  ownerB: "0199e1a0-0000-7000-8000-0000000000e5",
  member1: "0199e1a0-0000-7000-8000-0000000000e6",
  member2: "0199e1a0-0000-7000-8000-0000000000e7",
} as const;
const subOf = (user: string) => `roles-${user}`;
const ROUTE = "/v1/roles";
const FINANCE_KEY = "finance.budget.read.project";

let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
let app: NestFastifyApplication;
const lines: string[] = [];
/** The seeded roles' ids by key (org A). */
const seeded: Record<string, string> = {};
const seededId = (key: string): string => {
  const id = seeded[key];
  if (id === undefined) throw new Error(`no seeded role ${key}`);
  return id;
};

let keyCounter = 0;
const newKey = () => {
  keyCounter += 1;
  return `roles-key-${String(keyCounter)}`;
};

const urlFor = (role: string, key: string) =>
  `postgres://${role}:${exampleValue(key)}@${pg18.container.getHost()}:${String(pg18.container.getMappedPort(5432))}/${appDatabase}`;

async function asAdmin<R extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<R[]> {
  const admin = await pg18.admin();
  try {
    return (await admin.query<R>(text, params)).rows;
  } finally {
    await admin.end();
  }
}

beforeAll(async () => {
  [pg18, issuer] = await Promise.all([startPostgres(), TestIssuer.start()]);
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  await seedUsers(
    asAdmin,
    Object.values(users).map((id) => ({ id, sub: subOf(id) })),
  );
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.owner,
    role: "owner",
  });
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.auditor,
    role: "auditor",
  });
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.manager,
    role: "project_manager",
  });
  await applyAccess(asAdmin, {
    orgId: ORG_B,
    userId: users.ownerB,
    role: "owner",
  });
  // The editor: manages roles and reads milestones org-wide, nothing else.
  const editor = await seedRole(asAdmin, ORG_A, "editor");
  for (const permission of [
    "org.role.manage.org",
    "org.role.read.org",
    "project.milestone.read.org",
    "project.milestone.update.org",
  ]) {
    await asAdmin(
      `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
      [seedId(), ORG_A, editor, permission],
    );
  }
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.editor,
    role: "editor",
  });
  // finrole: one finance key; member1 holds it in the org and on a
  // project, member2 on the project only.
  const finrole = await seedRole(asAdmin, ORG_A, "finrole");
  await asAdmin(
    `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
     VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
    [seedId(), ORG_A, finrole, FINANCE_KEY],
  );
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.member1,
    role: "finrole",
    projects: [PROJECT],
  });
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.member2,
    role: "member",
  });
  await asAdmin(
    `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute')`,
    [seedId(), ORG_A, PROJECT, users.member2, finrole],
  );
  for (const key of [
    "owner",
    "auditor",
    "project_manager",
    "editor",
    "finrole",
    "member",
  ]) {
    seeded[key] = await seedRole(asAdmin, ORG_A, key);
  }
  app = await createApp(
    loadApiConfig(
      apiEnv({
        ...issuer.env(),
        DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
      }),
    ),
    {
      probes: fakeProbes(),
      revocationStore: fixedRevocations(),
      logStream: new Writable({
        write(chunk: Buffer, _encoding, done) {
          lines.push(...chunk.toString("utf8").split("\n").filter(Boolean));
          done();
        },
      }),
    },
  );
  await app.init();
}, HOOK_MS);
afterAll(async () => {
  await app.close().catch(() => undefined);
  await issuer.close();
  await pg18.container.stop();
}, HOOK_MS);

type Res = Awaited<ReturnType<NestFastifyApplication["inject"]>>;
async function call(
  user: string | undefined,
  method: "GET" | "POST" | "PATCH",
  url: string,
  body?: unknown,
  options: { org?: string; key?: string | null } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (user !== undefined) {
    Object.assign(
      headers,
      bearer(
        await issuer.token({
          sub: subOf(user),
          org_id: options.org ?? ORG_A,
          exp: Math.floor(Date.now() / 1000) + 3_600,
        }),
      ),
    );
  }
  if (method === "POST" && options.key !== null) {
    headers[IDEMPOTENCY_KEY_HEADER] = options.key ?? newKey();
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.inject({
    method,
    url,
    headers,
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

function expectProblem(res: Res, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
  expect(parsed.success).toBe(true);
  expect(parsed.data).toMatchObject({ status, code, key: `errors:${code}` });
}

const roleOf = (res: Res) => {
  expect(res.statusCode, res.body).toBe(res.statusCode === 201 ? 201 : 200);
  return Role.schema.parse(JSON.parse(res.body));
};

async function listAs(user: string, org = ORG_A) {
  const res = await call(user, "GET", ROUTE, undefined, { org });
  expect(res.statusCode, res.body).toBe(200);
  return RoleList.schema.parse(JSON.parse(res.body)).items;
}

interface AuditRow extends Record<string, unknown> {
  action: string;
  entity_type: string;
  actor_id: string;
  before: unknown;
  after: unknown;
}
const auditOf = (entityId: string) =>
  asAdmin<AuditRow>(
    `SELECT action, entity_type, actor_id::text, before, after
     FROM bricx.audit_events WHERE entity_id = $1 ORDER BY seq`,
    [entityId],
  );

interface PermissionDb extends Record<string, unknown> {
  permission: string;
  revoked: boolean;
}
const permissionRows = (roleId: string) =>
  asAdmin<PermissionDb>(
    `SELECT permission, (revoked_at IS NOT NULL) AS revoked
     FROM bricx.role_permissions WHERE role_id = $1 ORDER BY permission, granted_at`,
    [roleId],
  );

const mfaChecks = () =>
  asAdmin<{ user_id: string; org_id: string }>(
    `SELECT payload->>'userId' AS user_id, org_id::text
     FROM bricx.outbox WHERE topic = 'users.mfa_check' ORDER BY id`,
  );

const logged = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

const sorted = (keys: readonly string[]) => [...keys].sort();

describe("GET /v1/roles and GET /v1/roles/:id (org.role.read.org)", () => {
  test("the owner lists the org's open roles, newest first, each with its open keys; the owner bundle comes from code", async () => {
    const items = await listAs(users.owner);
    const byKey = new Map(items.map((r) => [r.key, r]));
    expect([...byKey.keys()].sort()).toEqual(
      expect.arrayContaining([
        "owner",
        "auditor",
        "project_manager",
        "editor",
        "finrole",
        "member",
      ]),
    );
    expect(byKey.get("owner")).toMatchObject({
      systemKey: "owner",
      permissions: sorted(ROLES.owner),
      archivedAt: null,
    });
    expect(byKey.get("project_manager")?.permissions).toEqual(
      sorted(ROLES.project_manager),
    );
    expect(byKey.get("member")).toMatchObject({
      systemKey: null,
      permissions: [],
    });
    expect(items.map((r) => r.id)).toEqual(
      [...items.map((r) => r.id)].sort().reverse(),
    );
    expect(Object.keys(items[0] ?? {}).sort()).toEqual([
      "archivedAt",
      "createdAt",
      "id",
      "key",
      "name",
      "permissions",
      "systemKey",
      "updatedAt",
    ]);
  });

  test("an auditor reads; a project manager (no org.role.read.org) is 403; no token is 401", async () => {
    expect((await listAs(users.auditor)).length).toBeGreaterThan(0);
    expectProblem(await call(users.manager, "GET", ROUTE), 403, "forbidden");
    expectProblem(await call(undefined, "GET", ROUTE), 401, "unauthenticated");
  });

  test("GET one: the same shape; unknown, another org's, or a malformed id", async () => {
    const res = await call(
      users.owner,
      "GET",
      `${ROUTE}/${seededId("editor")}`,
    );
    expect(roleOf(res)).toMatchObject({
      id: seededId("editor"),
      key: "editor",
    });
    expectProblem(
      await call(users.owner, "GET", `${ROUTE}/${seedId()}`),
      404,
      "not_found",
    );
    expectProblem(
      await call(
        users.ownerB,
        "GET",
        `${ROUTE}/${seededId("editor")}`,
        undefined,
        { org: ORG_B },
      ),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.owner, "GET", `${ROUTE}/nope`),
      422,
      "validation_failed",
    );
  });
});

describe("POST /v1/roles (org.role.manage.org, @Idempotent)", () => {
  test("201: the role with its keys; one roles row, one open row per key, one org.role.create audit event with after; a replay is byte-equal", async () => {
    const key = newKey();
    const body = {
      key: "site_lead",
      name: "Site lead",
      permissions: ["project.milestone.read.project", "org.role.read.org"],
    };
    const res = await call(users.owner, "POST", ROUTE, body, { key });
    expect(res.statusCode, res.body).toBe(201);
    const role = Role.schema.parse(JSON.parse(res.body));
    expect(role).toMatchObject({
      key: "site_lead",
      name: "Site lead",
      systemKey: null,
      permissions: sorted(body.permissions),
      archivedAt: null,
    });
    expect(role.createdAt).toBe(role.updatedAt);
    expect(await permissionRows(role.id)).toEqual(
      sorted(body.permissions).map((permission) => ({
        permission,
        revoked: false,
      })),
    );
    expect(await auditOf(role.id)).toEqual([
      {
        action: "org.role.create",
        entity_type: "org.role",
        actor_id: users.owner,
        before: null,
        after: {
          key: "site_lead",
          name: "Site lead",
          permissions: sorted(body.permissions),
        },
      },
    ]);
    const replay = await call(users.owner, "POST", ROUTE, body, { key });
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toBe(res.body);
    expect(replay.headers[REPLAYED_HEADER]).toBe("true");
    expect(await auditOf(role.id)).toHaveLength(1);
  });

  test("the same key again: 409 request.conflict, no row; without an Idempotency-Key 400; an invalid body 422", async () => {
    const before = await asAdmin("SELECT count(*)::int AS n FROM bricx.roles");
    expectProblem(
      await call(users.owner, "POST", ROUTE, {
        key: "editor",
        name: "Again",
        permissions: [],
      }),
      409,
      "request.conflict",
    );
    expectProblem(
      await call(
        users.owner,
        "POST",
        ROUTE,
        { key: "x", name: "X", permissions: [] },
        { key: null },
      ),
      400,
      "idempotency.key_missing",
    );
    expectProblem(
      await call(users.owner, "POST", ROUTE, {
        key: "Bad-Key",
        name: "X",
        permissions: [],
      }),
      422,
      "validation_failed",
    );
    expect(await asAdmin("SELECT count(*)::int AS n FROM bricx.roles")).toEqual(
      before,
    );
  });

  test("an auditor (read only) and a project manager are 403; nothing written", async () => {
    for (const user of [users.auditor, users.manager]) {
      expectProblem(
        await call(user, "POST", ROUTE, {
          key: "nope",
          name: "Nope",
          permissions: [],
        }),
        403,
        "forbidden",
      );
    }
    expect(
      await asAdmin("SELECT 1 FROM bricx.roles WHERE key = 'nope'"),
    ).toEqual([]);
  });

  test("escalation (3.2): the editor grants what they hold at org scope and is refused for anything else, with one grants.escalation line naming the first refused key", async () => {
    const ok = await call(users.editor, "POST", ROUTE, {
      key: "readers",
      name: "Readers",
      permissions: [
        "project.milestone.read.project",
        "project.milestone.update.org",
      ],
    });
    expect(ok.statusCode, ok.body).toBe(201);
    lines.length = 0;
    const refused = await call(users.editor, "POST", ROUTE, {
      key: "creators",
      name: "Creators",
      permissions: [
        "project.milestone.read.project",
        "project.milestone.create.project",
        "org.member.read.org",
      ],
    });
    expectProblem(refused, 403, "forbidden");
    expect(
      await asAdmin("SELECT 1 FROM bricx.roles WHERE key = 'creators'"),
    ).toEqual([]);
    const escalation = logged().filter((l) => l.msg === "grants.escalation");
    expect(escalation).toHaveLength(1);
    expect(escalation[0]).toMatchObject({
      userId: users.editor,
      orgId: ORG_A,
      key: "project.milestone.create.project",
    });
  });
});

describe("PATCH /v1/roles/:id", () => {
  test("a new name: 200, updated_at moves, one org.role.update event with before and after", async () => {
    const created = roleOf(
      await call(users.owner, "POST", ROUTE, {
        key: "renamed",
        name: "Old",
        permissions: ["org.role.read.org"],
      }),
    );
    const res = await call(users.owner, "PATCH", `${ROUTE}/${created.id}`, {
      name: "New",
    });
    const role = roleOf(res);
    expect(role).toMatchObject({
      name: "New",
      key: "renamed",
      permissions: ["org.role.read.org"],
    });
    expect(role.updatedAt > role.createdAt).toBe(true);
    expect((await auditOf(created.id)).at(-1)).toEqual({
      action: "org.role.update",
      entity_type: "org.role",
      actor_id: users.owner,
      before: {
        key: "renamed",
        name: "Old",
        permissions: ["org.role.read.org"],
      },
      after: {
        key: "renamed",
        name: "New",
        permissions: ["org.role.read.org"],
      },
    });
  });

  test("new permissions: removed keys are revoked rows (kept), added keys new open rows; the effective bundle is the open rows", async () => {
    const created = roleOf(
      await call(users.owner, "POST", ROUTE, {
        key: "shifting",
        name: "Shifting",
        permissions: ["org.role.read.org", "org.member.read.org"],
      }),
    );
    const role = roleOf(
      await call(users.owner, "PATCH", `${ROUTE}/${created.id}`, {
        permissions: ["org.member.read.org", "org.audit.read.org"],
      }),
    );
    expect(role.permissions).toEqual([
      "org.audit.read.org",
      "org.member.read.org",
    ]);
    expect(await permissionRows(created.id)).toEqual([
      { permission: "org.audit.read.org", revoked: false },
      { permission: "org.member.read.org", revoked: false },
      { permission: "org.role.read.org", revoked: true },
    ]);
    expect((await auditOf(created.id)).at(-1)).toMatchObject({
      action: "org.role.update",
      before: { permissions: ["org.member.read.org", "org.role.read.org"] },
      after: { permissions: ["org.audit.read.org", "org.member.read.org"] },
    });
    // Granting a revoked key again: a new open row beside the revoked one.
    const again = roleOf(
      await call(users.owner, "PATCH", `${ROUTE}/${created.id}`, {
        permissions: [
          "org.member.read.org",
          "org.audit.read.org",
          "org.role.read.org",
        ],
      }),
    );
    expect(again.permissions).toHaveLength(3);
    expect(
      (await permissionRows(created.id)).filter(
        (r) => r.permission === "org.role.read.org",
      ),
    ).toEqual([
      { permission: "org.role.read.org", revoked: true },
      { permission: "org.role.read.org", revoked: false },
    ]);
  });

  test("escalation on an edit: adding a key the editor does not hold is 403 and writes nothing; removing one they do not hold is allowed", async () => {
    const created = roleOf(
      await call(users.owner, "POST", ROUTE, {
        key: "edited_by_editor",
        name: "Edited",
        permissions: ["org.member.read.org", "project.milestone.read.project"],
      }),
    );
    expectProblem(
      await call(users.editor, "PATCH", `${ROUTE}/${created.id}`, {
        permissions: [
          "org.member.read.org",
          "project.milestone.read.project",
          "project.milestone.create.project",
        ],
      }),
      403,
      "forbidden",
    );
    expect(await auditOf(created.id)).toHaveLength(1);
    const role = roleOf(
      await call(users.editor, "PATCH", `${ROUTE}/${created.id}`, {
        permissions: ["project.milestone.read.project"],
      }),
    );
    expect(role.permissions).toEqual(["project.milestone.read.project"]);
  });

  test("the owner role is 409 for any change; a copied system role is editable and keeps its system_key", async () => {
    expectProblem(
      await call(users.owner, "PATCH", `${ROUTE}/${seededId("owner")}`, {
        name: "Boss",
      }),
      409,
      "request.conflict",
    );
    expect(await auditOf(seededId("owner"))).toEqual([]);
    const role = roleOf(
      await call(
        users.owner,
        "PATCH",
        `${ROUTE}/${seededId("project_manager")}`,
        {
          permissions: [...ROLES.project_manager, "org.member.read.org"],
        },
      ),
    );
    expect(role).toMatchObject({ systemKey: "project_manager" });
    expect(role.permissions).toContain("org.member.read.org");
  });

  test("an edit that moves a finance.* key enqueues one users.mfa_check per member of the role (org and project, distinct); other edits enqueue nothing (D5, owner condition 7)", async () => {
    expect(await mfaChecks()).toEqual([]);
    roleOf(
      await call(users.owner, "PATCH", `${ROUTE}/${seededId("finrole")}`, {
        name: "Finance role",
      }),
    );
    roleOf(
      await call(users.owner, "PATCH", `${ROUTE}/${seededId("finrole")}`, {
        permissions: [FINANCE_KEY, "org.member.read.org"],
      }),
    );
    expect(await mfaChecks()).toEqual([]);
    roleOf(
      await call(users.owner, "PATCH", `${ROUTE}/${seededId("finrole")}`, {
        permissions: ["org.member.read.org"],
      }),
    );
    const checks = await mfaChecks();
    expect(checks.map((c) => c.user_id).sort()).toEqual(
      [users.member1, users.member2].sort(),
    );
    expect(checks.every((c) => c.org_id === ORG_A)).toBe(true);
    roleOf(
      await call(users.owner, "PATCH", `${ROUTE}/${seededId("finrole")}`, {
        permissions: ["org.member.read.org", FINANCE_KEY],
      }),
    );
    expect(await mfaChecks()).toHaveLength(4);
  });

  test("another org's role, an unknown id, and an empty body", async () => {
    expectProblem(
      await call(
        users.ownerB,
        "PATCH",
        `${ROUTE}/${seededId("editor")}`,
        { name: "Mine" },
        { org: ORG_B },
      ),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.owner, "PATCH", `${ROUTE}/${seedId()}`, { name: "X" }),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.owner, "PATCH", `${ROUTE}/${seededId("editor")}`, {}),
      422,
      "validation_failed",
    );
    expectProblem(
      await call(users.auditor, "PATCH", `${ROUTE}/${seededId("editor")}`, {
        name: "X",
      }),
      403,
      "forbidden",
    );
  });
});

describe("POST /v1/roles/:id/archive", () => {
  test("an unused role: 200 with archivedAt, gone from the list and GET, one org.role.archive event; again is 404", async () => {
    const created = roleOf(
      await call(users.owner, "POST", ROUTE, {
        key: "temp",
        name: "Temp",
        permissions: ["org.role.read.org"],
      }),
    );
    const res = await call(
      users.owner,
      "POST",
      `${ROUTE}/${created.id}/archive`,
    );
    const role = roleOf(res);
    expect(role.archivedAt).not.toBeNull();
    expect((await listAs(users.owner)).map((r) => r.id)).not.toContain(
      created.id,
    );
    expectProblem(
      await call(users.owner, "GET", `${ROUTE}/${created.id}`),
      404,
      "not_found",
    );
    expect((await auditOf(created.id)).at(-1)).toMatchObject({
      action: "org.role.archive",
      before: { key: "temp", name: "Temp", permissions: ["org.role.read.org"] },
      after: null,
    });
    expectProblem(
      await call(users.owner, "POST", `${ROUTE}/${created.id}/archive`),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.owner, "PATCH", `${ROUTE}/${created.id}`, { name: "X" }),
      404,
      "not_found",
    );
  });

  test("a role with an open membership or project membership is 409; the owner role is 409; an auditor is 403", async () => {
    expectProblem(
      await call(
        users.owner,
        "POST",
        `${ROUTE}/${seededId("finrole")}/archive`,
      ),
      409,
      "request.conflict",
    );
    expectProblem(
      await call(users.owner, "POST", `${ROUTE}/${seededId("owner")}/archive`),
      409,
      "request.conflict",
    );
    expectProblem(
      await call(
        users.auditor,
        "POST",
        `${ROUTE}/${seededId("editor")}/archive`,
      ),
      403,
      "forbidden",
    );
    expect(
      await asAdmin(
        "SELECT 1 FROM bricx.roles WHERE id = ANY($1::uuid[]) AND archived_at IS NOT NULL",
        [`{${seededId("finrole")},${seededId("owner")},${seededId("editor")}}`],
      ),
    ).toEqual([]);
  });
});

describe("cross-org (6.1)", () => {
  test("org B's owner sees B's roles only and cannot reach A's", async () => {
    const inB = await listAs(users.ownerB, ORG_B);
    expect(inB.map((r) => r.key)).toEqual(["owner"]);
    expect(inB.map((r) => r.id)).not.toContain(seededId("owner"));
    expectProblem(
      await call(
        users.ownerB,
        "POST",
        `${ROUTE}/${seededId("editor")}/archive`,
        undefined,
        { org: ORG_B },
      ),
      404,
      "not_found",
    );
  });
});
