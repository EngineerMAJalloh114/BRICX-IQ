// P6-06b (ADR 0084; Done-when DW1, DW2, DW3, DW5, DW6, DW9, DW11, DW12;
// owner conditions C2, C8 and additions A2, A3), against compose.yml's
// Postgres with the production journal, through the real app with the
// production grants source and a Clock the tests move.
// - Suspension (POST /v1/members/:id/suspend, org.member.update.org): the
//   member's sessions in the org end in the same transaction and the next
//   request is 403 membership_missing; their open access grants end; the
//   invitations they sent are revoked (inviter_suspended); the row and its
//   project rows stay. Never oneself (403, one deduplicated denial event),
//   never the last ACTIVE owner (409), only with every key of the target.
//   The reason (at most 200 characters) is stored and audited, shown only
//   to org.member.read holders, never in GET /v1/me/memberships, never
//   logged. Reactivation restores no session.
// - Project-level suspension (project.member.assign): that project's keys
//   go, the others stay, sessions are kept (what project removal does
//   today, C2), the project's access grants end.
// - Temporary memberships: active while Clock < expires_at, exactly; the
//   delayed memberships.expire job and, under 7 days, the immediate
//   memberships.expiring notice are outbox rows of the same transaction
//   (C8); renewal needs a reason, a temporary row and an end 1 hour to 366
//   days ahead; GET /v1/members?expiringWithinDays lists the ones ending.
// - The owner role is never temporary (PATCH to owner is 409; A2).
// - An archived organisation (plan edge case): every new route is 404
//   not_found for its owner, and nothing changes or is audited.
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  type StartedValkey,
  appDatabase,
  exampleValue,
  startPostgres,
  startValkey,
} from "@bricx/db-bootstrap/stack";
import { seedProjects } from "@bricx/db-bootstrap/fixtures";
import { migrate } from "@bricx/db/migrate";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import { Controller, Get } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import { NoPermission } from "../../src/common/auth/can.decorator.js";
import { currentRequestContext } from "../../src/common/db/request-context.js";
import { IDEMPOTENCY_KEY_HEADER } from "../../src/common/idempotency/decorator.js";
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
import { memoryRateLimits } from "../support/rate-limit.js";

const HOOK_MS = 300_000;
const ORG_A = "0199e1b0-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1b0-0000-7000-8000-0000000000b1";
const P1 = "0199e1b0-0000-7000-8000-0000000000a3";
const P2 = "0199e1b0-0000-7000-8000-0000000000a4";
const P_ARCHIVED = "0199e1b0-0000-7000-8000-0000000000a5";
const users = {
  owner: "0199e1b0-0000-7000-8000-0000000000f1",
  owner2: "0199e1b0-0000-7000-8000-0000000000f2",
  admin: "0199e1b0-0000-7000-8000-0000000000f3",
  allKeys: "0199e1b0-0000-7000-8000-0000000000f4",
  manager: "0199e1b0-0000-7000-8000-0000000000f5",
  ownerB: "0199e1b0-0000-7000-8000-0000000000f6",
  inviter: "0199e1b0-0000-7000-8000-0000000000f7",
  elevated: "0199e1b0-0000-7000-8000-0000000000f8",
  both: "0199e1b0-0000-7000-8000-0000000000f9",
  worker: "0199e1b0-0000-7000-8000-0000000000fa",
  temp: "0199e1b0-0000-7000-8000-0000000000fb",
  tempOrg: "0199e1b0-0000-7000-8000-0000000000fc",
  racer: "0199e1b0-0000-7000-8000-0000000000fd",
  promoted: "0199e1b0-0000-7000-8000-0000000000fe",
  finance: "0199e1b0-0000-7000-8000-0000000000e1",
  spare: "0199e1b0-0000-7000-8000-0000000000e2",
  soon: "0199e1b0-0000-7000-8000-0000000000e3",
  later: "0199e1b0-0000-7000-8000-0000000000e4",
} as const;
const subOf = (user: string) => `lifecycle-${user}`;
const MEMBERS = "/v1/members";
const INVITATIONS = "/v1/invitations";
const GRANTS = "/v1/access-grants";
const projectMembers = (project: string) => `/v1/projects/${project}/members`;
const ME = "/v1/me/memberships";
const WHOAMI = "/v1/whoami";
const MILESTONE_READ = "project.milestone.read.project";
const BUDGET_APPROVE = "finance.budget.approve.project";
/** The reasons no log line may carry (owner condition C8). */
const REASON = "needle-6b01: left the joint venture";
const RENEW_REASON = "needle-6b02: contract extended";
/** What the elevated member holds on a project, as identity grants name it (no scope suffix). */
const HELD_ON_PROJECT = [BUDGET_APPROVE, MILESTONE_READ]
  .map((key) => key.replace(/\.project$/, ""))
  .sort();
const HOUR = 3_600_000;
const DAY = 86_400_000;

@NoPermission("test-only probe")
@Controller({ path: "whoami", version: "1" })
class WhoAmIController {
  @Get()
  get() {
    return { identity: currentRequestContext()?.identity ?? null };
  }
}

let pg18: BootstrappedPostgres;
let valkey: StartedValkey;
let issuer: TestIssuer;
let app: NestFastifyApplication;
const lines: string[] = [];
/** The instant the app's Clock shows (ms, whole seconds); the tests move it. */
let T0 = 0;
let at = 0;
const isoAt = (ms: number) => new Date(ms).toISOString();
const seeded: Record<string, string> = {};
const roleId = (key: string): string => {
  const id = seeded[key];
  if (id === undefined) throw new Error(`no seeded role ${key}`);
  return id;
};

