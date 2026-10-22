// The memberships module end to end (P5-05, ADR 0066; plan 3.2, 3.3,
// 3.5, 3.6, 6.1, 6.2; Done-when DW3, DW4, DW6, DW8; owner conditions 1,
// 3, 7), against compose.yml's Postgres with the production journal,
// through the real app with the production grants source (seeded rows,
// test/support applyAccess). Org memberships: org.member.read/invite/
// update/remove.org; project memberships: project.member.read/assign at
// org or that project; GET /v1/me/memberships needs no grant. An editor
// grants only keys they hold (escalation, 403) and touches a member only
// when they hold every key of that member's current role (target
// protection, condition 3). The last owner stays (409). Removing an org
// membership closes the user's project memberships and sessions in that
// org (401 at once, 200 elsewhere). Every change is one audit event in
// the org chain and one users.mfa_check outbox row for the member; the
// response says whether the member now needs MFA (requiresMfa over the
// API's own org-scoped reads, condition 1).
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { ROLE_IDS, ROLES } from "@bricx/permissions/roles";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  REPLAYED_HEADER,
} from "../../src/common/idempotency/decorator.js";
import {
  Member,
  MemberList,
  MyMembershipList,
  ProjectMember,
  ProjectMemberList,
} from "../../src/modules/memberships/memberships.dto.js";
import { apiEnv } from "../env.js";
import { fakeProbes } from "../probes.js";
import {
  TestIssuer,
  applyAccess,
  bearer,
  fixedRevocations,
  seedId,
  seedRole,
  seedUsers,
} from "../support/auth.js";

const HOOK_MS = 300_000;
const ORG_A = "0199e1a0-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1a0-0000-7000-8000-0000000000b1";
const P1 = "0199e1a0-0000-7000-8000-0000000000a3";
const P2 = "0199e1a0-0000-7000-8000-0000000000a4";
const users = {
  owner: "0199e1a0-0000-7000-8000-0000000000f1",
  owner2: "0199e1a0-0000-7000-8000-0000000000f2",
  admin: "0199e1a0-0000-7000-8000-0000000000f3",
  auditor: "0199e1a0-0000-7000-8000-0000000000f4",
  manager: "0199e1a0-0000-7000-8000-0000000000f5",
  ownerB: "0199e1a0-0000-7000-8000-0000000000f6",
  t1: "0199e1a0-0000-7000-8000-0000000000f7",
  t2: "0199e1a0-0000-7000-8000-0000000000f8",
  t3: "0199e1a0-0000-7000-8000-0000000000f9",
  t4: "0199e1a0-0000-7000-8000-0000000000fa",
  t5: "0199e1a0-0000-7000-8000-0000000000fb",
  both: "0199e1a0-0000-7000-8000-0000000000fc",
} as const;
const subOf = (user: string) => `members-${user}`;
const MEMBERS = "/v1/members";
const projectMembers = (project: string) => `/v1/projects/${project}/members`;
const ME = "/v1/me/memberships";
const MILESTONE_READ = "project.milestone.read.project";
const MILESTONE_CREATE = "project.milestone.create.project";
/** A finance key the project_manager bundle does not hold. */
const BUDGET_APPROVE = "finance.budget.approve.project";

let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
let app: NestFastifyApplication;
const lines: string[] = [];
/** The seeded roles' ids by key (org A). */
const seeded: Record<string, string> = {};
const roleId = (key: string): string => {
  const id = seeded[key];
  if (id === undefined) throw new Error(`no seeded role ${key}`);
  return id;
};

