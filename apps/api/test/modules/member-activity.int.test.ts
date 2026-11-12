// P6-06b (ADR 0084; Done-when DW17; owner answer Q7, additions A3, A4),
// against compose.yml's Postgres with the production journal, through the
// real app: GET /v1/members/:id/activity (org.audit.read.org).
// - the events are the member's inside THIS org: what they did (actor)
//   and what was done to their org and project memberships; a user who is
//   a member of two orgs never crosses (A4: matched by user id inside the
//   org_id filter, as bricx_app under RLS; the reader applies that filter
//   itself, checked directly, so RLS is not the only barrier);
// - a fixed projection: seq, time, action, subject, ids, byMember; never
//   before/after, a reason, an address, a token, a device or a location
//   (sentinels planted in the events' payloads never appear);
// - paginated by seq, newest first: limit 1..100 (default 50), cursor =
//   the last seq; pages chain without a gap or a repeat;
// - permission-checked: 403 without org.audit.read (a member admin, the
//   member themself), 404 for an unknown id and for another org's
//   membership; a removed membership's history is still readable.
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
import { openDatabase } from "@bricx/db/database";
import { migrate } from "@bricx/db/migrate";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import { AuditActivityReader } from "../../src/modules/audit/activity.reader.js";
import { IDEMPOTENCY_KEY_HEADER } from "../../src/common/idempotency/decorator.js";
import { MemberActivity } from "../../src/modules/memberships/memberships.dto.js";
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
const ORG_A = "0199e1b2-0000-7000-8000-0000000000a1";
const ORG_B = "0199e1b2-0000-7000-8000-0000000000b1";
const P1 = "0199e1b2-0000-7000-8000-0000000000a3";
const users = {
  owner: "0199e1b2-0000-7000-8000-0000000000f1",
  ownerB: "0199e1b2-0000-7000-8000-0000000000f2",
  auditor: "0199e1b2-0000-7000-8000-0000000000f3",
  admin: "0199e1b2-0000-7000-8000-0000000000f4",
  both: "0199e1b2-0000-7000-8000-0000000000f5",
  quiet: "0199e1b2-0000-7000-8000-0000000000f6",
  leaver: "0199e1b2-0000-7000-8000-0000000000f7",
} as const;
const subOf = (user: string) => `activity-${user}`;
const MEMBERS = "/v1/members";
const INVITATIONS = "/v1/invitations";
const activityOf = (id: string, query = "") =>
  `${MEMBERS}/${id}/activity${query}`;
/** Planted in event payloads; none may come back. */
const REASON = "needle-6b17: reason text";
const ADDRESS_A = "needle-6b17-a@activity.example";
const ADDRESS_B = "needle-6b17-b@activity.example";
const MEMBER_ADMIN_KEYS = [
  "org.member.read.org",
  "org.member.invite.org",
  "org.member.update.org",
  "org.member.remove.org",
  "project.member.read.org",
  "project.member.assign.org",
];

let pg18: BootstrappedPostgres;
let valkey: StartedValkey;
let issuer: TestIssuer;
let app: NestFastifyApplication;
const roles: Record<string, string> = {};
/** `both`'s membership id in each org; the quiet member's and the leaver's in A. */
const ids: Record<string, string> = {};

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

