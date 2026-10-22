// The access-grants module end to end (P5-06, ADR 0067; plan sections
// 2-3; Done-when DW3, DW5; owner conditions 2, 5, 6), against compose.yml's
// Postgres with the production journal, through the real app with the
// production grants source (seeded rows, test/support applyAccess) on a
// clock the tests move (tokens are issued at the same instant). A
// temporary elevation is one catalogue key at one scope for one user for
// a bounded window: POST /v1/access-grants (org.access_grant.grant.org;
// the granter holds every key they elevate at org scope, never elevates
// themselves, names a project for a project-level key and none for an
// org-level one; 60 s to ACCESS_GRANT_MAX_SECONDS; at most
// ACCESS_GRANTS_MAX_PER_USER open grants per user and org), GET
// /v1/access-grants (read; open rows newest first, cap 100), GET
// /v1/access-grants/:id, DELETE /v1/access-grants/:id (revoke only, no
// holdsAll: condition 5) and GET /v1/me/access-grants (own rows, no
// grant). Every write is one audit event in the org chain plus, in the
// same transaction, a users.mfa_check outbox row for the user and, at
// grant, an access_grants.expire row due at expires_at. Expiry is
// server-side at the instant: the key is gone on the next request after
// expires_at with no job involved. The reason text reaches the row and the
// audit event, never a log line (condition 6).
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import {
  type BootstrappedPostgres,
  appDatabase,
  exampleValue,
  startPostgres,
} from "@bricx/db-bootstrap/stack";
import { migrate } from "@bricx/db/migrate";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import {
  IDEMPOTENCY_KEY_HEADER,
  REPLAYED_HEADER,
} from "../../src/common/idempotency/decorator.js";
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
  owner: "0199e1a0-0000-7000-8000-000000000101",
  auditor: "0199e1a0-0000-7000-8000-000000000102",
  /** org.access_grant.grant.org and a few org keys, no finance key, no revoke. */
  granter: "0199e1a0-0000-7000-8000-000000000103",
  /** org.access_grant.read.org and .revoke.org only (condition 5). */
  revoker: "0199e1a0-0000-7000-8000-000000000104",
  /** An empty org role. */
  t1: "0199e1a0-0000-7000-8000-000000000105",
  /** An empty org role; the cap's subject. */
  t2: "0199e1a0-0000-7000-8000-000000000106",
  /** An empty org role; the list cap's subject (rows by SQL). */
  t3: "0199e1a0-0000-7000-8000-000000000107",
  /** An empty org role, project_manager on P1. */
  manager: "0199e1a0-0000-7000-8000-000000000108",
  ownerB: "0199e1a0-0000-7000-8000-000000000109",
  /** A user with no membership in org A. */
  outsider: "0199e1a0-0000-7000-8000-00000000010a",
  /** An empty org role; removed and re-invited (PR #71 review, amendment 2). */
  leaver: "0199e1a0-0000-7000-8000-00000000010b",
  /** An empty org role, assigned to P2 and unassigned (amendment 2). */
  mover: "0199e1a0-0000-7000-8000-00000000010c",
} as const;
const subOf = (user: string) => `grants-${user}`;
const GRANTS = "/v1/access-grants";
const ME = "/v1/me/access-grants";
const MEMBERS = "/v1/members";
const MEMBER_READ = "org.member.read.org";
const ROLE_READ = "org.role.read.org";
const BUDGET_APPROVE = "finance.budget.approve.project";
/** The capped app's ACCESS_GRANTS_MAX_PER_USER and ACCESS_GRANT_MAX_SECONDS. */
const GRANT_CAP = 2;
const MAX_SECONDS = 7_200;
/** The reason no log line may carry (condition 6). */
const REASON = "needle-7f3a: month-end close cover";

let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
let app: NestFastifyApplication;
const lines: string[] = [];
/** The instant the suite starts at (whole seconds); the clock moves forward only. */
const T0 = Math.floor(Date.now() / 1000) * 1000;
let at = T0;
const clock = { now: () => at };
const isoAt = (ms: number) => new Date(ms).toISOString();
const seconds = (n: number) => n * 1000;