let keyCounter = 0;
const newKey = () => {
  keyCounter += 1;
  return `members-key-${String(keyCounter)}`;
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

const grantKeys = async (role: string, keys: readonly string[]) => {
  for (const permission of keys) {
    await asAdmin(
      `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
      [seedId(), ORG_A, role, permission],
    );
  }
};

beforeAll(async () => {
  [pg18, issuer] = await Promise.all([startPostgres(), TestIssuer.start()]);
  await migrate({
    reveal: () => urlFor("bricx_owner", "BRICX_OWNER_PASSWORD"),
  });
  await seedUsers(
    asAdmin,
    Object.values(users).map((id) => ({ id, sub: subOf(id) })),
  );
  for (const user of [users.owner, users.owner2]) {
    await applyAccess(asAdmin, { orgId: ORG_A, userId: user, role: "owner" });
  }
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.auditor,
    role: "auditor",
  });
  await applyAccess(asAdmin, {
    orgId: ORG_B,
    userId: users.ownerB,
    role: "owner",
  });
  // The member admin: every org.member.* and project.member.* key at org
  // scope, milestone reads org-wide, no finance key, no role management.
  const admin = await seedRole(asAdmin, ORG_A, "memberadmin");
  await grantKeys(admin, [
    "org.member.read.org",
    "org.member.invite.org",
    "org.member.update.org",
    "org.member.remove.org",
    "project.member.read.org",
    "project.member.assign.org",
    "project.milestone.read.org",
    "project.milestone.create.org",
  ]);
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.admin,
    role: "memberadmin",
  });
  // The project manager: project_manager on P1 only (project.member.assign.project there).
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.manager,
    role: "member",
    projects: [],
  });
  await asAdmin(
    `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute')`,
    [
      seedId(),
      ORG_A,
      P1,
      users.manager,
      await seedRole(asAdmin, ORG_A, "project_manager"),
    ],
  );
  // viewer: milestone reads only (held by the admin); finrole: one finance key (not held by the admin).
  await grantKeys(await seedRole(asAdmin, ORG_A, "viewer"), [MILESTONE_READ]);
  await grantKeys(await seedRole(asAdmin, ORG_A, "finrole"), [BUDGET_APPROVE]);
  // t1, t2: members (empty role); both: member of A and owner of B.
  for (const user of [users.t1, users.t2, users.both]) {
    await applyAccess(asAdmin, { orgId: ORG_A, userId: user, role: "member" });
  }
  await applyAccess(asAdmin, {
    orgId: ORG_B,
    userId: users.both,
    role: "owner",
  });
  for (const key of [
    "owner",
    "auditor",
    "memberadmin",
    "project_manager",
    "viewer",
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
  method: "GET" | "POST" | "PATCH" | "DELETE",
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

const memberOf = (res: Res, status = 200) => {
  expect(res.statusCode, res.body).toBe(status);
  return Member.schema.parse(JSON.parse(res.body));
};
const projectMemberOf = (res: Res, status = 200) => {
  expect(res.statusCode, res.body).toBe(status);
  return ProjectMember.schema.parse(JSON.parse(res.body));
};

async function membersAs(user: string, org = ORG_A) {
  const res = await call(user, "GET", MEMBERS, undefined, { org });
  expect(res.statusCode, res.body).toBe(200);
  return MemberList.schema.parse(JSON.parse(res.body)).items;
}
async function projectMembersAs(user: string, project: string) {
  const res = await call(user, "GET", projectMembers(project));
  expect(res.statusCode, res.body).toBe(200);
  return ProjectMemberList.schema.parse(JSON.parse(res.body)).items;
}

interface AuditRow extends Record<string, unknown> {
  action: string;
  entity_type: string;
  actor_id: string;
  org_id: string;
  before: unknown;
  after: unknown;
}
const auditOf = (entityId: string) =>
  asAdmin<AuditRow>(
    `SELECT action, entity_type, actor_id::text, org_id::text, before, after
     FROM bricx.audit_events WHERE entity_id = $1 ORDER BY seq`,
    [entityId],
  );
const auditCount = (orgId: string) =>
  asAdmin<{ n: number }>(
    "SELECT count(*)::int AS n FROM bricx.audit_events WHERE org_id = $1",
    [orgId],
  ).then((rows) => rows[0]?.n);

const mfaChecks = (userId: string) =>
  asAdmin<{ org_id: string }>(
    `SELECT org_id::text FROM bricx.outbox WHERE topic = 'users.mfa_check' AND payload->>'userId' = $1 ORDER BY id`,
    [userId],
  );

interface MembershipDb extends Record<string, unknown> {
  id: string;
  role_id: string;
  removed: boolean;
}
const orgRows = (userId: string) =>
  asAdmin<MembershipDb>(
    `SELECT id::text, role_id::text, (removed_at IS NOT NULL) AS removed
     FROM bricx.memberships WHERE org_id = $1 AND user_id = $2 ORDER BY id`,
    [ORG_A, userId],
  );
const projectRows = (userId: string) =>
  asAdmin<MembershipDb & { project_id: string }>(
    `SELECT id::text, project_id::text, role_id::text, (removed_at IS NOT NULL) AS removed
     FROM bricx.project_memberships WHERE org_id = $1 AND user_id = $2 ORDER BY id`,
    [ORG_A, userId],
  );

const logged = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe("GET /v1/members (org.member.read.org)", () => {
  test("the owner lists the org's open memberships, newest first, each with its role and whether MFA is required; an auditor reads; a project manager is 403; no token is 401", async () => {
    const items = await membersAs(users.owner);
    const byUser = new Map(items.map((m) => [m.userId, m]));
    expect(byUser.get(users.owner)).toMatchObject({
      roleId: roleId("owner"),
      removedAt: null,
      mfaRequired: true,
    });
    // The auditor bundle reads finance.* org-wide: MFA required (D5).
    expect(byUser.get(users.auditor)).toMatchObject({
      roleId: roleId("auditor"),
      mfaRequired: true,
    });
    expect(byUser.get(users.t1)).toMatchObject({
      roleId: roleId("member"),
      mfaRequired: false,
    });
    expect(byUser.has(users.ownerB)).toBe(false);
    expect(items.map((m) => m.id)).toEqual(
      [...items.map((m) => m.id)].sort().reverse(),
    );
    expect(Object.keys(items[0] ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "mfaRequired",
      "removedAt",
      "roleId",
      "userId",
    ]);
    expect((await membersAs(users.auditor)).length).toBe(items.length);
    expectProblem(await call(users.manager, "GET", MEMBERS), 403, "forbidden");
    expectProblem(
      await call(undefined, "GET", MEMBERS),
      401,
      "unauthenticated",
    );
  });
});

describe("POST /v1/members (org.member.invite.org, @Idempotent)", () => {
  test("201: the membership; one row, one org.member.invite audit event with after, one users.mfa_check row; a replay is byte-equal; the same user again is 409", async () => {
    const key = newKey();
    const body = { userId: users.t3, roleId: roleId("viewer") };
    const res = await call(users.admin, "POST", MEMBERS, body, { key });
    const member = memberOf(res, 201);
    expect(member).toMatchObject({
      userId: users.t3,
      roleId: roleId("viewer"),
      removedAt: null,
      mfaRequired: false,
    });
    expect(await orgRows(users.t3)).toEqual([
      { id: member.id, role_id: roleId("viewer"), removed: false },
    ]);
    expect(await auditOf(member.id)).toEqual([
      {
        action: "org.member.invite",
        entity_type: "org.member",
        actor_id: users.admin,
        org_id: ORG_A,
        before: null,
        after: { userId: users.t3, roleId: roleId("viewer") },
      },
    ]);
    expect(await mfaChecks(users.t3)).toEqual([{ org_id: ORG_A }]);
    const replay = await call(users.admin, "POST", MEMBERS, body, { key });
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toBe(res.body);
    expect(replay.headers[REPLAYED_HEADER]).toBe("true");
    expectProblem(
      await call(users.admin, "POST", MEMBERS, body),
      409,
      "request.conflict",
    );
    expect(await orgRows(users.t3)).toHaveLength(1);
  });

  test("the member then has exactly the role's keys in that org, and no access in another", async () => {
    const mine = await call(users.t3, "GET", ME);
    expect(mine.statusCode, mine.body).toBe(200);
    expect(MyMembershipList.schema.parse(JSON.parse(mine.body)).items).toEqual([
      expect.objectContaining({
        orgId: ORG_A,
        roleId: roleId("viewer"),
        projectIds: [],
      }),
    ]);
    expectProblem(await call(users.t3, "GET", MEMBERS), 403, "forbidden");
    expectProblem(
      await call(users.t3, "GET", ME, undefined, { org: ORG_B }),
      403,
      "forbidden",
    );
  });

  test("escalation: a role with a key the editor does not hold is 403 with one grants.escalation line naming it; nothing written (s4)", async () => {
    lines.length = 0;
    expectProblem(
      await call(users.admin, "POST", MEMBERS, {
        userId: users.t4,
        roleId: roleId("finrole"),
      }),
      403,
      "forbidden",
    );
    expectProblem(
      await call(users.admin, "POST", MEMBERS, {
        userId: users.t4,
        roleId: roleId("owner"),
      }),
      403,
      "forbidden",
    );
    expect(await orgRows(users.t4)).toEqual([]);
    const escalations = logged().filter(
      (l) => l["msg"] === "grants.escalation",
    );
    expect(escalations.map((l) => l["key"])).toEqual([
      BUDGET_APPROVE,
      expect.any(String),
    ]);
    expect(escalations[0]).toMatchObject({ userId: users.admin, orgId: ORG_A });
    // The owner holds everything: the finance role lands, with MFA required.
    const res = await call(users.owner, "POST", MEMBERS, {
      userId: users.t4,
      roleId: roleId("finrole"),
    });
    expect(memberOf(res, 201).mfaRequired).toBe(true);
  });

  test("an unknown user or role is 404; a role of another org is 404; an auditor is 403; an invalid body 422; no Idempotency-Key 400", async () => {
    expectProblem(
      await call(users.owner, "POST", MEMBERS, {
        userId: seedId(),
        roleId: roleId("viewer"),
      }),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.owner, "POST", MEMBERS, {
        userId: users.t5,
        roleId: seedId(),
      }),
      404,
      "not_found",
    );
    const roleB = await seedRole(asAdmin, ORG_B, "viewer");
    expectProblem(
      await call(users.owner, "POST", MEMBERS, {
        userId: users.t5,
        roleId: roleB,
      }),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.auditor, "POST", MEMBERS, {
        userId: users.t5,
        roleId: roleId("viewer"),
      }),
      403,
      "forbidden",
    );
    expectProblem(
      await call(users.owner, "POST", MEMBERS, {
        userId: "nope",
        roleId: roleId("viewer"),
      }),
      422,
      "validation_failed",
    );
    expectProblem(
      await call(
        users.owner,
        "POST",
        MEMBERS,
        { userId: users.t5, roleId: roleId("viewer") },
        { key: null },
      ),
      400,
      "idempotency.key_missing",
    );
    expect(await orgRows(users.t5)).toEqual([]);
  });
});

describe("PATCH /v1/members/:id (org.member.update.org)", () => {
  test("a role change: the row, one org.member.update audit event with before and after, one users.mfa_check row; the member's next request has the new keys", async () => {
    const [row] = await orgRows(users.t1);
    expect(row?.removed).toBe(false);
    const id = row?.id ?? "";
    const res = await call(users.admin, "PATCH", `${MEMBERS}/${id}`, {
      roleId: roleId("viewer"),
    });
    expect(memberOf(res)).toMatchObject({
      id,
      userId: users.t1,
      roleId: roleId("viewer"),
    });
    expect(await auditOf(id)).toEqual([
      expect.objectContaining({
        action: "org.member.update",
        actor_id: users.admin,
        before: { userId: users.t1, roleId: roleId("member") },
        after: { userId: users.t1, roleId: roleId("viewer") },
      }),
    ]);
    expect(await mfaChecks(users.t1)).toEqual([{ org_id: ORG_A }]);
    // The same role again changes nothing: no second event.
    const same = await call(users.admin, "PATCH", `${MEMBERS}/${id}`, {
      roleId: roleId("viewer"),
    });
    expect(memberOf(same).roleId).toBe(roleId("viewer"));
    expect(await auditOf(id)).toHaveLength(1);
  });

  test("target protection (condition 3): an editor who does not hold every key of the member's current role cannot change it, even to a role they hold; escalation applies to the new role", async () => {
    const [row] = await orgRows(users.t4); // t4 holds finrole (finance)
    const id = row?.id ?? "";
    expectProblem(
      await call(users.admin, "PATCH", `${MEMBERS}/${id}`, {
        roleId: roleId("viewer"),
      }),
      403,
      "forbidden",
    );
    expect((await orgRows(users.t4))[0]?.role_id).toBe(roleId("finrole"));
    const [t1] = await orgRows(users.t1);
    expectProblem(
      await call(users.admin, "PATCH", `${MEMBERS}/${t1?.id ?? ""}`, {
        roleId: roleId("finrole"),
      }),
      403,
      "forbidden",
    );
    expect((await orgRows(users.t1))[0]?.role_id).toBe(roleId("viewer"));
  });

  test("the last owner cannot be demoted (409); with two owners one can; an unknown or another org's membership is 404; an auditor is 403; an empty body 422", async () => {
    const [owner2] = await orgRows(users.owner2);
    const demoted = await call(
      users.owner,
      "PATCH",
      `${MEMBERS}/${owner2?.id ?? ""}`,
      {
        roleId: roleId("viewer"),
      },
    );
    expect(memberOf(demoted).roleId).toBe(roleId("viewer"));
    const [owner] = await orgRows(users.owner);
    expectProblem(
      await call(users.owner, "PATCH", `${MEMBERS}/${owner?.id ?? ""}`, {
        roleId: roleId("viewer"),
      }),
      409,
      "request.conflict",
    );
    expect((await orgRows(users.owner))[0]?.role_id).toBe(roleId("owner"));
    // Back to two owners for the removal tests.
    const restored = await call(
      users.owner,
      "PATCH",
      `${MEMBERS}/${owner2?.id ?? ""}`,
      {
        roleId: roleId("owner"),
      },
    );
    expect(memberOf(restored).roleId).toBe(roleId("owner"));
    expectProblem(
      await call(users.owner, "PATCH", `${MEMBERS}/${seedId()}`, {
        roleId: roleId("viewer"),
      }),
      404,
      "not_found",
    );
    expectProblem(
      await call(
        users.ownerB,
        "PATCH",
        `${MEMBERS}/${owner?.id ?? ""}`,
        { roleId: roleId("viewer") },
        { org: ORG_B },
      ),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.auditor, "PATCH", `${MEMBERS}/${owner?.id ?? ""}`, {
        roleId: roleId("viewer"),
      }),
      403,
      "forbidden",
    );
    expectProblem(
      await call(users.owner, "PATCH", `${MEMBERS}/${owner?.id ?? ""}`, {}),
      422,
      "validation_failed",
    );
  });
});

describe("project memberships (project.member.read/assign at org or that project)", () => {
  let assigned: string;

  test("POST 201: the assignment with validated overrides; the member's ability holds exactly the effective keys (DW4); audit project.member.assign; users.mfa_check", async () => {
    const res = await call(users.admin, "POST", projectMembers(P1), {
      userId: users.t1,
      roleId: roleId("viewer"),
      overrides: { add: [MILESTONE_CREATE], remove: [MILESTONE_READ] },
    });
    const member = projectMemberOf(res, 201);
    assigned = member.id;
    expect(member).toMatchObject({
      projectId: P1,
      userId: users.t1,
      roleId: roleId("viewer"),
      overrides: { add: [MILESTONE_CREATE], remove: [MILESTONE_READ] },
      removedAt: null,
      mfaRequired: false,
    });
    expect(await auditOf(member.id)).toEqual([
      expect.objectContaining({
        action: "project.member.assign",
        entity_type: "project.member",
        actor_id: users.admin,
        before: null,
        after: {
          userId: users.t1,
          projectId: P1,
          roleId: roleId("viewer"),
          overrides: { add: [MILESTONE_CREATE], remove: [MILESTONE_READ] },
        },
      }),
    ]);
    expect((await mfaChecks(users.t1)).length).toBe(2);
    const mine = await call(users.t1, "GET", ME);
    expect(MyMembershipList.schema.parse(JSON.parse(mine.body)).items).toEqual([
      expect.objectContaining({ orgId: ORG_A, projectIds: [P1] }),
    ]);
    // The project manager of P1 lists P1 (project scope) but not P2.
    const onP1 = await projectMembersAs(users.manager, P1);
    expect(onP1.map((m) => m.userId).sort()).toEqual(
      [users.manager, users.t1].sort(),
    );
    expectProblem(
      await call(users.manager, "GET", projectMembers(P2)),
      403,
      "forbidden",
    );
    expect((await projectMembersAs(users.admin, P1)).length).toBe(2);
    expectProblem(
      await call(users.t1, "GET", projectMembers(P1)),
      403,
      "forbidden",
    );
  });

  test("overrides are validated against the role's bundle: an unknown key, an org-scope key, a key already in the bundle, a remove not in the bundle, a key in both lists are 422 (DW4); an add the editor does not hold is 403 (s4); the owner role takes no overrides", async () => {
    const attempt = (overrides: unknown) =>
      call(users.admin, "POST", projectMembers(P2), {
        userId: users.t2,
        roleId: roleId("viewer"),
        overrides,
      });
    for (const overrides of [
      { add: ["nope.nope.nope.project"] },
      { add: ["org.member.read.org"] },
      { add: [MILESTONE_READ] },
      { remove: [MILESTONE_CREATE] },
      { add: [MILESTONE_CREATE], remove: [MILESTONE_CREATE] },
      { add: [MILESTONE_CREATE, MILESTONE_CREATE] },
    ]) {
      expectProblem(await attempt(overrides), 422, "validation_failed");
    }
    expectProblem(await attempt({ add: [BUDGET_APPROVE] }), 403, "forbidden");
    expectProblem(
      await call(users.owner, "POST", projectMembers(P2), {
        userId: users.t2,
        roleId: roleId("owner"),
        overrides: { add: [MILESTONE_CREATE] },
      }),
      422,
      "validation_failed",
    );
    expect(await projectRows(users.t2)).toEqual([]);
  });

  test("a project manager assigns on their project only, within what they hold; a user without an org membership is 409; the same user again on the project is 409", async () => {
    const res = await call(users.manager, "POST", projectMembers(P1), {
      userId: users.t2,
      roleId: roleId("viewer"),
    });
    expect(projectMemberOf(res, 201).userId).toBe(users.t2);
    expectProblem(
      await call(users.manager, "POST", projectMembers(P2), {
        userId: users.t2,
        roleId: roleId("viewer"),
      }),
      403,
      "forbidden",
    );
    expectProblem(
      await call(users.manager, "POST", projectMembers(P1), {
        userId: users.t2,
        roleId: roleId("finrole"),
      }),
      403,
      "forbidden",
    );
    expectProblem(
      await call(users.admin, "POST", projectMembers(P1), {
        userId: users.t5,
        roleId: roleId("viewer"),
      }),
      409,
      "request.conflict",
    );
    expectProblem(
      await call(users.admin, "POST", projectMembers(P1), {
        userId: users.t2,
        roleId: roleId("viewer"),
      }),
      409,
      "request.conflict",
    );
  });

  test("PATCH: a new role and/or overrides, audited with before and after; target protection and escalation at project scope; DELETE unassigns (204), audited, and does not close sessions", async () => {
    const res = await call(
      users.admin,
      "PATCH",
      `${projectMembers(P1)}/${assigned}`,
      {
        overrides: { add: [MILESTONE_CREATE] },
      },
    );
    expect(projectMemberOf(res).overrides).toEqual({
      add: [MILESTONE_CREATE],
      remove: [],
    });
    expect((await auditOf(assigned)).map((e) => e.action)).toEqual([
      "project.member.assign",
      "project.member.assign",
    ]);
    // Escalation: the manager cannot add a key they do not hold on P1.
    expectProblem(
      await call(users.manager, "PATCH", `${projectMembers(P1)}/${assigned}`, {
        overrides: { add: [BUDGET_APPROVE] },
      }),
      403,
      "forbidden",
    );
    // Target protection: once t1 holds finance on P1 (set by the owner), the admin cannot touch the row.
    const promoted = await call(
      users.owner,
      "PATCH",
      `${projectMembers(P1)}/${assigned}`,
      {
        roleId: roleId("finrole"),
        overrides: {},
      },
    );
    expect(projectMemberOf(promoted)).toMatchObject({
      roleId: roleId("finrole"),
      mfaRequired: true,
    });
    expectProblem(
      await call(users.admin, "PATCH", `${projectMembers(P1)}/${assigned}`, {
        roleId: roleId("viewer"),
      }),
      403,
      "forbidden",
    );
    expectProblem(
      await call(users.admin, "DELETE", `${projectMembers(P1)}/${assigned}`),
      403,
      "forbidden",
    );
    // t1 has a session in org A; the owner unassigns; the session stands.
    expect((await call(users.t1, "GET", ME)).statusCode).toBe(200);
    const gone = await call(
      users.owner,
      "DELETE",
      `${projectMembers(P1)}/${assigned}`,
    );
    expect(gone.statusCode, gone.body).toBe(204);
    expect((await projectRows(users.t1)).map((r) => r.removed)).toEqual([true]);
    const last = (await auditOf(assigned)).at(-1);
    expect(last).toMatchObject({
      action: "project.member.unassign",
      after: null,
    });
    expect(last?.before).toMatchObject({
      userId: users.t1,
      roleId: roleId("finrole"),
    });
    expect((await call(users.t1, "GET", ME)).statusCode).toBe(200);
    expectProblem(
      await call(users.owner, "DELETE", `${projectMembers(P1)}/${assigned}`),
      404,
      "not_found",
    );
  });
});

describe("DELETE /v1/members/:id (org.member.remove.org): sessions and project rows close with the membership (6.2, s9, s17)", () => {
  test("the member's open sessions in the org are closed in the same transaction (the next request there is refused at once: 403 membership_missing, the guard reading the membership before the session; 200 in another org), their project memberships are closed, one org.session.revoke then one org.member.remove audit event, one users.mfa_check row", async () => {
    // `both` is a member of A and an owner of B; give them a project row in A and a session in each org.
    const onP2 = await call(users.owner, "POST", projectMembers(P2), {
      userId: users.both,
      roleId: roleId("viewer"),
    });
    expect(onP2.statusCode, onP2.body).toBe(201);
    expect((await call(users.both, "GET", ME)).statusCode).toBe(200);
    expect(
      (await call(users.both, "GET", MEMBERS, undefined, { org: ORG_B }))
        .statusCode,
    ).toBe(200);
    const [row] = await orgRows(users.both);
    const id = row?.id ?? "";
    const before = await auditCount(ORG_B);
    const res = await call(users.admin, "DELETE", `${MEMBERS}/${id}`);
    expect(res.statusCode, res.body).toBe(204);
    expectProblem(await call(users.both, "GET", ME), 403, "forbidden");
    expect(
      logged()
        .filter((l) => l["msg"] === "auth.failed")
        .map((l) => l["reason"])
        .at(-1),
    ).toBe("membership_missing");
    const sessions = await asAdmin<{ revoked: boolean }>(
      "SELECT (revoked_at IS NOT NULL) AS revoked FROM bricx.sessions WHERE org_id = $1 AND user_id = $2",
      [ORG_A, users.both],
    );
    expect(sessions.map((s) => s.revoked)).toEqual([true]);
    expect(
      (await call(users.both, "GET", MEMBERS, undefined, { org: ORG_B }))
        .statusCode,
    ).toBe(200);
    expect(await auditCount(ORG_B)).toBe(before);
    expect((await orgRows(users.both)).map((r) => r.removed)).toEqual([true]);
    expect((await projectRows(users.both)).map((r) => r.removed)).toEqual([
      true,
    ]);
    const events = await auditOf(id);
    expect(events.map((e) => e.action)).toEqual(["org.member.remove"]);
    expect(events[0]).toMatchObject({
      actor_id: users.admin,
      before: { userId: users.both, roleId: roleId("member") },
      after: { projectMembershipsClosed: 1, sessionsClosed: 1 },
    });
    const revokes = await asAdmin<AuditRow>(
      `SELECT action, after FROM bricx.audit_events WHERE org_id = $1 AND action = 'org.session.revoke' AND after->>'userId' = $2`,
      [ORG_A, users.both],
    );
    expect(revokes).toHaveLength(1);
    expect(revokes[0]?.after).toMatchObject({
      cause: "admin",
      userId: users.both,
    });
    expect(await mfaChecks(users.both)).toEqual([
      { org_id: ORG_A },
      { org_id: ORG_A },
    ]);
    expectProblem(
      await call(users.admin, "DELETE", `${MEMBERS}/${id}`),
      404,
      "not_found",
    );
  });

  test("the last owner cannot be removed (409, s5); target protection; an auditor is 403", async () => {
    const [owner2] = await orgRows(users.owner2);
    const [owner] = await orgRows(users.owner);
    expectProblem(
      await call(users.admin, "DELETE", `${MEMBERS}/${owner2?.id ?? ""}`),
      403,
      "forbidden",
    );
    expect(
      (await call(users.owner, "DELETE", `${MEMBERS}/${owner2?.id ?? ""}`))
        .statusCode,
    ).toBe(204);
    expectProblem(
      await call(users.owner, "DELETE", `${MEMBERS}/${owner?.id ?? ""}`),
      409,
      "request.conflict",
    );
    expect((await orgRows(users.owner))[0]?.removed).toBe(false);
    expectProblem(
      await call(users.auditor, "DELETE", `${MEMBERS}/${owner?.id ?? ""}`),
      403,
      "forbidden",
    );
  });
});

describe("GET /v1/me/memberships: the caller's open org memberships in every org, with their project ids", () => {
  test("no grant needed; rows of every org; ids only", async () => {
    const res = await call(users.ownerB, "GET", ME, undefined, { org: ORG_B });
    expect(res.statusCode, res.body).toBe(200);
    const items = MyMembershipList.schema.parse(JSON.parse(res.body)).items;
    expect(items).toEqual([
      expect.objectContaining({ orgId: ORG_B, projectIds: [] }),
    ]);
    expect(Object.keys(items[0] ?? {}).sort()).toEqual([
      "createdAt",
      "id",
      "orgId",
      "projectIds",
      "roleId",
    ]);
    expect(ROLE_IDS.length).toBe(12);
    expect(ROLES.owner.length).toBeGreaterThan(0);
  });
});