type Res = Awaited<ReturnType<NestFastifyApplication["inject"]>>;
let keys = 0;
async function call(
  user: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
  org = ORG_A,
  sid = `activity-${user}-${org}`,
): Promise<Res> {
  const headers: Record<string, string> = bearer(
    await issuer.token({
      sub: subOf(user),
      org_id: org,
      acr: "mfa",
      sid,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    }),
  );
  if (method === "POST") {
    keys += 1;
    headers[IDEMPOTENCY_KEY_HEADER] = `activity-key-${String(keys)}`;
  }
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.inject({
    method,
    url,
    headers,
    ...(body === undefined ? {} : { payload: JSON.stringify(body) }),
  });
}
const ok = (res: Res, status = 200) => {
  expect(res.statusCode, res.body).toBe(status);
  return JSON.parse(res.body === "" ? "{}" : res.body) as Record<
    string,
    unknown
  >;
};
function expectProblem(res: Res, status: number, code: string) {
  expect(res.statusCode, res.body).toBe(status);
  const parsed = ErrorEnvelopeSchema.safeParse(JSON.parse(res.body));
  expect(parsed.success).toBe(true);
  expect(parsed.data).toMatchObject({ status, code });
}
const membershipOf = async (user: string, org: string) => {
  const [row] = await asAdmin<{ id: string }>(
    "SELECT id::text FROM bricx.memberships WHERE org_id = $1 AND user_id = $2 ORDER BY id DESC LIMIT 1",
    [org, user],
  );
  if (row === undefined) throw new Error("no membership");
  return row.id;
};
async function page(user: string, id: string, query = "", org = ORG_A) {
  const res = await call(user, "GET", activityOf(id, query), undefined, org);
  expect(res.statusCode, res.body).toBe(200);
  return {
    body: res.body,
    ...MemberActivity.schema.parse(JSON.parse(res.body)),
  };
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
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.auditor,
    role: "auditor",
  });
  for (const org of [ORG_A, ORG_B]) {
    const admin = await seedRole(asAdmin, org, "memberadmin");
    for (const permission of MEMBER_ADMIN_KEYS) {
      await asAdmin(
        `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
         VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
        [seedId(), org, admin, permission],
      );
    }
    roles[`member:${org}`] = await seedRole(asAdmin, org, "member");
    roles[`memberadmin:${org}`] = admin;
  }
  // `both`: a member admin in A and in B. admin: a member admin in A.
  for (const [org, user] of [
    [ORG_A, users.both],
    [ORG_B, users.both],
    [ORG_A, users.admin],
  ] as const) {
    await applyAccess(asAdmin, {
      orgId: org,
      userId: user,
      role: "memberadmin",
    });
  }
  for (const user of [users.quiet, users.leaver]) {
    await applyAccess(asAdmin, { orgId: ORG_A, userId: user, role: "member" });
  }
  await seedProjects(asAdmin, ORG_A, [P1]);
  ids.bothA = await membershipOf(users.both, ORG_A);
  ids.bothB = await membershipOf(users.both, ORG_B);
  ids.quiet = await membershipOf(users.quiet, ORG_A);
  ids.leaver = await membershipOf(users.leaver, ORG_A);
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
      logStream: new Writable({
        write(_chunk: Buffer, _encoding, done) {
          done();
        },
      }),
    },
  );
  await app.init();

  // What `both` does in A (actor): two invitations, a suspension of `quiet` and its end.
  ok(
    await call(users.both, "POST", INVITATIONS, {
      email: ADDRESS_A,
      roleId: roles[`member:${ORG_A}`],
    }),
    201,
  );
  ok(
    await call(users.both, "POST", `${MEMBERS}/${ids.quiet}/suspend`, {
      reason: REASON,
    }),
  );
  ok(await call(users.both, "POST", `${MEMBERS}/${ids.quiet}/reactivate`));
  // What is done to `both` in A: a project membership (assigned, suspended,
  // reactivated), then an org suspension and its end.
  const assigned = ok(
    await call(users.owner, "POST", `/v1/projects/${P1}/members`, {
      userId: users.both,
      roleId: roles[`member:${ORG_A}`],
    }),
    201,
  );
  ids.bothProject = String(assigned.id);
  for (const action of ["suspend", "reactivate"]) {
    ok(
      await call(
        users.owner,
        "POST",
        `/v1/projects/${P1}/members/${ids.bothProject}/${action}`,
        action === "suspend" ? { reason: REASON } : undefined,
      ),
    );
    ok(
      await call(
        users.owner,
        "POST",
        `${MEMBERS}/${ids.bothA}/${action}`,
        action === "suspend" ? { reason: REASON } : undefined,
      ),
    );
  }
  // What `both` does in B, and what is done to them there.
  ok(
    await call(
      users.both,
      "POST",
      INVITATIONS,
      { email: ADDRESS_B, roleId: roles[`member:${ORG_B}`] },
      ORG_B,
    ),
    201,
  );
  ok(
    await call(
      users.ownerB,
      "PATCH",
      `${MEMBERS}/${ids.bothB}`,
      { roleId: roles[`member:${ORG_B}`] },
      ORG_B,
    ),
  );
  // The leaver is removed.
  expect(
    (await call(users.owner, "DELETE", `${MEMBERS}/${ids.leaver}`)).statusCode,
  ).toBe(204);
}, HOOK_MS);
afterAll(async () => {
  await app.close().catch(() => undefined);
  await issuer.close();
  await valkey.stop();
  await pg18.container.stop();
}, HOOK_MS);

/** What the audit table holds for a user in an org, by the documented match (as the superuser). */
const expectedSeqs = (user: string, org: string) =>
  asAdmin<{ seq: string; actor: boolean }>(
    `SELECT e.seq::text, (e.actor_id = $2) IS TRUE AS actor
     FROM bricx.audit_events e
     WHERE e.org_id = $1 AND (
       e.actor_id = $2
       OR (e.entity_type = 'org.member' AND e.entity_id IN (SELECT id FROM bricx.memberships WHERE org_id = $1 AND user_id = $2))
       OR (e.entity_type = 'project.member' AND e.entity_id IN (SELECT id FROM bricx.project_memberships WHERE org_id = $1 AND user_id = $2)))
     ORDER BY e.seq DESC`,
    [org, user],
  );

describe("GET /v1/members/:id/activity (org.audit.read.org; DW17)", () => {
  test("an auditor reads what the member did and what was done to their memberships in this org, newest first, each event once; byMember tells the two apart", async () => {
    const expected = await expectedSeqs(users.both, ORG_A);
    const { items, nextCursor } = await page(users.auditor, ids.bothA ?? "");
    expect(nextCursor).toBeNull();
    expect(items.map((i) => i.seq)).toEqual(expected.map((e) => e.seq));
    expect(items.map((i) => i.byMember)).toEqual(expected.map((e) => e.actor));
    const actions = items.map((i) => `${i.action}:${String(i.byMember)}`);
    for (const wanted of [
      "org.invitation.create:true",
      "org.member.suspend:true",
      "org.member.reactivate:true",
      "project.member.assign:false",
      "project.member.suspend:false",
      "project.member.reactivate:false",
      "org.member.suspend:false",
      "org.member.reactivate:false",
    ]) {
      expect(actions).toContain(wanted);
    }
    // Done by them to someone else: the subject is the other membership.
    expect(
      items.find((i) => i.action === "org.member.suspend" && i.byMember)
        ?.entityId,
    ).toBe(ids.quiet);
    expect(new Set(items.map((i) => i.seq)).size).toBe(items.length);
    // The owner reads it too (the virtual owner bundle holds org.audit.read).
    expect(
      (await page(users.owner, ids.bothA ?? "")).items.map((i) => i.seq),
    ).toEqual(expected.map((e) => e.seq));
  });

  test("a fixed projection: only seq, occurredAt, action, entityType, entityId, actorType, byMember and correlationId; no reason, address, before/after, actor id, device or location, though the stored events carry them", async () => {
    const stored = await asAdmin<{ payload: string }>(
      "SELECT (coalesce(before::text, '') || coalesce(after::text, '')) AS payload FROM bricx.audit_events WHERE org_id = $1",
      [ORG_A],
    );
    // The sentinel is really in the stored payloads (the suspension reason).
    expect(stored.some((r) => r.payload.includes("needle-6b17"))).toBe(true);
    const { body, items } = await page(users.auditor, ids.bothA ?? "");
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(
        [
          "action",
          "actorType",
          "byMember",
          "correlationId",
          "entityId",
          "entityType",
          "occurredAt",
          "seq",
        ].sort(),
      );
    }
    for (const absent of [
      "needle-6b17",
      "activity.example",
      "before",
      "after",
      "reason",
      "actorId",
      users.owner,
      "ip",
      "device",
      "token",
    ]) {
      expect(body, absent).not.toContain(`"${absent}`);
      expect(body.includes("needle-6b17")).toBe(false);
    }
    expect(body).not.toContain(users.owner);
  });

  test("a user in two orgs never crosses (A4): org A's reader gets org A's events only, org B's owner gets org B's only, and neither set contains the other's subjects; the reader filters on the org itself, not only through RLS", async () => {
    const inA = await page(users.auditor, ids.bothA ?? "");
    const inB = await page(users.ownerB, ids.bothB ?? "", "", ORG_B);
    const expectedB = await expectedSeqs(users.both, ORG_B);
    expect(inB.items.map((i) => i.seq)).toEqual(expectedB.map((e) => e.seq));
    expect(inB.items.map((i) => i.action).sort()).toEqual(
      ["org.invitation.create", "org.member.update"].sort(),
    );
    const idsA = await asAdmin<{ id: string }>(
      "SELECT entity_id::text AS id FROM bricx.audit_events WHERE org_id = $1 AND entity_id IS NOT NULL",
      [ORG_A],
    );
    const idsB = await asAdmin<{ id: string }>(
      "SELECT entity_id::text AS id FROM bricx.audit_events WHERE org_id = $1 AND entity_id IS NOT NULL",
      [ORG_B],
    );
    const onlyA = new Set(idsA.map((r) => r.id));
    const onlyB = new Set(idsB.map((r) => r.id));
    expect(inB.items.every((i) => !onlyA.has(i.entityId ?? ""))).toBe(true);
    expect(inA.items.every((i) => !onlyB.has(i.entityId ?? ""))).toBe(true);
    // The reader's own org filter (A4), not only RLS: in a transaction of
    // org A, a subject naming org B finds nothing, although the same user
    // acted in org A (sabotage S23).
    const db = openDatabase({
      reveal: () => urlFor("bricx_app", "BRICX_APP_PASSWORD"),
    });
    try {
      const reader = new AuditActivityReader();
      const read = (orgId: string) =>
        db.withTx(
          { orgId: ORG_A, userId: users.auditor, projectIds: [] },
          (tx) =>
            reader.list(
              tx,
              {
                orgId,
                userId: users.both,
                orgMembershipIds: [],
                projectMembershipIds: [],
              },
              { limit: 100 },
            ),
        );
      expect((await read(ORG_A)).length).toBeGreaterThan(0);
      expect(await read(ORG_B)).toEqual([]);
    } finally {
      await db.close();
    }
    // The other org's membership id is not found, in either direction.
    expectProblem(
      await call(users.auditor, "GET", activityOf(ids.bothB ?? "")),
      404,
      "not_found",
    );
    expectProblem(
      await call(
        users.ownerB,
        "GET",
        activityOf(ids.bothA ?? ""),
        undefined,
        ORG_B,
      ),
      404,
      "not_found",
    );
  });

  test("paginated by seq: limit pages chain through nextCursor without a gap or a repeat and end with null; the default is 50; limit 0, 101, a word, a bad cursor or an unknown query field is 422", async () => {
    const all = (await page(users.auditor, ids.bothA ?? "")).items.map(
      (i) => i.seq,
    );
    expect(all.length).toBeGreaterThanOrEqual(8);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const next: Awaited<ReturnType<typeof page>> = await page(
        users.auditor,
        ids.bothA ?? "",
        `?limit=3${cursor === null ? "" : `&cursor=${cursor}`}`,
      );
      expect(next.items.length).toBeLessThanOrEqual(3);
      seen.push(...next.items.map((i) => i.seq));
      // The cursor is the last item's seq.
      if (next.nextCursor !== null) {
        expect(next.nextCursor).toBe(next.items.at(-1)?.seq);
        expect(next.items).toHaveLength(3);
      }
      cursor = next.nextCursor;
      pages += 1;
    } while (cursor !== null && pages < 20);
    expect(seen).toEqual(all);
    expect(pages).toBe(Math.ceil(all.length / 3));
    // An exact last page has no next cursor.
    const exact = await page(
      users.auditor,
      ids.bothA ?? "",
      `?limit=${String(all.length)}`,
    );
    expect(exact.nextCursor).toBeNull();
    // A cursor below everything: an empty page.
    expect(
      (await page(users.auditor, ids.bothA ?? "", "?cursor=1")).items.filter(
        (i) => BigInt(i.seq) >= 1n,
      ),
    ).toEqual([]);
    for (const query of [
      "?limit=0",
      "?limit=101",
      "?limit=ten",
      "?limit=-1",
      "?cursor=0",
      "?cursor=abc",
      "?cursor=1234567890123456789",
      "?offset=1",
    ]) {
      expectProblem(
        await call(users.auditor, "GET", activityOf(ids.bothA ?? "", query)),
        422,
        "validation_failed",
      );
    }
    expect(
      (await page(users.auditor, ids.bothA ?? "", "?limit=100")).items,
    ).toHaveLength(all.length);
  });

  test("permission-checked: a member admin without org.audit.read is 403, so is the member reading their own history; an unknown id is 404; a removed membership's history is still read", async () => {
    expectProblem(
      await call(users.admin, "GET", activityOf(ids.bothA ?? "")),
      403,
      "forbidden",
    );
    // A new sign-in: the suspension above ended their earlier session.
    expectProblem(
      await call(
        users.both,
        "GET",
        activityOf(ids.bothA ?? ""),
        undefined,
        ORG_A,
        "activity-both-again",
      ),
      403,
      "forbidden",
    );
    expectProblem(
      await call(users.auditor, "GET", activityOf(seedId())),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.auditor, "GET", activityOf("not-an-id")),
      422,
      "validation_failed",
    );
    const gone = await page(users.auditor, ids.leaver ?? "");
    expect(gone.items.map((i) => i.action)).toContain("org.member.remove");
    expect(gone.items.every((i) => !i.byMember)).toBe(true);
    // A member nothing happened to beyond what `both` did: those two events.
    const quiet = await page(users.auditor, ids.quiet ?? "");
    expect(quiet.items.map((i) => i.action)).toEqual([
      "org.member.reactivate",
      "org.member.suspend",
    ]);
  });
});