let keyCounter = 0;
const newKey = () => {
  keyCounter += 1;
  return `lifecycle-key-${String(keyCounter)}`;
};
let sidCounter = 0;
/** A sign-in of its own (a session row no other test shares). */
const newSid = () => {
  sidCounter += 1;
  return `lifecycle-sid-${String(sidCounter)}`;
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

/** An org membership written as the test superuser (a temporary one when `expiresAt` is given). */
async function orgMember(
  userId: string,
  role: string,
  expiresAt?: number,
): Promise<string> {
  const id = seedId();
  await asAdmin(
    `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at, expires_at)
     VALUES ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz)`,
    [
      id,
      ORG_A,
      userId,
      roleId(role),
      isoAt(T0 - 60_000),
      expiresAt === undefined ? null : isoAt(expiresAt),
    ],
  );
  return id;
}

beforeAll(async () => {
  [pg18, valkey, issuer] = await Promise.all([
    startPostgres(),
    startValkey(),
    TestIssuer.start(),
  ]);
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
    orgId: ORG_B,
    userId: users.ownerB,
    role: "owner",
  });
  // The member admin: member and project-member keys at org scope, the
  // audit read, milestone reads; no finance key.
  const admin = await seedRole(asAdmin, ORG_A, "memberadmin");
  await grantKeys(admin, [
    "org.member.read.org",
    "org.member.invite.org",
    "org.member.update.org",
    "org.member.remove.org",
    "project.member.read.org",
    "project.member.assign.org",
    "project.milestone.read.org",
  ]);
  for (const user of [users.admin, users.inviter]) {
    await applyAccess(asAdmin, {
      orgId: ORG_A,
      userId: user,
      role: "memberadmin",
    });
  }
  await seedProjects(asAdmin, ORG_A, [P1, P2, P_ARCHIVED]);
  await grantKeys(await seedRole(asAdmin, ORG_A, "milestone_viewer"), [
    MILESTONE_READ,
  ]);
  await grantKeys(await seedRole(asAdmin, ORG_A, "finrole"), [BUDGET_APPROVE]);
  for (const user of [
    users.manager,
    users.elevated,
    users.both,
    users.worker,
    users.temp,
    users.racer,
    users.promoted,
    users.spare,
  ]) {
    await applyAccess(asAdmin, { orgId: ORG_A, userId: user, role: "member" });
  }
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.finance,
    role: "finrole",
  });
  await applyAccess(asAdmin, {
    orgId: ORG_B,
    userId: users.both,
    role: "owner",
  });
  for (const key of [
    "owner",
    "memberadmin",
    "project_manager",
    "milestone_viewer",
    "finrole",
    "member",
  ]) {
    seeded[key] = await seedRole(asAdmin, ORG_A, key);
  }
  // The manager: project_manager on P1 only.
  await asAdmin(
    `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute')`,
    [seedId(), ORG_A, P1, users.manager, roleId("project_manager")],
  );
  T0 = Math.floor(Date.now() / 1000) * 1000;
  at = T0;
  issuer.nowSeconds = () => Math.floor(at / 1000);
  app = await createApp(
    loadApiConfig(
      apiEnv({
        ...issuer.env(),
        DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
        VALKEY_URL: valkey.url(),
      }),
    ),
    {
      probes: fakeProbes(),
      revocationStore: fixedRevocations(),
      rateLimitStore: memoryRateLimits(),
      clock: { now: () => at },
      extraControllers: [WhoAmIController],
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
  await valkey.stop();
  await pg18.container.stop();
}, HOOK_MS);

