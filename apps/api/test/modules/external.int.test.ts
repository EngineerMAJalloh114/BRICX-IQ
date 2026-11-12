// P6-06b (ADR 0084; Done-when DW13 to DW16; owner condition C3 and
// addition A1), against compose.yml's Postgres with the production
// journal, through the real app and the production grants source.
// External members and temporary memberships enter through invitations
// (POST /v1/members is retired, ADR 0077):
// - an external invitation needs a project (422), never the owner role
//   (409); accepted, the NEW org membership is is_external and the member
//   is limited to the assigned project: of the org role's bundle only
//   EXTERNAL_ORG_KEYS stay, never every project (allProjects false),
//   never an org-scope finance key; their grants are a subset of what the
//   same role and project rows give an internal member; no org-scope
//   elevation can be created for them (409); a project-scope one on their
//   project can;
// - an existing internal member who accepts an external invitation stays
//   internal (the flag never changes on a row);
// - membershipExpiresAt is an absolute instant, 1 hour to 366 days ahead
//   at creation (422), never with the owner role (409); accepted, the org
//   and project rows carry it, with the expire job and, under 7 days, the
//   notice in the accept transaction; once it has passed, accept is the
//   uniform 404 and the invitation stays pending (A1);
// - a user suspended in one org accepts an invitation to another org and
//   stays suspended in the first.
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
import { type Database, openDatabase } from "@bricx/db/database";
import {
  hashInvitationSecret,
  invitationTokenOf,
  mintInvitationToken,
  newInvitationSecret,
} from "@bricx/db/invitations";
import { migrate } from "@bricx/db/migrate";
import { EXTERNAL_ORG_KEYS } from "@bricx/permissions/external";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import { Controller, Get } from "@nestjs/common";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import { NoPermission } from "../../src/common/auth/can.decorator.js";
import { currentRequestContext } from "../../src/common/db/request-context.js";
import { IDEMPOTENCY_KEY_HEADER } from "../../src/common/idempotency/decorator.js";
import type { UserinfoAnswer } from "../../src/modules/invitations/userinfo.js";
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
import { addMember } from "../support/members.js";
import { memoryRateLimits } from "../support/rate-limit.js";

const HOOK_MS = 300_000;
const ORG_A = "0199e1b1-0000-7000-8000-0000000006a1";
const ORG_B = "0199e1b1-0000-7000-8000-0000000006b1";
const P1 = "0199e1b1-0000-7000-8000-0000000006c1";
const P2 = "0199e1b1-0000-7000-8000-0000000006c2";
const P_B = "0199e1b1-0000-7000-8000-0000000006c3";
const users = {
  owner: "0199e1b1-0000-7000-8000-000000000601",
  ownerB: "0199e1b1-0000-7000-8000-000000000602",
  external: "0199e1b1-0000-7000-8000-000000000603",
  internal: "0199e1b1-0000-7000-8000-000000000604",
  already: "0199e1b1-0000-7000-8000-000000000605",
  temp: "0199e1b1-0000-7000-8000-000000000606",
  late: "0199e1b1-0000-7000-8000-000000000607",
  suspended: "0199e1b1-0000-7000-8000-000000000608",
  nobody: "0199e1b1-0000-7000-8000-000000000609",
} as const;
const subOf = (user: string) => `ext-${user}`;
const INVITATIONS = "/v1/invitations";
const MEMBERS = "/v1/members";
const GRANTS = "/v1/access-grants";
const WHOAMI = "/v1/whoami";
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** The "wide" custom role: org-scope keys an external member must not keep, and the one they do. */
const WIDE_KEYS = [
  "org.region_config.read.org",
  "org.member.read.org",
  "project.milestone.read.org",
  "finance.fx_rate.update.org",
  "finance.budget.read.org",
] as const;
const MILESTONE_READ = "project.milestone.read.project";
const BUDGET_READ_PROJECT = "finance.budget.read.project";

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
let worker: Database;
const lines: string[] = [];
/** The API's Clock: real time plus `skew` ms. */
let skew = 0;
const nowMs = () => Date.now() + skew;
/** A whole-second instant `ms` after the Clock, as the API reads and writes it. */
const instant = (ms: number) =>
  new Date(Math.floor((nowMs() + ms) / 1000) * 1000).toISOString();
