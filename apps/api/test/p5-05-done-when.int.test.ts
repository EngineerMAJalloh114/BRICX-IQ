// P5-05 Done-when (ADR 0066; plan section 7), the cross-org items the
// module suites do not hold, through the real API, the production grants
// source and the real migrator, as the user `both`: a member of org A
// and an owner of org B, with one token per organisation (X-Org-Id).
// - DW8 (plan 6.1): a role edit and a membership removal in org A leave
//   the user's ability, memberships and open sessions in org B unchanged,
//   and org B's audit chain has no new row.
// - DW3 (plan 6.2): the removal closes the user's sessions in org A in
//   the same transaction: the next request there is refused at once (403
//   membership_missing, the guard reading the membership before the
//   session; well inside 1 s, the time printed) and is 200 in org B.
// Where the other Done-when items are proven:
// - DW1 tables, FORCE RLS, policies, FK seeding, migrator guard, nothing
//   synced: packages/db grants.int.test.ts, rls.int.test.ts, rls.test.ts.
// - DW2 roles: modules/roles.int.test.ts. DW3 memberships, last owner,
//   sessions and project rows closed: modules/memberships.int.test.ts.
// - DW4 overrides validated, the ability holds exactly the effective
//   keys: modules/memberships.int.test.ts, grants-source.int.test.ts.
// - DW5 DbGrantsSource in production, the template on seeded rows:
//   grants-source.int.test.ts, modules/_template, scripts/new-module.mjs
//   --selftest. DW6 org selection, the three refusals, /v1/me/memberships:
//   auth.test.ts, grants-source.int.test.ts, memberships.int.test.ts.
// - DW7 bricx-mfa live: apps/worker test/mfa.int.test.ts.
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
import { createApp } from "../src/app.js";
import { IDEMPOTENCY_KEY_HEADER } from "../src/common/idempotency/decorator.js";
import { MyMembershipList } from "../src/modules/memberships/memberships.dto.js";
import { Role, RoleList } from "../src/modules/roles/roles.dto.js";
import { apiEnv } from "./env.js";
import { fakeProbes } from "./probes.js";
import {
  TestIssuer,
  applyAccess,
  bearer,
  fixedRevocations,
  seedId,
  seedRole,
  seedUsers,
} from "./support/auth.js";

const HOOK_MS = 300_000;
const ORG_A = "0199e1a0-0000-7000-8000-0000000000c1";
const ORG_B = "0199e1a0-0000-7000-8000-0000000000c2";
const users = {
  ownerA: "0199e1a0-0000-7000-8000-0000000000e1",
  both: "0199e1a0-0000-7000-8000-0000000000e2",
} as const;
const subOf = (user: string) => `done-when-${user}`;
const MILESTONE_READ = "project.milestone.read.org";
const MILESTONE_CREATE = "project.milestone.create.org";