let keyCounter = 0;
const newKey = () => {
  keyCounter += 1;
  return `grants-key-${String(keyCounter)}`;
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
  issuer.nowSeconds = () => Math.floor(clock.now() / 1000);
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
    orgId: ORG_B,
    userId: users.ownerB,
    role: "owner",
  });
  const granter = await seedRole(asAdmin, ORG_A, "granter");
  await grantKeys(granter, [
    "org.access_grant.read.org",
    "org.access_grant.grant.org",
    MEMBER_READ,
    ROLE_READ,
    "project.milestone.read.org",
  ]);
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.granter,
    role: "granter",
  });
  const revoker = await seedRole(asAdmin, ORG_A, "revoker");
  await grantKeys(revoker, [
    "org.access_grant.read.org",
    "org.access_grant.revoke.org",
  ]);
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.revoker,
    role: "revoker",
  });
  for (const user of [
    users.t1,
    users.t2,
    users.t3,
    users.manager,
    users.leaver,
    users.mover,
  ]) {
    await applyAccess(asAdmin, { orgId: ORG_A, userId: user, role: "member" });
  }
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
  app = await createApp(
    loadApiConfig(
      apiEnv({
        ...issuer.env(),
        DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
        ACCESS_GRANTS_MAX_PER_USER: String(GRANT_CAP),
        ACCESS_GRANT_MAX_SECONDS: String(MAX_SECONDS),
      }),
    ),
    {
      probes: fakeProbes(),
      revocationStore: fixedRevocations(),
      clock,
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
  method: "GET" | "POST" | "DELETE",
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

/** 422 validation_failed with exactly one issue at `path`. */
function expectInvalid(res: Res, path: readonly string[]) {
  expectProblem(res, 422, "validation_failed");
  expect(JSON.parse(res.body)).toMatchObject({
    issues: [{ path, code: "invalid_value", key: "validation:invalid_value" }],
  });
}

interface GrantBody {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly permission: string;
  readonly scopeId: string | null;
  readonly reason: string;
  readonly grantedBy: string;
  readonly startsAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly expiredAt: string | null;
  readonly active: boolean;
  readonly createdAt: string;
}
const GRANT_KEYS = [
  "active",
  "createdAt",
  "expiredAt",
  "expiresAt",
  "grantedBy",
  "id",
  "orgId",
  "permission",
  "reason",
  "revokedAt",
  "revokedBy",
  "scopeId",
  "startsAt",
  "userId",
];
const grantOf = (res: Res, status = 200): GrantBody => {
  expect(res.statusCode, res.body).toBe(status);
  const body = JSON.parse(res.body) as GrantBody;
  expect(Object.keys(body).sort()).toEqual(GRANT_KEYS);
  return body;
};
const listOf = (res: Res): GrantBody[] => {
  expect(res.statusCode, res.body).toBe(200);
  const body = JSON.parse(res.body) as { items: GrantBody[] };
  expect(Object.keys(body)).toEqual(["items"]);
  return body.items;
};

/** A grant request body for `userId`, one hour from the clock unless said. */
const request = (
  userId: string,
  permission: string,
  extra: Record<string, unknown> = {},
) => ({
  userId,
  permission,
  reason: REASON,
  expiresAt: isoAt(at + seconds(3_600)),
  ...extra,
});

interface AuditRow extends Record<string, unknown> {
  action: string;
  entity_type: string;
  actor_type: string;
  actor_id: string | null;
  org_id: string;
  before: unknown;
  after: unknown;
}
const auditOf = (entityId: string) =>
  asAdmin<AuditRow>(
    `SELECT action, entity_type, actor_type, actor_id::text, org_id::text, before, after
     FROM bricx.audit_events WHERE entity_id = $1 ORDER BY seq`,
    [entityId],
  );
const auditCount = () =>
  asAdmin<{ n: number }>(
    "SELECT count(*)::int AS n FROM bricx.audit_events WHERE org_id = $1",
    [ORG_A],
  ).then((rows) => rows[0]?.n);

interface OutboxRow extends Record<string, unknown> {
  topic: string;
  payload: unknown;
  not_before: string | null;
}
const outboxOf = (userId: string) =>
  asAdmin<OutboxRow>(
    `SELECT topic, payload, to_char(not_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS not_before
     FROM bricx.outbox WHERE payload->>'userId' = $1 ORDER BY id`,
    [userId],
  );
const outboxCount = () =>
  asAdmin<{ n: number }>(
    "SELECT count(*)::int AS n FROM bricx.outbox WHERE org_id = $1",
    [ORG_A],
  ).then((rows) => rows[0]?.n);

interface GrantDb extends Record<string, unknown> {
  id: string;
  user_id: string;
  permission: string;
  scope_id: string | null;
  reason: string;
  granted_by: string;
  revoked_by: string | null;
  revoked: boolean;
  expired: boolean;
}
const rowsOf = (userId: string) =>
  asAdmin<GrantDb>(
    `SELECT id::text, user_id::text, permission, scope_id::text, reason, granted_by::text, revoked_by::text,
            (revoked_at IS NOT NULL) AS revoked, (expired_at IS NOT NULL) AS expired
     FROM bricx.access_grants WHERE org_id = $1 AND user_id = $2 ORDER BY id`,
    [ORG_A, userId],
  );

const logged = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);

describe("POST /v1/access-grants (org.access_grant.grant.org, @Idempotent)", () => {
  test("201: the grant; one row, one org.access_grant.grant audit event with after (reason included), one access_grants.expire outbox row due at expires_at and one users.mfa_check row; a replay is byte-equal", async () => {
    const key = newKey();
    const body = request(users.t1, MEMBER_READ);
    const res = await call(users.granter, "POST", GRANTS, body, { key });
    const grant = grantOf(res, 201);
    expect(grant).toMatchObject({
      orgId: ORG_A,
      userId: users.t1,
      permission: MEMBER_READ,
      scopeId: null,
      reason: REASON,
      grantedBy: users.granter,
      startsAt: isoAt(at),
      expiresAt: body.expiresAt,
      revokedAt: null,
      revokedBy: null,
      expiredAt: null,
      active: true,
      createdAt: isoAt(at),
    });
    expect(await rowsOf(users.t1)).toEqual([
      {
        id: grant.id,
        user_id: users.t1,
        permission: MEMBER_READ,
        scope_id: null,
        reason: REASON,
        granted_by: users.granter,
        revoked_by: null,
        revoked: false,
        expired: false,
      },
    ]);
    expect(await auditOf(grant.id)).toEqual([
      {
        action: "org.access_grant.grant",
        entity_type: "org.access_grant",
        actor_type: "user",
        actor_id: users.granter,
        org_id: ORG_A,
        before: null,
        after: {
          userId: users.t1,
          permission: MEMBER_READ,
          scopeId: null,
          startsAt: isoAt(at),
          expiresAt: body.expiresAt,
          reason: REASON,
        },
      },
    ]);
    expect(await outboxOf(users.t1)).toEqual([
      {
        topic: "access_grants.expire",
        payload: { grantId: grant.id, userId: users.t1 },
        not_before: body.expiresAt,
      },
      {
        topic: "users.mfa_check",
        payload: { userId: users.t1 },
        not_before: null,
      },
    ]);
    const replay = await call(users.granter, "POST", GRANTS, body, { key });
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toBe(res.body);
    expect(replay.headers[REPLAYED_HEADER]).toBe("true");
    expect(await rowsOf(users.t1)).toHaveLength(1);
  });

  test("the elevated member holds the key on the next request and loses it at expires_at with no job involved (server-side expiry); the row is still open until the worker records it", async () => {
    expect((await call(users.t1, "GET", MEMBERS)).statusCode).toBe(200);
    const short = grantOf(
      await call(
        users.owner,
        "POST",
        GRANTS,
        request(users.t1, ROLE_READ, { expiresAt: isoAt(at + seconds(60)) }),
      ),
      201,
    );
    expect(short.expiresAt).toBe(isoAt(at + seconds(60)));
    expect((await call(users.t1, "GET", "/v1/roles")).statusCode).toBe(200);
    at += seconds(59);
    expect((await call(users.t1, "GET", "/v1/roles")).statusCode).toBe(200);
    at += seconds(1);
    expectProblem(await call(users.t1, "GET", "/v1/roles"), 403, "forbidden");
    expect(
      grantOf(await call(users.owner, "GET", `${GRANTS}/${short.id}`)),
    ).toMatchObject({ active: false, expiredAt: null, revokedAt: null });
    // The hour-long grant still stands.
    expect((await call(users.t1, "GET", MEMBERS)).statusCode).toBe(200);
  });

  test("a future startsAt: not active until then, then active; startsAt defaults to now", async () => {
    const start = at + seconds(120);
    const grant = grantOf(
      await call(
        users.owner,
        "POST",
        GRANTS,
        request(users.t1, "org.session.read.org", {
          startsAt: isoAt(start),
          expiresAt: isoAt(start + seconds(60)),
        }),
      ),
      201,
    );
    expect(grant).toMatchObject({ startsAt: isoAt(start), active: false });
    const sessions = `/v1/users/${users.t2}/sessions`;
    expectProblem(await call(users.t1, "GET", sessions), 403, "forbidden");
    at = start;
    expect(
      grantOf(await call(users.owner, "GET", `${GRANTS}/${grant.id}`)).active,
    ).toBe(true);
    expect((await call(users.t1, "GET", sessions)).statusCode).toBe(200);
    at = start + seconds(60);
  });

  test("escalation (holdsAll): a key the granter does not hold at org scope is 403 with one grants.escalation line naming it; nothing written; the owner grants it", async () => {
    lines.length = 0;
    const audits = await auditCount();
    const outbox = await outboxCount();
    expectProblem(
      await call(
        users.granter,
        "POST",
        GRANTS,
        request(users.manager, BUDGET_APPROVE, { scopeId: P1 }),
      ),
      403,
      "forbidden",
    );
    expect(await rowsOf(users.manager)).toEqual([]);
    expect(await auditCount()).toBe(audits);
    expect(await outboxCount()).toBe(outbox);
    const escalations = logged().filter(
      (l) => l["msg"] === "grants.escalation",
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]).toMatchObject({
      userId: users.granter,
      orgId: ORG_A,
      key: BUDGET_APPROVE,
    });
    const grant = grantOf(
      await call(
        users.owner,
        "POST",
        GRANTS,
        request(users.manager, BUDGET_APPROVE, { scopeId: P1 }),
      ),
      201,
    );
    expect(grant).toMatchObject({ scopeId: P1, grantedBy: users.owner });
    expect(await outboxOf(users.manager)).toEqual([
      expect.objectContaining({ topic: "access_grants.expire" }),
      expect.objectContaining({ topic: "users.mfa_check" }),
    ]);
  });

  test("self-grant is 422 at userId (requester ≠ approver), even for the owner", async () => {
    expectInvalid(
      await call(users.owner, "POST", GRANTS, request(users.owner, ROLE_READ)),
      ["userId"],
    );
    expectInvalid(
      await call(
        users.granter,
        "POST",
        GRANTS,
        request(users.granter, ROLE_READ),
      ),
      ["userId"],
    );
    expect(await rowsOf(users.owner)).toEqual([]);
  });

  test("scope (D-B): a project-level key needs a scopeId, an org-level key refuses one, an org key on a project-level resource is refused, site and own keys are refused, an unknown key is refused", async () => {
    const owner = (body: unknown) => call(users.owner, "POST", GRANTS, body);
    expectInvalid(await owner(request(users.manager, BUDGET_APPROVE)), [
      "scopeId",
    ]);
    expectInvalid(
      await owner(request(users.manager, ROLE_READ, { scopeId: P1 })),
      ["scopeId"],
    );
    expectInvalid(
      await owner(request(users.manager, "project.project.read.org")),
      ["permission"],
    );
    expectInvalid(
      await owner(
        request(users.manager, "field.dailylog.read.site", { scopeId: P1 }),
      ),
      ["permission"],
    );
    expectInvalid(
      await owner(request(users.manager, "field.dailylog.create.own")),
      ["permission"],
    );
    expectInvalid(await owner(request(users.manager, "nope.nope.nope.org")), [
      "permission",
    ]);
    expectInvalid(
      await owner(request(users.manager, BUDGET_APPROVE, { scopeId: "p1" })),
      ["scopeId"],
    );
  });

  test("duration (D-C): under 60 s, over ACCESS_GRANT_MAX_SECONDS, or ending before it starts is 422 at expiresAt; startsAt over 30 days ahead is 422 at startsAt", async () => {
    const owner = (extra: Record<string, unknown>) =>
      call(users.owner, "POST", GRANTS, request(users.t2, ROLE_READ, extra));
    expectInvalid(await owner({ expiresAt: isoAt(at + seconds(59)) }), [
      "expiresAt",
    ]);
    expectInvalid(
      await owner({ expiresAt: isoAt(at + seconds(MAX_SECONDS + 1)) }),
      ["expiresAt"],
    );
    expectInvalid(await owner({ expiresAt: isoAt(at - seconds(60)) }), [
      "expiresAt",
    ]);
    expectInvalid(
      await owner({
        startsAt: isoAt(at + seconds(30 * 86_400 + 1)),
        expiresAt: isoAt(at + seconds(30 * 86_400 + 61)),
      }),
      ["startsAt"],
    );
    expect(await rowsOf(users.t2)).toEqual([]);
    // Exactly 60 s and exactly the maximum are accepted.
    grantOf(await owner({ expiresAt: isoAt(at + seconds(60)) }), 201);
    grantOf(await owner({ expiresAt: isoAt(at + seconds(MAX_SECONDS)) }), 201);
  });

  test("the cap (ACCESS_GRANTS_MAX_PER_USER): one more open grant is 409 request.conflict with nothing written; a grant that ended by time frees its place", async () => {
    expect((await rowsOf(users.t2)).length).toBe(GRANT_CAP);
    const audits = await auditCount();
    expectProblem(
      await call(users.owner, "POST", GRANTS, request(users.t2, MEMBER_READ)),
      409,
      "request.conflict",
    );
    expect(await auditCount()).toBe(audits);
    expect(await rowsOf(users.t2)).toHaveLength(GRANT_CAP);
    // The 60 s grant ends by time: a place is free (the row is not yet marked expired).
    at += seconds(60);
    grantOf(
      await call(users.owner, "POST", GRANTS, request(users.t2, MEMBER_READ)),
      201,
    );
    expect(await rowsOf(users.t2)).toHaveLength(GRANT_CAP + 1);
  });

  test("the user must hold an open membership in the org (409), and in the project for a project scope (409); an unknown user is 404; an auditor is 403; no token 401; no Idempotency-Key 400", async () => {
    expectProblem(
      await call(
        users.owner,
        "POST",
        GRANTS,
        request(users.outsider, ROLE_READ),
      ),
      409,
      "request.conflict",
    );
    expectProblem(
      await call(
        users.owner,
        "POST",
        GRANTS,
        request(users.t1, BUDGET_APPROVE, { scopeId: P1 }),
      ),
      409,
      "request.conflict",
    );
    expectProblem(
      await call(
        users.owner,
        "POST",
        GRANTS,
        request(users.manager, BUDGET_APPROVE, { scopeId: P2 }),
      ),
      409,
      "request.conflict",
    );
    expectProblem(
      await call(users.owner, "POST", GRANTS, request(seedId(), ROLE_READ)),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.auditor, "POST", GRANTS, request(users.t1, ROLE_READ)),
      403,
      "forbidden",
    );
    expectProblem(
      await call(users.revoker, "POST", GRANTS, request(users.t1, ROLE_READ)),
      403,
      "forbidden",
    );
    expectProblem(
      await call(undefined, "POST", GRANTS, request(users.t1, ROLE_READ)),
      401,
      "unauthenticated",
    );
    expectProblem(
      await call(users.owner, "POST", GRANTS, request(users.t1, ROLE_READ), {
        key: null,
      }),
      400,
      "idempotency.key_missing",
    );
  });

  test("an invalid body is 422: an empty reason, a reason over 500 characters, an unknown field, a malformed userId", async () => {
    const owner = (body: unknown) => call(users.owner, "POST", GRANTS, body);
    expectInvalid(await owner(request(users.t1, ROLE_READ, { reason: "" })), [
      "reason",
    ]);
    expectInvalid(
      await owner(request(users.t1, ROLE_READ, { reason: "x".repeat(501) })),
      ["reason"],
    );
    expectProblem(
      await owner(request(users.t1, ROLE_READ, { extra: 1 })),
      422,
      "validation_failed",
    );
    expectInvalid(await owner(request("t1", ROLE_READ)), ["userId"]);
  });
});