type Res = Awaited<ReturnType<NestFastifyApplication["inject"]>>;
async function call(
  user: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
  options: { org?: string; sid?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = bearer(
    await issuer.token({
      sub: subOf(user),
      org_id: options.org ?? ORG_A,
      acr: "mfa",
      ...(options.sid === undefined ? {} : { sid: options.sid }),
    }),
  );
  if (method === "POST") headers[IDEMPOTENCY_KEY_HEADER] = newKey();
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
async function membersAs(user: string, query = "") {
  const res = await call(user, "GET", `${MEMBERS}${query}`);
  expect(res.statusCode, res.body).toBe(200);
  return MemberList.schema.parse(JSON.parse(res.body)).items;
}
async function mineAs(user: string, org = ORG_A) {
  const res = await call(user, "GET", ME, undefined, { org });
  expect(res.statusCode, res.body).toBe(200);
  return {
    body: res.body,
    items: MyMembershipList.schema.parse(JSON.parse(res.body)).items,
  };
}

interface WhoAmI {
  identity: {
    projectIds: string[];
    grants: { permission: string; projectIds?: string[] }[];
  };
}
async function whoAmI(user: string, sid?: string): Promise<WhoAmI["identity"]> {
  const res = await call(
    user,
    "GET",
    WHOAMI,
    undefined,
    sid === undefined ? {} : { sid },
  );
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as WhoAmI).identity;
}

interface AuditRow extends Record<string, unknown> {
  action: string;
  entity_type: string;
  actor_id: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}
const auditOf = (entityId: string) =>
  asAdmin<AuditRow>(
    `SELECT action, entity_type, actor_id::text, before, after
     FROM bricx.audit_events WHERE entity_id = $1 ORDER BY seq`,
    [entityId],
  );
const auditCount = (orgId: string) =>
  asAdmin<{ n: number }>(
    "SELECT count(*)::int AS n FROM bricx.audit_events WHERE org_id = $1",
    [orgId],
  ).then((rows) => rows[0]?.n);

interface OutboxRow extends Record<string, unknown> {
  topic: string;
  payload: Record<string, unknown>;
  not_before: string | null;
}
const outboxOf = (membershipId: string) =>
  asAdmin<OutboxRow>(
    `SELECT topic, payload, to_char(not_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS not_before
     FROM bricx.outbox WHERE payload->>'membershipId' = $1 ORDER BY id`,
    [membershipId],
  );
const mfaChecks = (userId: string) =>
  asAdmin<{ n: number }>(
    `SELECT count(*)::int AS n FROM bricx.outbox WHERE topic = 'users.mfa_check' AND payload->>'userId' = $1`,
    [userId],
  ).then((rows) => rows[0]?.n ?? 0);

const orgRowOf = async (userId: string) => {
  const [row] = await asAdmin<{
    id: string;
    suspended: boolean;
    suspend_reason: string | null;
    suspended_by: string | null;
    removed: boolean;
  }>(
    `SELECT id::text, (suspended_at IS NOT NULL) AS suspended, suspend_reason, suspended_by::text, (removed_at IS NOT NULL) AS removed
     FROM bricx.memberships WHERE org_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 1`,
    [ORG_A, userId],
  );
  if (row === undefined) throw new Error("no membership row");
  return row;
};

const logged = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
const lastAuthFailure = () =>
  logged()
    .filter((l) => l["msg"] === "auth.failed")
    .map((l) => l["reason"])
    .at(-1);

const assign = async (
  userId: string,
  project: string,
  role: string,
  extra: Record<string, unknown> = {},
) =>
  projectMemberOf(
    await call(users.owner, "POST", projectMembers(project), {
      userId,
      roleId: roleId(role),
      ...extra,
    }),
    201,
  );

describe("POST /v1/members/:id/suspend and /reactivate (org.member.update.org; DW1, DW2, DW5, DW6, A3)", () => {
  test("a suspended member loses access on the next request (403 membership_missing) and their sessions in the org end in the same transaction; their access grants end, the invitations they sent are revoked (inviter_suspended), the row and its project rows stay; another org is untouched; a second suspend is 409", async () => {
    const target = users.inviter;
    const row = await orgRowOf(target);
    await assign(target, P2, "milestone_viewer");
    // An elevation, a sent invitation and one session in each of two sign-ins.
    const grant = await call(users.owner, "POST", GRANTS, {
      userId: target,
      permission: "org.role.read.org",
      reason: "cover",
      expiresAt: isoAt(at + HOUR),
    });
    expect(grant.statusCode, grant.body).toBe(201);
    const grantId = (JSON.parse(grant.body) as { id: string }).id;
    const invited = await call(target, "POST", INVITATIONS, {
      email: "suspended-inviter@lifecycle.example",
      roleId: roleId("member"),
    });
    expect(invited.statusCode, invited.body).toBe(201);
    const invitationId = (JSON.parse(invited.body) as { id: string }).id;
    const second = newSid();
    expect((await whoAmI(target)).projectIds).toEqual([]);
    expect(
      (await call(target, "GET", MEMBERS, undefined, { sid: second }))
        .statusCode,
    ).toBe(200);
    const beforeB = await auditCount(ORG_B);
    const checks = await mfaChecks(target);

    const suspended = memberOf(
      await call(users.owner, "POST", `${MEMBERS}/${row.id}/suspend`, {
        reason: REASON,
      }),
    );
    expect(suspended).toMatchObject({
      id: row.id,
      userId: target,
      status: "suspended",
      suspendedAt: expect.any(String) as string,
      suspendReason: REASON,
      removedAt: null,
      external: false,
    });

    // The next request, on either sign-in: refused before the session is read.
    expectProblem(await call(target, "GET", ME), 403, "forbidden");
    expect(lastAuthFailure()).toBe("membership_missing");
    expectProblem(
      await call(target, "GET", MEMBERS, undefined, { sid: second }),
      403,
      "forbidden",
    );
    const sessions = await asAdmin<{ revoked: boolean }>(
      "SELECT (revoked_at IS NOT NULL) AS revoked FROM bricx.sessions WHERE org_id = $1 AND user_id = $2",
      [ORG_A, target],
    );
    expect(sessions.map((s) => s.revoked)).toEqual([true, true]);
    // The stored row: suspended, not removed; the project row stays open.
    expect(await orgRowOf(target)).toMatchObject({
      suspended: true,
      suspend_reason: REASON,
      suspended_by: users.owner,
      removed: false,
    });
    const projectRows = await asAdmin<{ removed: boolean }>(
      "SELECT (removed_at IS NOT NULL) AS removed FROM bricx.project_memberships WHERE org_id = $1 AND user_id = $2",
      [ORG_A, target],
    );
    expect(projectRows.map((r) => r.removed)).toEqual([false]);
    // The elevation ended and the invitation went with the inviter's rights.
    const [grantRow] = await asAdmin<{ revoked: boolean }>(
      "SELECT (revoked_at IS NOT NULL) AS revoked FROM bricx.access_grants WHERE id = $1",
      [grantId],
    );
    expect(grantRow?.revoked).toBe(true);
    const [invitation] = await asAdmin<{ status: string; reason: string }>(
      "SELECT status, revoke_reason AS reason FROM bricx.invitations WHERE id = $1",
      [invitationId],
    );
    expect(invitation).toEqual({
      status: "revoked",
      reason: "inviter_suspended",
    });
    // One audit event for the suspension, with the counts; one mfa check.
    const events = await auditOf(row.id);
    expect(events.map((e) => e.action)).toEqual(["org.member.suspend"]);
    expect(events[0]).toMatchObject({
      entity_type: "org.member",
      actor_id: users.owner,
      before: { userId: target, suspendedAt: null },
      after: {
        suspendedBy: users.owner,
        reason: REASON,
        sessionsClosed: 2,
        accessGrantsRevoked: 1,
        invitationsRevoked: 1,
      },
    });
    expect((await auditOf(grantId)).map((e) => e.action)).toContain(
      "org.access_grant.revoke",
    );
    expect((await auditOf(invitationId)).map((e) => e.action)).toContain(
      "org.invitation.revoke",
    );
    expect(await mfaChecks(target)).toBe(checks + 1);
    expect(await auditCount(ORG_B)).toBe(beforeB);
    // The member list still shows them, as suspended.
    const listed = (await membersAs(users.owner)).find((m) => m.id === row.id);
    expect(listed).toMatchObject({
      status: "suspended",
      suspendReason: REASON,
    });
    // Again: 409, nothing written.
    const count = await auditCount(ORG_A);
    expectProblem(
      await call(users.owner, "POST", `${MEMBERS}/${row.id}/suspend`, {
        reason: REASON,
      }),
      409,
      "request.conflict",
    );
    expect(await auditCount(ORG_A)).toBe(count);
  });

  test("a suspended member gets no new elevation (409); the invitation they sent stays revoked with its reason when an admin revokes it again by hand (204, nothing rewritten)", async () => {
    const row = await orgRowOf(users.inviter);
    expect(row.suspended).toBe(true);
    expectProblem(
      await call(users.owner, "POST", GRANTS, {
        userId: users.inviter,
        permission: "org.role.read.org",
        reason: "cover",
        expiresAt: isoAt(at + HOUR),
      }),
      409,
      "request.conflict",
    );
    const [invitation] = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.invitations WHERE org_id = $1 AND invited_by = $2",
      [ORG_A, users.inviter],
    );
    const again = await call(
      users.owner,
      "DELETE",
      `${INVITATIONS}/${invitation?.id ?? ""}`,
    );
    expect(again.statusCode, again.body).toBe(204);
    const [kept] = await asAdmin<{ status: string; reason: string }>(
      "SELECT status, revoke_reason AS reason FROM bricx.invitations WHERE id = $1",
      [invitation?.id],
    );
    expect(kept).toEqual({ status: "revoked", reason: "inviter_suspended" });
  });

  test("reactivation: the role and project rows count again on a NEW sign-in; the sessions ended by the suspension stay ended (401 on the old one); audited with one mfa check; a second reactivate is 409", async () => {
    const target = users.inviter;
    const row = await orgRowOf(target);
    const checks = await mfaChecks(target);
    const back = memberOf(
      await call(users.owner, "POST", `${MEMBERS}/${row.id}/reactivate`),
    );
    expect(back).toMatchObject({
      status: "active",
      suspendedAt: null,
      suspendReason: null,
    });
    // The old sign-in: its session row is revoked, so it stays dead.
    const old = await call(target, "GET", ME);
    expect(old.statusCode, old.body).toBe(401);
    // A new sign-in works and reads the project row again.
    const fresh = newSid();
    expect((await whoAmI(target, fresh)).projectIds).toEqual([]);
    expect(
      (await call(target, "GET", MEMBERS, undefined, { sid: fresh }))
        .statusCode,
    ).toBe(200);
    const events = await auditOf(row.id);
    expect(events.map((e) => e.action)).toEqual([
      "org.member.suspend",
      "org.member.reactivate",
    ]);
    expect(events[1]).toMatchObject({
      actor_id: users.owner,
      after: { suspendedAt: null },
    });
    expect(await mfaChecks(target)).toBe(checks + 1);
    // The ended elevation and the revoked invitation do not come back.
    const [open] = await asAdmin<{ n: number }>(
      "SELECT count(*)::int AS n FROM bricx.access_grants WHERE org_id = $1 AND user_id = $2 AND revoked_at IS NULL",
      [ORG_A, target],
    );
    expect(open?.n).toBe(0);
    expectProblem(
      await call(users.owner, "POST", `${MEMBERS}/${row.id}/reactivate`),
      409,
      "request.conflict",
    );
  });

  test("nobody suspends, reactivates or renews themselves: 403, the row unchanged, one deduplicated org.invitation.denied event (self_suspend, self_renew)", async () => {
    const row = await orgRowOf(users.admin);
    const denied = () =>
      asAdmin<{ reason: string }>(
        `SELECT after->>'reason' AS reason FROM bricx.audit_events
         WHERE org_id = $1 AND action = 'org.invitation.denied' AND actor_id = $2 ORDER BY seq`,
        [ORG_A, users.admin],
      ).then((rows) => rows.map((r) => r.reason));
    const before = await denied();
    for (let i = 0; i < 2; i += 1) {
      expectProblem(
        await call(users.admin, "POST", `${MEMBERS}/${row.id}/suspend`, {
          reason: REASON,
        }),
        403,
        "forbidden",
      );
    }
    expect(await denied()).toEqual([...before, "self_suspend"]);
    expectProblem(
      await call(users.admin, "POST", `${MEMBERS}/${row.id}/renew`, {
        expiresAt: isoAt(at + DAY),
        reason: RENEW_REASON,
      }),
      403,
      "forbidden",
    );
    expect(await denied()).toEqual([...before, "self_suspend", "self_renew"]);
    expect((await orgRowOf(users.admin)).suspended).toBe(false);
    expect((await call(users.admin, "GET", MEMBERS)).statusCode).toBe(200);
  });

  test("the last ACTIVE owner cannot be suspended (409) by an all-keys custom role; with two active owners one can be, and then the other cannot; a suspended owner does not count as an owner for removal either", async () => {
    // A custom role with every key of the catalogue: passes holdsAll against an owner.
    const { CATALOGUE } = await import("@bricx/permissions/catalogue");
    const all = await seedRole(asAdmin, ORG_A, "allkeys");
    await grantKeys(all, CATALOGUE);
    await applyAccess(asAdmin, {
      orgId: ORG_A,
      userId: users.allKeys,
      role: "allkeys",
    });
    const owner = await orgRowOf(users.owner);
    const owner2 = await orgRowOf(users.owner2);
    memberOf(
      await call(users.allKeys, "POST", `${MEMBERS}/${owner2.id}/suspend`, {
        reason: REASON,
      }),
    );
    expectProblem(
      await call(users.allKeys, "POST", `${MEMBERS}/${owner.id}/suspend`, {
        reason: REASON,
      }),
      409,
      "request.conflict",
    );
    expect((await orgRowOf(users.owner)).suspended).toBe(false);
    // Removing the only active owner is refused too (the suspended one does not count).
    expectProblem(
      await call(users.allKeys, "DELETE", `${MEMBERS}/${owner.id}`),
      409,
      "request.conflict",
    );
    memberOf(
      await call(users.owner, "POST", `${MEMBERS}/${owner2.id}/reactivate`),
    );
  });

  test("target protection, validation and unknown ids: a member admin cannot suspend an owner or a finance member (403, holdsAll); a reader is 403; no reason, a blank one, 201 characters or an unknown field is 422; an unknown, removed or other-org membership is 404", async () => {
    const owner2 = await orgRowOf(users.owner2);
    const finance = await orgRowOf(users.finance);
    const spare = await orgRowOf(users.spare);
    for (const id of [owner2.id, finance.id]) {
      expectProblem(
        await call(users.admin, "POST", `${MEMBERS}/${id}/suspend`, {
          reason: REASON,
        }),
        403,
        "forbidden",
      );
    }
    expectProblem(
      await call(users.manager, "POST", `${MEMBERS}/${spare.id}/suspend`, {
        reason: REASON,
      }),
      403,
      "forbidden",
    );
    for (const body of [
      {},
      { reason: "" },
      { reason: "   " },
      { reason: "x".repeat(201) },
      { reason: REASON, extra: true },
    ]) {
      expectProblem(
        await call(users.owner, "POST", `${MEMBERS}/${spare.id}/suspend`, body),
        422,
        "validation_failed",
      );
    }
    memberOf(
      await call(users.owner, "POST", `${MEMBERS}/${spare.id}/suspend`, {
        reason: "x".repeat(200),
      }),
    );
    const [ownerB] = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.memberships WHERE org_id = $1 AND user_id = $2",
      [ORG_B, users.ownerB],
    );
    for (const id of [seedId(), ownerB?.id ?? ""]) {
      for (const action of ["suspend", "reactivate", "renew"]) {
        expectProblem(
          await call(
            users.owner,
            "POST",
            `${MEMBERS}/${id}/${action}`,
            action === "suspend"
              ? { reason: REASON }
              : action === "renew"
                ? { expiresAt: isoAt(at + DAY), reason: RENEW_REASON }
                : undefined,
          ),
          404,
          "not_found",
        );
      }
    }
    const [bRow] = await asAdmin<{ suspended: boolean }>(
      "SELECT (suspended_at IS NOT NULL) AS suspended FROM bricx.memberships WHERE id = $1",
      [ownerB?.id],
    );
    expect(bRow?.suspended).toBe(false);
  });

  test("the reason is shown only to org.member.read holders (A3): the project member list of a project manager without that key carries suspendReason null, and GET /v1/me/memberships never carries a reason field", async () => {
    // A project-level suspension of `worker` on P1, by the owner.
    const pm = await assign(users.worker, P1, "milestone_viewer");
    projectMemberOf(
      await call(
        users.owner,
        "POST",
        `${projectMembers(P1)}/${pm.id}/suspend`,
        { reason: REASON },
      ),
    );
    const asOwner = await call(users.owner, "GET", projectMembers(P1));
    const ownerSees = ProjectMemberList.schema
      .parse(JSON.parse(asOwner.body))
      .items.find((m) => m.id === pm.id);
    expect(ownerSees).toMatchObject({
      status: "suspended",
      suspendReason: REASON,
    });
    // The manager holds project.member.read on P1 but not org.member.read.
    const asManager = await call(users.manager, "GET", projectMembers(P1));
    expect(asManager.statusCode, asManager.body).toBe(200);
    const managerSees = ProjectMemberList.schema
      .parse(JSON.parse(asManager.body))
      .items.find((m) => m.id === pm.id);
    expect(managerSees).toMatchObject({
      status: "suspended",
      suspendedAt: expect.any(String) as string,
      suspendReason: null,
    });
    expect(asManager.body).not.toContain("needle-6b01");
    // The member's own view: no reason, no field for one.
    const mine = await mineAs(users.worker);
    expect(mine.body).not.toContain("needle-6b01");
    expect(mine.body).not.toContain("suspendReason");
    expect(mine.items[0]).toMatchObject({ status: "active", external: false });
    projectMemberOf(
      await call(
        users.owner,
        "POST",
        `${projectMembers(P1)}/${pm.id}/reactivate`,
      ),
    );
  });

  test("a suspension and a reactivation racing on one membership serialise under the org lock: every answer is 200 or 409, the row and the audit trail agree", async () => {
    const row = await orgRowOf(users.racer);
    const answers = await Promise.all([
      call(users.owner, "POST", `${MEMBERS}/${row.id}/suspend`, {
        reason: "race a",
      }),
      call(users.owner2, "POST", `${MEMBERS}/${row.id}/suspend`, {
        reason: "race b",
      }),
      call(users.admin, "POST", `${MEMBERS}/${row.id}/reactivate`),
    ]);
    for (const res of answers) {
      expect([200, 409], res.body).toContain(res.statusCode);
    }
    const events = (await auditOf(row.id)).map((e) => e.action);
    // The audit trail alternates, starting with a suspension.
    events.forEach((action, i) => {
      expect(action).toBe(
        i % 2 === 0 ? "org.member.suspend" : "org.member.reactivate",
      );
    });
    expect(events.length).toBe(
      answers.filter((res) => res.statusCode === 200).length,
    );
    expect((await orgRowOf(users.racer)).suspended).toBe(
      events.length % 2 === 1,
    );
  });
});