let pg18: BootstrappedPostgres;
let issuer: TestIssuer;
let app: NestFastifyApplication;
const lines: string[] = [];
/** The custom role of org A the user `both` holds. */
let viewerA = "";

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
    userId: users.ownerA,
    role: "owner",
  });
  viewerA = await seedRole(asAdmin, ORG_A, "viewer_a");
  await asAdmin(
    `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
     VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
    [seedId(), ORG_A, viewerA, MILESTONE_READ],
  );
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.both,
    role: "viewer_a",
  });
  await applyAccess(asAdmin, {
    orgId: ORG_B,
    userId: users.both,
    role: "owner",
  });
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
/** A request as `user` in `org` (X-Org-Id; the claim names org A for everyone). */
async function call(
  user: string,
  org: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
): Promise<Res> {
  const headers: Record<string, string> = {
    ...bearer(
      await issuer.token({
        sub: subOf(user),
        org_id: ORG_A,
        exp: Math.floor(Date.now() / 1000) + 3_600,
      }),
    ),
    "x-org-id": org,
  };
  if (method === "POST") headers[IDEMPOTENCY_KEY_HEADER] = seedId();
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

/** What the user can do and see in org B: the roles list (owner), their memberships, open sessions. */
async function snapshotB() {
  const roles = await call(users.both, ORG_B, "GET", "/v1/roles");
  expect(roles.statusCode, roles.body).toBe(200);
  const me = await call(users.both, ORG_B, "GET", "/v1/me/memberships");
  expect(me.statusCode, me.body).toBe(200);
  const sessions = await asAdmin<{ id: string; revoked: boolean }>(
    `SELECT id::text, (revoked_at IS NOT NULL) AS revoked FROM bricx.sessions
     WHERE org_id = $1 AND user_id = $2 ORDER BY id`,
    [ORG_B, users.both],
  );
  const audit = await asAdmin<{ n: number }>(
    "SELECT count(*)::int AS n FROM bricx.audit_events WHERE org_id = $1",
    [ORG_B],
  );
  return {
    roles: RoleList.schema.parse(JSON.parse(roles.body)).items,
    memberships: MyMembershipList.schema
      .parse(JSON.parse(me.body))
      .items.filter((item) => item.orgId === ORG_B),
    sessions,
    auditRows: audit[0]?.n,
  };
}

const lastAuthFailure = () =>
  lines
    .map((l) => JSON.parse(l) as Record<string, unknown>)
    .filter((l) => l["msg"] === "auth.failed")
    .map((l) => l["reason"])
    .at(-1);

describe("DW8: cross-org safety (plan 6.1)", () => {
  test("a role edit and a membership removal in org A leave the user's ability, memberships, sessions and audit chain in org B unchanged; org A refuses the user at once (DW3, plan 6.2)", async () => {
    // Org A as well as org B answer the user before the change: a session in each.
    const meA = await call(users.both, ORG_A, "GET", "/v1/me/memberships");
    expect(meA.statusCode, meA.body).toBe(200);
    const before = await snapshotB();
    expect(before.memberships).toHaveLength(1);
    expect(before.sessions.map((s) => s.revoked)).toEqual([false]);
    expect(before.roles.map((r) => r.key).sort()).toEqual(["owner"]);

    // The role edit in org A: the owner adds a key to the user's role.
    const edited = await call(
      users.ownerA,
      ORG_A,
      "PATCH",
      `/v1/roles/${viewerA}`,
      {
        permissions: [MILESTONE_READ, MILESTONE_CREATE],
      },
    );
    expect(edited.statusCode, edited.body).toBe(200);
    expect(Role.schema.parse(JSON.parse(edited.body)).permissions).toEqual([
      MILESTONE_CREATE,
      MILESTONE_READ,
    ]);
    expect(await snapshotB()).toEqual(before);

    // The removal in org A, timed to the next request in org A.
    const [row] = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.memberships WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL",
      [ORG_A, users.both],
    );
    const removed = await call(
      users.ownerA,
      ORG_A,
      "DELETE",
      `/v1/members/${row?.id ?? ""}`,
    );
    expect(removed.statusCode, removed.body).toBe(204);
    const removedAt = performance.now();
    const refused = await call(users.both, ORG_A, "GET", "/v1/me/memberships");
    const elapsedMs = Math.round(performance.now() - removedAt);
    process.stdout.write(
      `[P5-05] DELETE /v1/members to the next request refused in org A: ${String(elapsedMs)} ms\n`,
    );
    expectProblem(refused, 403, "forbidden");
    expect(lastAuthFailure()).toBe("membership_missing");
    expect(elapsedMs).toBeLessThan(1_000);
    const sessionsA = await asAdmin<{ revoked: boolean }>(
      "SELECT (revoked_at IS NOT NULL) AS revoked FROM bricx.sessions WHERE org_id = $1 AND user_id = $2",
      [ORG_A, users.both],
    );
    expect(sessionsA.map((s) => s.revoked)).toEqual([true]);

    // Org B: the same token still works there, nothing there changed.
    const after = await snapshotB();
    expect(after).toEqual(before);
    const stillOwner = await call(users.both, ORG_B, "GET", "/v1/members");
    expect(stillOwner.statusCode, stillOwner.body).toBe(200);
    // Org B's chain gained no row from either change in org A.
    expect(after.auditRows).toBe(before.auditRows);
    const chainA = await asAdmin<{ action: string }>(
      "SELECT action FROM bricx.audit_events WHERE org_id = $1 ORDER BY seq",
      [ORG_A],
    );
    expect(chainA.map((e) => e.action)).toEqual([
      "org.role.update",
      "org.session.revoke",
      "org.member.remove",
    ]);
  });
});