describe("GET /v1/access-grants and /:id (org.access_grant.read.org)", () => {
  test("the owner lists the org's open grants (not revoked, not ended at the clock) newest first; ?userId= filters; the auditor and the revoker read; a member is 403", async () => {
    const items = listOf(await call(users.owner, "GET", GRANTS));
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((g) => g.orgId === ORG_A)).toBe(true);
    expect(items.every((g) => g.revokedAt === null)).toBe(true);
    expect(items.every((g) => Date.parse(g.expiresAt) > at)).toBe(true);
    expect(items.map((g) => g.id)).toEqual(
      [...items.map((g) => g.id)].sort().reverse(),
    );
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(GRANT_KEYS);
    }
    const t1 = listOf(
      await call(users.owner, "GET", `${GRANTS}?userId=${users.t1}`),
    );
    expect(t1.length).toBeGreaterThan(0);
    expect(t1.every((g) => g.userId === users.t1)).toBe(true);
    expect(listOf(await call(users.auditor, "GET", GRANTS))).toEqual(items);
    expect(listOf(await call(users.revoker, "GET", GRANTS))).toEqual(items);
    expectProblem(await call(users.t1, "GET", GRANTS), 403, "forbidden");
    expectProblem(
      await call(users.owner, "GET", `${GRANTS}?userId=nope`),
      422,
      "validation_failed",
    );
  });

  test("at most 100 rows are listed, newest first (rows by SQL)", async () => {
    await asAdmin(
      `INSERT INTO bricx.access_grants (id, org_id, user_id, permission, scope_id, reason, granted_by, starts_at, expires_at, created_at)
       SELECT ('0199e1a8-0000-7000-8000-' || lpad(to_hex(n), 12, '0'))::uuid, $1, $2, $3, NULL, 'seed', $4, $5::timestamptz, $5::timestamptz + interval '1 hour', $5::timestamptz
       FROM generate_series(1, 101) AS n`,
      [ORG_A, users.t3, ROLE_READ, users.owner, isoAt(at)],
    );
    const items = listOf(
      await call(users.owner, "GET", `${GRANTS}?userId=${users.t3}`),
    );
    expect(items).toHaveLength(100);
    expect(items[0]?.id).toBe("0199e1a8-0000-7000-8000-000000000065");
    expect(items.map((g) => g.id)).not.toContain(
      "0199e1a8-0000-7000-8000-000000000001",
    );
  });

  test("one grant by id; another org's grant is 404 (RLS), as is an unknown or malformed id", async () => {
    const [first] = listOf(await call(users.owner, "GET", GRANTS));
    expect(first).toBeDefined();
    if (first === undefined) return;
    expect(
      grantOf(await call(users.owner, "GET", `${GRANTS}/${first.id}`)),
    ).toEqual(first);
    expectProblem(
      await call(users.ownerB, "GET", `${GRANTS}/${first.id}`, undefined, {
        org: ORG_B,
      }),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.owner, "GET", `${GRANTS}/${seedId()}`),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.owner, "GET", `${GRANTS}/nope`),
      422,
      "validation_failed",
    );
  });
});