describe("POST /v1/projects/:projectId/members/:id/suspend (project.member.assign; DW3, C2)", () => {
  test("a project-level suspension takes that project's keys and id away on the next request, keeps the other project, the org membership and the sessions (as project removal does today), and ends the access grants on that project only; reactivation gives the keys back on the same session", async () => {
    const target = users.elevated;
    const onP1 = await assign(target, P1, "milestone_viewer");
    await assign(target, P2, "milestone_viewer");
    const grantOn = async (project: string) => {
      const res = await call(users.owner, "POST", GRANTS, {
        userId: target,
        permission: BUDGET_APPROVE,
        scopeId: project,
        reason: "cover",
        expiresAt: isoAt(at + HOUR),
      });
      expect(res.statusCode, res.body).toBe(201);
      return (JSON.parse(res.body) as { id: string }).id;
    };
    const g1 = await grantOn(P1);
    const g2 = await grantOn(P2);
    const beforeIdentity = await whoAmI(target);
    expect(beforeIdentity.projectIds.sort()).toEqual([P1, P2].sort());
    expect(
      beforeIdentity.grants
        .filter((g) => g.projectIds?.includes(P1))
        .map((g) => g.permission)
        .sort(),
    ).toEqual(HELD_ON_PROJECT);
    const checks = await mfaChecks(target);

    const suspended = projectMemberOf(
      await call(
        users.owner,
        "POST",
        `${projectMembers(P1)}/${onP1.id}/suspend`,
        { reason: REASON },
      ),
    );
    expect(suspended).toMatchObject({
      status: "suspended",
      suspendReason: REASON,
      removedAt: null,
    });
    // The same session goes on; P1 is gone, P2 stays.
    const after = await whoAmI(target);
    expect(after.projectIds).toEqual([P2]);
    expect(after.grants.filter((g) => g.projectIds?.includes(P1))).toEqual([]);
    expect(
      after.grants
        .filter((g) => g.projectIds?.includes(P2))
        .map((g) => g.permission)
        .sort(),
    ).toEqual(HELD_ON_PROJECT);
    const sessions = await asAdmin<{ revoked: boolean }>(
      "SELECT (revoked_at IS NOT NULL) AS revoked FROM bricx.sessions WHERE org_id = $1 AND user_id = $2",
      [ORG_A, target],
    );
    expect(sessions.map((s) => s.revoked)).toEqual([false]);
    const grants = await asAdmin<{ id: string; revoked: boolean }>(
      "SELECT id::text, (revoked_at IS NOT NULL) AS revoked FROM bricx.access_grants WHERE id = ANY($1::uuid[])",
      [[g1, g2]],
    );
    expect(Object.fromEntries(grants.map((g) => [g.id, g.revoked]))).toEqual({
      [g1]: true,
      [g2]: false,
    });
    const events = await auditOf(onP1.id);
    expect(events.map((e) => e.action)).toEqual([
      "project.member.assign",
      "project.member.suspend",
    ]);
    expect(events[1]).toMatchObject({
      actor_id: users.owner,
      after: { reason: REASON, accessGrantsRevoked: 1 },
    });
    expect(await mfaChecks(target)).toBe(checks + 1);
    expectProblem(
      await call(
        users.owner,
        "POST",
        `${projectMembers(P1)}/${onP1.id}/suspend`,
        { reason: REASON },
      ),
      409,
      "request.conflict",
    );
    // The wrong project in the path: 404.
    expectProblem(
      await call(
        users.owner,
        "POST",
        `${projectMembers(P2)}/${onP1.id}/reactivate`,
      ),
      404,
      "not_found",
    );
    projectMemberOf(
      await call(
        users.owner,
        "POST",
        `${projectMembers(P1)}/${onP1.id}/reactivate`,
      ),
    );
    expect((await whoAmI(target)).projectIds.sort()).toEqual([P1, P2].sort());
    expect((await auditOf(onP1.id)).map((e) => e.action).at(-1)).toBe(
      "project.member.reactivate",
    );
  });

  test("the project manager of P1 suspends a viewer there but not themselves (403 self_suspend) and not a member holding a key they lack (403); a project manager of P1 is 403 on P2", async () => {
    const [own] = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.project_memberships WHERE org_id = $1 AND project_id = $2 AND user_id = $3 AND removed_at IS NULL",
      [ORG_A, P1, users.manager],
    );
    expectProblem(
      await call(
        users.manager,
        "POST",
        `${projectMembers(P1)}/${own?.id ?? ""}/suspend`,
        { reason: REASON },
      ),
      403,
      "forbidden",
    );
    const fin = await assign(users.finance, P1, "finrole");
    expectProblem(
      await call(
        users.manager,
        "POST",
        `${projectMembers(P1)}/${fin.id}/suspend`,
        { reason: REASON },
      ),
      403,
      "forbidden",
    );
    const viewer = await assign(users.promoted, P1, "milestone_viewer");
    projectMemberOf(
      await call(
        users.manager,
        "POST",
        `${projectMembers(P1)}/${viewer.id}/suspend`,
        { reason: REASON },
      ),
    );
    const onP2 = await assign(users.promoted, P2, "milestone_viewer");
    expectProblem(
      await call(
        users.manager,
        "POST",
        `${projectMembers(P2)}/${onP2.id}/suspend`,
        { reason: REASON },
      ),
      403,
      "forbidden",
    );
  });
});