let userinfo: (bearer: string) => UserinfoAnswer = () => {
  throw new Error("userinfo not set");
};
const roles: Record<string, string> = {};

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

const grantKeys = async (
  orgId: string,
  role: string,
  keys: readonly string[],
) => {
  for (const permission of keys) {
    await asAdmin(
      `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
      [seedId(), orgId, role, permission],
    );
  }
};

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
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.owner,
    role: "owner",
  });
  await applyAccess(asAdmin, {
    orgId: ORG_B,
    userId: users.ownerB,
    role: "owner",
  });
  await seedProjects(asAdmin, ORG_A, [P1, P2]);
  await seedProjects(asAdmin, ORG_B, [P_B]);
  await grantKeys(ORG_A, await seedRole(asAdmin, ORG_A, "wide"), WIDE_KEYS);
  await grantKeys(ORG_A, await seedRole(asAdmin, ORG_A, "site_reader"), [
    MILESTONE_READ,
    BUDGET_READ_PROJECT,
  ]);
  for (const key of ["wide", "site_reader", "owner", "member"]) {
    roles[key] = await seedRole(asAdmin, ORG_A, key);
  }
  roles.memberB = await seedRole(asAdmin, ORG_B, "member");
  // The internal twin of the external member: the same org role, the same project role on P1.
  await addMember(asAdmin, {
    orgId: ORG_A,
    userId: users.internal,
    roleId: roles.wide ?? "",
  });
  await asAdmin(
    `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at)
     VALUES ($1, $2, $3, $4, $5, now() - interval '1 minute')`,
    [seedId(), ORG_A, P1, users.internal, roles.site_reader],
  );
  for (const user of [users.already, users.suspended]) {
    await addMember(asAdmin, {
      orgId: ORG_A,
      userId: user,
      roleId: roles.member ?? "",
    });
  }
  const workerUrl = urlFor("bricx_app", "BRICX_APP_PASSWORD");
  worker = openDatabase({ reveal: () => workerUrl });
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
      clock: { now: nowMs },
      userinfo: { read: (token) => Promise.resolve(userinfo(token)) },
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
  await worker.close().catch(() => undefined);
  await issuer.close();
  await valkey.stop();
  await pg18.container.stop();
}, HOOK_MS);

type Res = Awaited<ReturnType<NestFastifyApplication["inject"]>>;
let keys = 0;
let sids = 0;
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
      iat: Math.floor(nowMs() / 1000) - 5,
      exp: Math.floor(nowMs() / 1000) + 3_600,
    }),
  );
  if (method === "POST") {
    keys += 1;
    headers[IDEMPOTENCY_KEY_HEADER] = `ext-key-${String(keys)}`;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.inject({
    method,
    url,
    headers,
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}

/** A signed-in call with no org (accept is @SignedIn). */
async function accept(user: string, email: string, token: string) {
  userinfo = () => ({ sub: subOf(user), email, emailVerified: true });
  return app.inject({
    method: "POST",
    url: `${INVITATIONS}/accept`,
    headers: {
      ...bearer(
        await issuer.token({
          sub: subOf(user),
          acr: "mfa",
          iat: Math.floor(nowMs() / 1000) - 5,
          exp: Math.floor(nowMs() / 1000) + 3_600,
        }),
      ),
      "content-type": "application/json",
    },
    payload: JSON.stringify({ token }),
  });
}

function expectProblem(res: Res, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
  expect(parsed.success, res.body).toBe(true);
  expect(parsed.data).toMatchObject({ status, code });
}

let addresses = 0;
const newAddress = () => {
  addresses += 1;
  return `external-${String(addresses)}@subcontractor.example`;
};

async function invite(
  by: string,
  body: Record<string, unknown>,
  org = ORG_A,
): Promise<{ id: string; made: Record<string, unknown> }> {
  const res = await call(by, "POST", INVITATIONS, body, { org });
  expect(res.statusCode, res.body).toBe(201);
  const made = JSON.parse(res.body) as Record<string, unknown>;
  return { id: String(made.id), made };
}

/** The worker's send step: a fresh secret minted on the current send; the token. */
async function mint(id: string): Promise<string> {
  const [row] = await asAdmin<{
    org_id: string;
    invited_by: string;
    send_seq: number;
  }>(
    "SELECT org_id::text, invited_by::text, send_seq FROM bricx.invitations WHERE id = $1",
    [id],
  );
  if (row === undefined) throw new Error("no invitation");
  const secret = newInvitationSecret();
  const minted = await worker.withTx(
    { orgId: row.org_id, userId: row.invited_by, projectIds: [] },
    (tx) =>
      mintInvitationToken(tx, {
        id,
        sendSeq: row.send_seq,
        hash: hashInvitationSecret(secret),
        now: new Date(nowMs()).toISOString(),
      }),
  );
  if (minted === undefined) throw new Error("not minted");
  return invitationTokenOf("af-south-1", secret);
}

interface Identity {
  projectIds: string[];
  allProjects: boolean;
  grants: { permission: string; scope: string; projectIds?: string[] }[];
}
async function whoAmI(user: string, org = ORG_A): Promise<Identity> {
  sids += 1;
  const res = await call(user, "GET", WHOAMI, undefined, {
    org,
    sid: `ext-sid-${String(sids)}`,
  });
  expect(res.statusCode, res.body).toBe(200);
  return (JSON.parse(res.body) as { identity: Identity }).identity;
}
/** A grant as one comparable string: key, scope and the projects it is on. */
const grantNames = (identity: Identity) =>
  identity.grants
    .map(
      (g) =>
        `${g.permission}.${g.scope}@${[...(g.projectIds ?? [])].sort().join(",")}`,
    )
    .sort();

const orgRows = (user: string, org = ORG_A) =>
  asAdmin<{
    id: string;
    is_external: boolean;
    expires: string | null;
    suspended: boolean;
  }>(
    `SELECT id::text, is_external, (suspended_at IS NOT NULL) AS suspended,
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires
     FROM bricx.memberships WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL`,
    [org, user],
  );
const projectRows = (user: string, org = ORG_A) =>
  asAdmin<{ id: string; project_id: string; expires: string | null }>(
    `SELECT id::text, project_id::text,
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires
     FROM bricx.project_memberships WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL ORDER BY id`,
    [org, user],
  );
const outboxOf = (membershipId: string) =>
  asAdmin<{ topic: string }>(
    "SELECT topic FROM bricx.outbox WHERE payload->>'membershipId' = $1 ORDER BY id",
    [membershipId],
  ).then((rows) => rows.map((r) => r.topic));
const statusOf = async (id: string) =>
  (
    await asAdmin<{ status: string }>(
      "SELECT status FROM bricx.invitations WHERE id = $1",
      [id],
    )
  )[0]?.status;
/** A 404 body without its per-request fields, for the uniform-error comparison. */
const uniformBody = (res: Res) => {
  const body = JSON.parse(res.body) as Record<string, unknown>;
  delete body.traceId;
  return body;
};

describe("external members (DW13, DW14, DW16, C3)", () => {
  test("an external invitation needs a project (422 at projectId) and is never for the owner role (409); created, the answer and the audit event carry external", async () => {
    const res = await call(users.owner, "POST", INVITATIONS, {
      email: newAddress(),
      roleId: roles.wide,
      external: true,
    });
    expectProblem(res, 422, "validation_failed");
    expect(
      (JSON.parse(res.body) as { issues: { path: string[] }[] }).issues[0]
        ?.path,
    ).toEqual(["projectId"]);
    expectProblem(
      await call(users.owner, "POST", INVITATIONS, {
        email: newAddress(),
        roleId: roles.owner,
        projectId: P1,
        projectRoleId: roles.site_reader,
        external: true,
      }),
      409,
      "request.conflict",
    );
    expectProblem(
      await call(users.owner, "POST", INVITATIONS, {
        email: newAddress(),
        roleId: roles.wide,
        projectId: P1,
        projectRoleId: roles.site_reader,
        external: "yes",
      }),
      422,
      "validation_failed",
    );
  });

  test("accepted, the member is external and limited to the assigned project: of the org role only EXTERNAL_ORG_KEYS stay, never every project, no org-scope finance key; their grants are a strict subset of the internal twin's (same org role, same project role)", async () => {
    const email = newAddress();
    const { id, made } = await invite(users.owner, {
      email,
      roleId: roles.wide,
      projectId: P1,
      projectRoleId: roles.site_reader,
      external: true,
    });
    expect(made).toMatchObject({ external: true, membershipExpiresAt: null });
    const [created] = await asAdmin<{ after: Record<string, unknown> }>(
      "SELECT after FROM bricx.audit_events WHERE entity_id = $1 AND action = 'org.invitation.create'",
      [id],
    );
    expect(created?.after).toMatchObject({ external: true });
    const res = await accept(users.external, email, await mint(id));
    expect(res.statusCode, res.body).toBe(200);
    const rows = await orgRows(users.external);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ is_external: true, expires: null });
    expect(
      (await projectRows(users.external)).map((r) => r.project_id),
    ).toEqual([P1]);

    const external = await whoAmI(users.external);
    const internal = await whoAmI(users.internal);
    // The internal twin: every project (an org key on a project resource), all five org keys.
    expect(internal.allProjects).toBe(true);
    expect(
      internal.grants.filter((g) => g.scope === "org").map((g) => g.permission),
    ).toHaveLength(WIDE_KEYS.length);
    // The external member: P1 only, the allowlisted org keys only.
    expect(external.allProjects).toBe(false);
    expect(external.projectIds).toEqual([P1]);
    expect(
      external.grants
        .filter((g) => g.scope === "org")
        .map((g) => `${g.permission}.org`)
        .sort(),
    ).toEqual(
      WIDE_KEYS.filter((k) =>
        (EXTERNAL_ORG_KEYS as readonly string[]).includes(k),
      ).sort(),
    );
    expect(
      external.grants.filter(
        (g) => g.scope === "org" && g.permission.startsWith("finance."),
      ),
    ).toEqual([]);
    expect(
      external.grants
        .filter((g) => g.scope === "project")
        .every((g) => (g.projectIds ?? []).join() === P1),
    ).toBe(true);
    const names = grantNames(external);
    const twin = new Set(grantNames(internal));
    expect(names.length).toBeGreaterThan(1);
    expect(names.filter((n) => !twin.has(n))).toEqual([]);
    expect(names.length).toBeLessThan(twin.size);
    // Through a route: the member list is the organisation's own.
    expect((await call(users.internal, "GET", MEMBERS)).statusCode).toBe(200);
    expectProblem(await call(users.external, "GET", MEMBERS), 403, "forbidden");
    // Their own memberships say so.
    const mine = await call(users.external, "GET", "/v1/me/memberships");
    expect(
      (JSON.parse(mine.body) as { items: { external: boolean }[] }).items[0]
        ?.external,
    ).toBe(true);
    // The owner's list too.
    const listed = (
      JSON.parse((await call(users.owner, "GET", MEMBERS)).body) as {
        items: { userId: string; external: boolean }[];
      }
    ).items;
    expect(listed.find((m) => m.userId === users.external)?.external).toBe(
      true,
    );
    expect(listed.find((m) => m.userId === users.internal)?.external).toBe(
      false,
    );
  });

  test("no org-scope elevation for an external member (409, nothing written); a project-scope one on their project is created and counts there", async () => {
    const before = await asAdmin<{ n: number }>(
      "SELECT count(*)::int AS n FROM bricx.access_grants WHERE user_id = $1",
      [users.external],
    );
    for (const permission of [
      "org.member.read.org",
      "finance.fx_rate.update.org",
    ]) {
      expectProblem(
        await call(users.owner, "POST", GRANTS, {
          userId: users.external,
          permission,
          reason: "cover",
          expiresAt: instant(HOUR),
        }),
        409,
        "request.conflict",
      );
    }
    expect(
      await asAdmin<{ n: number }>(
        "SELECT count(*)::int AS n FROM bricx.access_grants WHERE user_id = $1",
        [users.external],
      ),
    ).toEqual(before);
    const res = await call(users.owner, "POST", GRANTS, {
      userId: users.external,
      permission: "finance.budget.approve.project",
      scopeId: P1,
      reason: "cover",
      expiresAt: instant(HOUR),
    });
    expect(res.statusCode, res.body).toBe(201);
    const identity = await whoAmI(users.external);
    expect(grantNames(identity)).toContain(
      `finance.budget.approve.project@${P1}`,
    );
    expect(identity.allProjects).toBe(false);
    // Not a member of P2: no elevation there either.
    expectProblem(
      await call(users.owner, "POST", GRANTS, {
        userId: users.external,
        permission: "finance.budget.approve.project",
        scopeId: P2,
        reason: "cover",
        expiresAt: instant(HOUR),
      }),
      409,
      "request.conflict",
    );
  });

  test("an existing internal member who accepts an external invitation joins the project and stays internal (the flag never changes on a row)", async () => {
    const email = newAddress();
    const { id } = await invite(users.owner, {
      email,
      roleId: roles.member,
      projectId: P2,
      projectRoleId: roles.site_reader,
      external: true,
    });
    const res = await accept(users.already, email, await mint(id));
    expect(res.statusCode, res.body).toBe(200);
    const rows = await orgRows(users.already);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.is_external).toBe(false);
    expect((await projectRows(users.already)).map((r) => r.project_id)).toEqual(
      [P2],
    );
  });
});

describe("temporary memberships by invitation (DW9, DW12, A1, C8)", () => {
  test("membershipExpiresAt is an absolute instant 1 hour to 366 days ahead (422 at membershipExpiresAt otherwise, and for a date without a time), never with the owner role (409)", async () => {
    for (const value of [
      instant(HOUR - 60_000),
      instant(366 * DAY + 60_000),
      instant(-HOUR),
      "2027-06-01",
      "2027-06-01T00:00:00+02:00",
    ]) {
      const res = await call(users.owner, "POST", INVITATIONS, {
        email: newAddress(),
        roleId: roles.member,
        membershipExpiresAt: value,
      });
      expectProblem(res, 422, "validation_failed");
      expect(
        (JSON.parse(res.body) as { issues: { path: string[] }[] }).issues[0]
          ?.path,
      ).toEqual(["membershipExpiresAt"]);
    }
    expectProblem(
      await call(users.owner, "POST", INVITATIONS, {
        email: newAddress(),
        roleId: roles.owner,
        membershipExpiresAt: instant(DAY),
      }),
      409,
      "request.conflict",
    );
  });

  test("accepted, the org and the project membership end at that instant; the expire job for each and, under 7 days, the notice for each are outbox rows of the accept; the member is active now", async () => {
    const email = newAddress();
    const end = instant(2 * DAY);
    const { id, made } = await invite(users.owner, {
      email,
      roleId: roles.member,
      projectId: P1,
      projectRoleId: roles.site_reader,
      membershipExpiresAt: end,
    });
    expect(made).toMatchObject({ external: false, membershipExpiresAt: end });
    const res = await accept(users.temp, email, await mint(id));
    expect(res.statusCode, res.body).toBe(200);
    const [org] = await orgRows(users.temp);
    const [project] = await projectRows(users.temp);
    expect(org).toMatchObject({ expires: end, is_external: false });
    expect(project).toMatchObject({ expires: end, project_id: P1 });
    for (const row of [org, project]) {
      expect(await outboxOf(row?.id ?? "")).toEqual([
        "memberships.expire",
        "memberships.expiring",
      ]);
    }
    expect((await whoAmI(users.temp)).projectIds).toEqual([P1]);
  });

  test("once membershipExpiresAt has passed, accept is the uniform 404 (the body of an unknown token) and writes nothing: no membership, the invitation still pending (A1)", async () => {
    const email = newAddress();
    const { id } = await invite(users.owner, {
      email,
      roleId: roles.member,
      membershipExpiresAt: instant(2 * HOUR),
    });
    const token = await mint(id);
    const start = skew;
    try {
      // One minute past the end; an unknown token is the answer to compare with.
      skew = start + 2 * HOUR + 60_000;
      const unknown = await accept(
        users.late,
        email,
        invitationTokenOf("af-south-1", newInvitationSecret()),
      );
      expectProblem(unknown, 404, "invitation.unavailable");
      const late = await accept(users.late, email, token);
      expectProblem(late, 404, "invitation.unavailable");
      expect(uniformBody(late)).toEqual(uniformBody(unknown));
      expect(await orgRows(users.late)).toEqual([]);
      expect(await statusOf(id)).toBe("pending");
      expect(
        lines.some((l) => l.includes("membership_expired")),
        "the refusal's cause is logged for the operator",
      ).toBe(true);
    } finally {
      skew = start;
    }
    // Back before the end, the same token joins: the refusal changed nothing.
    const res = await accept(users.late, email, token);
    expect(res.statusCode, res.body).toBe(200);
    expect(await orgRows(users.late)).toHaveLength(1);
  });
});

describe("suspension and invitations across orgs", () => {
  test("a user suspended in org A accepts an invitation to org B and works there; they stay suspended in A (403), and an invitation to a project of A adds the row but does not lift the suspension", async () => {
    const [row] = await orgRows(users.suspended);
    const suspend = await call(
      users.owner,
      "POST",
      `${MEMBERS}/${row?.id ?? ""}/suspend`,
      { reason: "left the site" },
    );
    expect(suspend.statusCode, suspend.body).toBe(200);
    const emailB = newAddress();
    const inB = await invite(
      users.ownerB,
      { email: emailB, roleId: roles.memberB },
      ORG_B,
    );
    const joined = await accept(users.suspended, emailB, await mint(inB.id));
    expect(joined.statusCode, joined.body).toBe(200);
    expect(await orgRows(users.suspended, ORG_B)).toHaveLength(1);
    expect((await whoAmI(users.suspended, ORG_B)).projectIds).toEqual([]);
    expectProblem(
      await call(users.suspended, "GET", WHOAMI, undefined, { sid: "ext-a" }),
      403,
      "forbidden",
    );
    // An invitation to a project of A while suspended there.
    const emailA = newAddress();
    const inA = await invite(users.owner, {
      email: emailA,
      roleId: roles.member,
      projectId: P1,
      projectRoleId: roles.site_reader,
    });
    const again = await accept(users.suspended, emailA, await mint(inA.id));
    expect(again.statusCode, again.body).toBe(200);
    expect((await orgRows(users.suspended))[0]?.suspended).toBe(true);
    expectProblem(
      await call(users.suspended, "GET", WHOAMI, undefined, { sid: "ext-a2" }),
      403,
      "forbidden",
    );
  });
});