describe("DELETE /v1/access-grants/:id (org.access_grant.revoke.org only, condition 5)", () => {
  test("the revoker, who holds no finance key, revokes the owner's finance grant: 204; revoked_at/by set, one org.access_grant.revoke audit event with before and after, one users.mfa_check row; the member loses the key at once; sessions stay (D-D)", async () => {
    const [grant] = (await rowsOf(users.manager)).filter((g) => !g.revoked);
    expect(grant).toBeDefined();
    if (grant === undefined) return;
    expect(grant.permission).toBe(BUDGET_APPROVE);
    const before = await outboxOf(users.manager);
    const res = await call(users.revoker, "DELETE", `${GRANTS}/${grant.id}`);
    expect(res.statusCode, res.body).toBe(204);
    expect(res.body).toBe("");
    expect(
      (await rowsOf(users.manager)).find((g) => g.id === grant.id),
    ).toMatchObject({
      revoked: true,
      revoked_by: users.revoker,
      expired: false,
    });
    const events = await auditOf(grant.id);
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      action: "org.access_grant.revoke",
      entity_type: "org.access_grant",
      actor_type: "user",
      actor_id: users.revoker,
      org_id: ORG_A,
      before: { revokedAt: null, revokedBy: null },
      after: { revokedAt: isoAt(at), revokedBy: users.revoker },
    });
    expect(await outboxOf(users.manager)).toEqual([
      ...before,
      {
        topic: "users.mfa_check",
        payload: { userId: users.manager },
        not_before: null,
      },
    ]);
    expect(
      grantOf(await call(users.owner, "GET", `${GRANTS}/${grant.id}`)),
    ).toMatchObject({
      active: false,
      revokedAt: isoAt(at),
      revokedBy: users.revoker,
    });
    // The manager's own token still works (sessions are not revoked).
    expect(
      (await call(users.manager, "GET", "/v1/me/memberships")).statusCode,
    ).toBe(200);
    // Revoked rows are not listed.
    expect(
      listOf(
        await call(users.owner, "GET", `${GRANTS}?userId=${users.manager}`),
      ),
    ).toEqual([]);
  });

  test("revoking again is 409; the granter (grant, no revoke) and the auditor are 403; another org's grant and an unknown id are 404", async () => {
    const [grant] = await rowsOf(users.manager);
    expect(grant).toBeDefined();
    if (grant === undefined) return;
    expectProblem(
      await call(users.revoker, "DELETE", `${GRANTS}/${grant.id}`),
      409,
      "request.conflict",
    );
    const [open] = (await rowsOf(users.t1)).filter((g) => !g.revoked);
    expect(open).toBeDefined();
    if (open === undefined) return;
    expectProblem(
      await call(users.granter, "DELETE", `${GRANTS}/${open.id}`),
      403,
      "forbidden",
    );
    expectProblem(
      await call(users.auditor, "DELETE", `${GRANTS}/${open.id}`),
      403,
      "forbidden",
    );
    expectProblem(
      await call(users.ownerB, "DELETE", `${GRANTS}/${open.id}`, undefined, {
        org: ORG_B,
      }),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.owner, "DELETE", `${GRANTS}/${seedId()}`),
      404,
      "not_found",
    );
    expect(
      (await rowsOf(users.t1)).find((g) => g.id === open.id)?.revoked,
    ).toBe(false);
  });

  test("the elevated member's key is gone on the next request after the revoke (t1: org.member.read)", async () => {
    expect((await call(users.t1, "GET", MEMBERS)).statusCode).toBe(200);
    const [open] = (await rowsOf(users.t1)).filter(
      (g) => !g.revoked && g.permission === MEMBER_READ,
    );
    expect(open).toBeDefined();
    if (open === undefined) return;
    expect(
      (await call(users.owner, "DELETE", `${GRANTS}/${open.id}`)).statusCode,
    ).toBe(204);
    expectProblem(await call(users.t1, "GET", MEMBERS), 403, "forbidden");
  });
});