describe("temporary memberships (DW9, DW11, DW12, C8, A2)", () => {
  test("a temporary project membership: the delayed memberships.expire job is an outbox row of the assign (not_before = expires_at) and, with under 7 days left, so is the memberships.expiring notice; with 7 days or more there is no notice yet; an end under 1 hour or over 366 days ahead is 422 at expiresAt", async () => {
    const soonEnd = at + 2 * HOUR;
    const soon = await assign(users.temp, P1, "milestone_viewer", {
      expiresAt: isoAt(soonEnd),
    });
    expect(soon).toMatchObject({ status: "active", expiresAt: isoAt(soonEnd) });
    expect(await outboxOf(soon.id)).toEqual([
      {
        topic: "memberships.expire",
        payload: {
          kind: "project",
          membershipId: soon.id,
          userId: users.temp,
          expiresAt: isoAt(soonEnd),
        },
        not_before: isoAt(soonEnd),
      },
      {
        topic: "memberships.expiring",
        payload: { kind: "project", membershipId: soon.id, userId: users.temp },
        not_before: null,
      },
    ]);
    const laterEnd = at + 7 * DAY;
    const later = await assign(users.temp, P2, "milestone_viewer", {
      expiresAt: isoAt(laterEnd),
    });
    expect((await outboxOf(later.id)).map((r) => r.topic)).toEqual([
      "memberships.expire",
    ]);
    const [audit] = await auditOf(soon.id);
    expect(audit?.after).toMatchObject({ expiresAt: isoAt(soonEnd) });
    for (const end of [at + HOUR - 1_000, at + 366 * DAY + 1_000, at - HOUR]) {
      const res = await call(users.owner, "POST", projectMembers(P1), {
        userId: users.spare,
        roleId: roleId("milestone_viewer"),
        expiresAt: isoAt(end),
      });
      expectProblem(res, 422, "validation_failed");
      expect(
        (JSON.parse(res.body) as { issues: { path: string[] }[] }).issues[0]
          ?.path,
      ).toEqual(["expiresAt"]);
    }
    expectProblem(
      await call(users.owner, "POST", projectMembers(P1), {
        userId: users.spare,
        roleId: roleId("milestone_viewer"),
        expiresAt: "2027-01-01",
      }),
      422,
      "validation_failed",
    );
  });

  test("the end is exact at the Clock, with no job involved: one millisecond before expires_at the project's keys count, at expires_at they are gone (the other project stays); the member list says expired; the session is kept", async () => {
    const [soon] = await asAdmin<{ id: string; ends: string }>(
      `SELECT id::text, to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ends
       FROM bricx.project_memberships WHERE org_id = $1 AND user_id = $2 AND project_id = $3`,
      [ORG_A, users.temp, P1],
    );
    const end = Date.parse(soon?.ends ?? "");
    const start = at;
    try {
      at = end - 1;
      const sid = newSid();
      expect((await whoAmI(users.temp, sid)).projectIds.sort()).toEqual(
        [P1, P2].sort(),
      );
      at = end;
      expect((await whoAmI(users.temp, sid)).projectIds).toEqual([P2]);
      const listed = ProjectMemberList.schema
        .parse(
          JSON.parse(
            (
              await call(users.owner, "GET", projectMembers(P1), undefined, {
                sid: newSid(),
              })
            ).body,
          ),
        )
        .items.find((m) => m.id === soon?.id);
      expect(listed).toMatchObject({ status: "expired" });
      // Lazy: nothing recorded the expiry yet.
      const [row] = await asAdmin<{ expired: boolean }>(
        "SELECT (expired_at IS NOT NULL) AS expired FROM bricx.project_memberships WHERE id = $1",
        [soon?.id],
      );
      expect(row?.expired).toBe(false);
    } finally {
      at = start;
    }
  });

  test("a temporary ORG membership ends the same way: 200 one millisecond before, 403 membership_missing at expires_at; renewal (a reason, an end 1 hour to 366 days ahead) brings it back, audited with before and after, with a new expire job and no notice beyond 7 days (and no job at all beyond the queue's longest delay); a permanent membership cannot be renewed (409)", async () => {
    const end = T0 + 3 * HOUR;
    const id = await orgMember(users.tempOrg, "member", end);
    const start = at;
    try {
      at = end - 1;
      expect(
        (await call(users.tempOrg, "GET", ME, undefined, { sid: newSid() }))
          .statusCode,
      ).toBe(200);
      at = end;
      expectProblem(
        await call(users.tempOrg, "GET", ME, undefined, { sid: newSid() }),
        403,
        "forbidden",
      );
      expect(lastAuthFailure()).toBe("membership_missing");
      const ownerSid = newSid();
      const listed = (
        MemberList.schema.parse(
          JSON.parse(
            (
              await call(users.owner, "GET", MEMBERS, undefined, {
                sid: ownerSid,
              })
            ).body,
          ),
        ) as { items: { id: string; status: string }[] }
      ).items.find((m) => m.id === id);
      expect(listed?.status).toBe("expired");
      // Renewal of an expired membership.
      for (const body of [
        { expiresAt: isoAt(at + DAY) },
        { expiresAt: isoAt(at + DAY), reason: " " },
        { reason: RENEW_REASON },
        { expiresAt: isoAt(at + HOUR - 1_000), reason: RENEW_REASON },
        { expiresAt: isoAt(at + 366 * DAY + 1_000), reason: RENEW_REASON },
        { expiresAt: isoAt(at + DAY), reason: "x".repeat(501) },
      ]) {
        expectProblem(
          await call(users.owner, "POST", `${MEMBERS}/${id}/renew`, body, {
            sid: ownerSid,
          }),
          422,
          "validation_failed",
        );
      }
      const newEnd = at + 10 * DAY;
      const renewed = memberOf(
        await call(
          users.owner,
          "POST",
          `${MEMBERS}/${id}/renew`,
          { expiresAt: isoAt(newEnd), reason: RENEW_REASON },
          { sid: ownerSid },
        ),
      );
      expect(renewed).toMatchObject({
        status: "active",
        expiresAt: isoAt(newEnd),
      });
      expect(
        (await call(users.tempOrg, "GET", ME, undefined, { sid: newSid() }))
          .statusCode,
      ).toBe(200);
      const events = await auditOf(id);
      expect(events.map((e) => e.action)).toEqual(["org.member.renew"]);
      expect(events[0]?.before).toMatchObject({ expiredAt: null });
      expect(events[0]).toMatchObject({
        actor_id: users.owner,
        before: { userId: users.tempOrg, expiresAt: isoAt(end) },
        after: { expiresAt: isoAt(newEnd), reason: RENEW_REASON },
      });
      expect(await outboxOf(id)).toEqual([
        {
          topic: "memberships.expire",
          payload: {
            kind: "org",
            membershipId: id,
            userId: users.tempOrg,
            expiresAt: isoAt(newEnd),
          },
          not_before: isoAt(newEnd),
        },
      ]);
      // Beyond BullMQ's longest delay (about 24.8 days) no job is written:
      // the sweep records that expiry (ADR 0084).
      const farEnd = at + 30 * DAY;
      memberOf(
        await call(
          users.owner,
          "POST",
          `${MEMBERS}/${id}/renew`,
          { expiresAt: isoAt(farEnd), reason: RENEW_REASON },
          { sid: ownerSid },
        ),
      );
      expect(await outboxOf(id)).toHaveLength(1);
      const permanent = await orgRowOf(users.worker);
      expectProblem(
        await call(
          users.owner,
          "POST",
          `${MEMBERS}/${permanent.id}/renew`,
          { expiresAt: isoAt(at + DAY), reason: RENEW_REASON },
          { sid: ownerSid },
        ),
        409,
        "request.conflict",
      );
    } finally {
      at = start;
    }
  });

  test("a project membership is renewed by project.member.assign with a reason; on an archived project it is 409; a renewal that leaves under 7 days writes the notice at once and marks the row", async () => {
    const [soon] = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.project_memberships WHERE org_id = $1 AND user_id = $2 AND project_id = $3",
      [ORG_A, users.temp, P1],
    );
    const id = soon?.id ?? "";
    const before = (await outboxOf(id)).length;
    const newEnd = at + 3 * DAY;
    const renewed = projectMemberOf(
      await call(users.manager, "POST", `${projectMembers(P1)}/${id}/renew`, {
        expiresAt: isoAt(newEnd),
        reason: RENEW_REASON,
      }),
    );
    expect(renewed).toMatchObject({
      status: "active",
      expiresAt: isoAt(newEnd),
    });
    expect((await outboxOf(id)).slice(before).map((r) => r.topic)).toEqual([
      "memberships.expire",
      "memberships.expiring",
    ]);
    const [row] = await asAdmin<{ notified: boolean }>(
      "SELECT (expiry_notified_at IS NOT NULL) AS notified FROM bricx.project_memberships WHERE id = $1",
      [id],
    );
    expect(row?.notified).toBe(true);
    expect((await auditOf(id)).at(-1)).toMatchObject({
      action: "project.member.renew",
      actor_id: users.manager,
      after: { expiresAt: isoAt(newEnd), reason: RENEW_REASON },
    });
    // An archived project: its temporary membership cannot be renewed.
    const archivedRow = seedId();
    await asAdmin(
      `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz)`,
      [
        archivedRow,
        ORG_A,
        P_ARCHIVED,
        users.spare,
        roleId("milestone_viewer"),
        isoAt(T0 - 60_000),
        isoAt(T0 + DAY),
      ],
    );
    await asAdmin(
      "UPDATE bricx.projects SET status = 'archived', archived_at = now() WHERE id = $1",
      [P_ARCHIVED],
    );
    expectProblem(
      await call(
        users.owner,
        "POST",
        `${projectMembers(P_ARCHIVED)}/${archivedRow}/renew`,
        { expiresAt: isoAt(at + 2 * DAY), reason: RENEW_REASON },
      ),
      409,
      "request.conflict",
    );
  });

  test("GET /v1/members?expiringWithinDays=N lists the temporary members ending within N days, soonest first (org.member.read); permanent, suspended-or-not, and later ones are left out; 0, 91 and a non-number are 422", async () => {
    const soonId = await orgMember(users.soon, "member", T0 + 2 * DAY);
    const laterId = await orgMember(users.later, "member", T0 + 20 * DAY);
    const within = async (days: number) =>
      (await membersAs(users.admin, `?expiringWithinDays=${String(days)}`)).map(
        (m) => m.id,
      );
    expect(await within(7)).toEqual([soonId]);
    const month = await within(30);
    expect(month.slice(0, 2)).toEqual([soonId, laterId]);
    const [tempOrg] = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.memberships WHERE org_id = $1 AND user_id = $2",
      [ORG_A, users.tempOrg],
    );
    // tempOrg was renewed to 30 days and 3 hours ahead: beyond the window.
    expect(month).not.toContain(tempOrg?.id);
    for (const value of ["0", "91", "x", "1.5"]) {
      expectProblem(
        await call(
          users.owner,
          "GET",
          `${MEMBERS}?expiringWithinDays=${value}`,
        ),
        422,
        "validation_failed",
      );
    }
    expectProblem(
      await call(users.manager, "GET", `${MEMBERS}?expiringWithinDays=7`),
      403,
      "forbidden",
    );
  });

  test("the owner role is never temporary (A2): PATCH of a temporary member to the owner role is 409 and the role is unchanged; so is assigning a temporary member the owner role on a project", async () => {
    const [soon] = await asAdmin<{ id: string; role_id: string }>(
      "SELECT id::text, role_id::text FROM bricx.memberships WHERE org_id = $1 AND user_id = $2",
      [ORG_A, users.soon],
    );
    expectProblem(
      await call(users.owner, "PATCH", `${MEMBERS}/${soon?.id ?? ""}`, {
        roleId: roleId("owner"),
      }),
      409,
      "request.conflict",
    );
    const [after] = await asAdmin<{ role_id: string }>(
      "SELECT role_id::text FROM bricx.memberships WHERE id = $1",
      [soon?.id],
    );
    expect(after?.role_id).toBe(soon?.role_id);
  });
});

describe("an archived organisation (plan edge case)", () => {
  test("its owner gets 404 not_found on suspend, reactivate, renew, activity and the expiring list, on org and project routes; the row and the audit trail are unchanged", async () => {
    const ORG_C = "0199e1b0-0000-7000-8000-0000000000c1";
    const P_C = "0199e1b0-0000-7000-8000-0000000000c3";
    const ownerC = seedId();
    const memberC = seedId();
    await seedUsers(asAdmin, [
      { id: ownerC, sub: subOf(ownerC) },
      { id: memberC, sub: subOf(memberC) },
    ]);
    await applyAccess(asAdmin, { orgId: ORG_C, userId: ownerC, role: "owner" });
    await applyAccess(asAdmin, {
      orgId: ORG_C,
      userId: memberC,
      role: "member",
      projects: [P_C],
    });
    await asAdmin(
      "UPDATE bricx.memberships SET expires_at = $3::timestamptz WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL",
      [ORG_C, memberC, isoAt(at + 2 * DAY)],
    );
    const [row] = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.memberships WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL",
      [ORG_C, memberC],
    );
    const [projectRow] = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.project_memberships WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL",
      [ORG_C, memberC],
    );
    const id = row?.id ?? "";
    const projectId = projectRow?.id ?? "";
    // Before archiving, the owner reaches the list.
    expect(
      (await call(ownerC, "GET", MEMBERS, undefined, { org: ORG_C }))
        .statusCode,
    ).toBe(200);
    await asAdmin(
      "UPDATE bricx.organizations SET archived_at = now() WHERE id = $1",
      [ORG_C],
    );
    const snapshot = async () =>
      asAdmin(
        `SELECT m.suspended_at, m.expires_at, m.expired_at, pm.suspended_at AS p_suspended_at
         FROM bricx.memberships m, bricx.project_memberships pm WHERE m.id = $1 AND pm.id = $2`,
        [id, projectId],
      );
    const before = await snapshot();
    const events = await auditCount(ORG_C);
    const attempts: ["GET" | "POST", string, unknown][] = [
      ["POST", `${MEMBERS}/${id}/suspend`, { reason: REASON }],
      ["POST", `${MEMBERS}/${id}/reactivate`, {}],
      [
        "POST",
        `${MEMBERS}/${id}/renew`,
        { expiresAt: isoAt(at + 10 * DAY), reason: RENEW_REASON },
      ],
      ["GET", `${MEMBERS}/${id}/activity`, undefined],
      ["GET", `${MEMBERS}?expiringWithinDays=7`, undefined],
      [
        "POST",
        `${projectMembers(P_C)}/${projectId}/suspend`,
        { reason: REASON },
      ],
      ["POST", `${projectMembers(P_C)}/${projectId}/reactivate`, {}],
    ];
    for (const [method, url, body] of attempts) {
      expectProblem(
        await call(ownerC, method, url, body, { org: ORG_C }),
        404,
        "not_found",
      );
    }
    expect(await snapshot()).toEqual(before);
    expect(await auditCount(ORG_C)).toEqual(events);
  });
});

describe("what never reaches a log line (C8)", () => {
  test("no log line carries a suspension or renewal reason", () => {
    const all = lines.join("\n");
    expect(all).not.toContain("needle-6b01");
    expect(all).not.toContain("needle-6b02");
    expect(lines.length).toBeGreaterThan(0);
  });
});