describe("GET /v1/me/access-grants (own rows, no grant needed)", () => {
  test("the caller's active grants with expiresAt, newest first; revoked and ended rows left out; empty for a user without any; 401 without a token", async () => {
    const grant = grantOf(
      await call(users.owner, "POST", GRANTS, request(users.t1, ROLE_READ)),
      201,
    );
    const mine = listOf(await call(users.t1, "GET", ME));
    expect(mine.map((g) => g.id)).toEqual([grant.id]);
    expect(mine[0]).toMatchObject({
      permission: ROLE_READ,
      expiresAt: grant.expiresAt,
      active: true,
    });
    expect(listOf(await call(users.manager, "GET", ME))).toEqual([]);
    expect(listOf(await call(users.auditor, "GET", ME))).toEqual([]);
    expectProblem(await call(undefined, "GET", ME), 401, "unauthenticated");
    // Own rows only: the owner sees none of t1's through /me.
    expect(listOf(await call(users.owner, "GET", ME))).toEqual([]);
  });
});

describe("removal ends elevations (PR #71 review, amendment 2, ADR 0067)", () => {
  const PROJECT_MEMBER_READ = "project.member.read.project";
  const P2_MEMBERS = `/v1/projects/${P2}/members`;
  const idOfMember = async (userId: string): Promise<string> => {
    const res = await call(users.owner, "GET", MEMBERS);
    expect(res.statusCode, res.body).toBe(200);
    const body = JSON.parse(res.body) as {
      items: { id: string; userId: string }[];
    };
    const row = body.items.find((m) => m.userId === userId);
    expect(row).toBeDefined();
    return row?.id ?? "";
  };
  const mfaChecks = async (userId: string) =>
    (await outboxOf(userId)).filter((r) => r.topic === "users.mfa_check")
      .length;

  test("remove(): every open elevation of the user in the org (active and pending) is revoked by the remover in the same transaction, one org.access_grant.revoke event each, one users.mfa_check; re-invited inside the window, the user holds no elevated key", async () => {
    const active = grantOf(
      await call(users.owner, "POST", GRANTS, request(users.leaver, ROLE_READ)),
      201,
    );
    const pending = grantOf(
      await call(
        users.owner,
        "POST",
        GRANTS,
        request(users.leaver, MEMBER_READ, {
          startsAt: isoAt(at + seconds(120)),
        }),
      ),
      201,
    );
    expect((await call(users.leaver, "GET", "/v1/roles")).statusCode).toBe(200);
    const checksBefore = await mfaChecks(users.leaver);

    const membership = await idOfMember(users.leaver);
    const removed = await call(
      users.owner,
      "DELETE",
      `${MEMBERS}/${membership}`,
    );
    expect(removed.statusCode, removed.body).toBe(204);

    expect(await rowsOf(users.leaver)).toEqual(
      [active, pending].map((g) =>
        expect.objectContaining({
          id: g.id,
          revoked: true,
          revoked_by: users.owner,
          expired: false,
        }),
      ),
    );
    for (const g of [active, pending]) {
      const events = (await auditOf(g.id)).filter(
        (e) => e.action === "org.access_grant.revoke",
      );
      expect(events).toEqual([
        expect.objectContaining({
          entity_type: "org.access_grant",
          actor_type: "user",
          actor_id: users.owner,
          org_id: ORG_A,
          before: { revokedAt: null, revokedBy: null },
          after: expect.objectContaining({
            revokedBy: users.owner,
            cause: "org.member.remove",
          }),
        }),
      ]);
    }
    expect(await mfaChecks(users.leaver)).toBe(checksBefore + 1);

    // Re-invited at once (inside both windows): no elevated key comes back.
    const invited = await call(users.owner, "POST", MEMBERS, {
      userId: users.leaver,
      roleId: await seedRole(asAdmin, ORG_A, "member"),
    });
    expect(invited.statusCode, invited.body).toBe(201);
    expectProblem(
      await call(users.leaver, "GET", "/v1/roles"),
      403,
      "forbidden",
    );
    at += seconds(120);
    expectProblem(await call(users.leaver, "GET", MEMBERS), 403, "forbidden");
    expect(listOf(await call(users.leaver, "GET", ME))).toEqual([]);
  });

  test("unassign(): the user's open elevations scoped to that project are revoked (the org elevation stands), one event each, one users.mfa_check; re-assigned, the user holds no elevated project key", async () => {
    const emptyRole = await seedRole(asAdmin, ORG_A, "empty_project");
    const assigned = await call(users.owner, "POST", P2_MEMBERS, {
      userId: users.mover,
      roleId: emptyRole,
    });
    expect(assigned.statusCode, assigned.body).toBe(201);
    const assignment = (JSON.parse(assigned.body) as { id: string }).id;
    const projectGrant = grantOf(
      await call(
        users.owner,
        "POST",
        GRANTS,
        request(users.mover, PROJECT_MEMBER_READ, { scopeId: P2 }),
      ),
      201,
    );
    const orgGrant = grantOf(
      await call(users.owner, "POST", GRANTS, request(users.mover, ROLE_READ)),
      201,
    );
    expect((await call(users.mover, "GET", P2_MEMBERS)).statusCode).toBe(200);
    const checksBefore = await mfaChecks(users.mover);

    const unassigned = await call(
      users.owner,
      "DELETE",
      `${P2_MEMBERS}/${assignment}`,
    );
    expect(unassigned.statusCode, unassigned.body).toBe(204);

    const rows = await rowsOf(users.mover);
    expect(rows.find((g) => g.id === projectGrant.id)).toMatchObject({
      revoked: true,
      revoked_by: users.owner,
    });
    expect(rows.find((g) => g.id === orgGrant.id)).toMatchObject({
      revoked: false,
      revoked_by: null,
    });
    expect(
      (await auditOf(projectGrant.id)).filter(
        (e) => e.action === "org.access_grant.revoke",
      ),
    ).toEqual([
      expect.objectContaining({
        actor_id: users.owner,
        before: { revokedAt: null, revokedBy: null },
        after: expect.objectContaining({
          revokedBy: users.owner,
          cause: "project.member.unassign",
        }),
      }),
    ]);
    expect((await auditOf(orgGrant.id)).map((e) => e.action)).not.toContain(
      "org.access_grant.revoke",
    );
    expect(await mfaChecks(users.mover)).toBe(checksBefore + 1);

    const again = await call(users.owner, "POST", P2_MEMBERS, {
      userId: users.mover,
      roleId: emptyRole,
    });
    expect(again.statusCode, again.body).toBe(201);
    expectProblem(await call(users.mover, "GET", P2_MEMBERS), 403, "forbidden");
    // The org elevation was not scoped to the project: it still works.
    expect((await call(users.mover, "GET", "/v1/roles")).statusCode).toBe(200);
  });
});

describe("the reason never reaches a log line (condition 6)", () => {
  test("no captured line carries the reason, after grants, refusals and revokes", () => {
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("\n")).not.toContain("needle-7f3a");
    expect(lines.join("\n")).not.toContain(REASON);
  });
});

describe("the configured bounds", () => {
  test(".env.example documents the defaults: 20 open grants per user, 86400 s", () => {
    expect(exampleValue("ACCESS_GRANTS_MAX_PER_USER")).toBe("20");
    expect(exampleValue("ACCESS_GRANT_MAX_SECONDS")).toBe("86400");
  });
});
