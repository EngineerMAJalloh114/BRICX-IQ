// P6-06 secure invitations (ADR 0077), end to end through the real app
// against compose.yml's Postgres (production journal, 0013 included) and
// Valkey, with the production grants source and an injected Clock. The
// cell Keycloak's userinfo is a test double here (what it answers is set
// per test; the live endpoint is invitations-accept.int.test.ts); the
// worker's token mint is the real statement (mintInvitationToken as
// bricx_app, as the worker runs it).
// Done-when rows 2-5, 7, 9-11, 13 and the sabotages they turn red:
// - create: 201, the row, one invitations.send outbox row with ids and
//   the send number only, one org.invitation.create event without the
//   address; a replay; one pending per (org, project, address) with 409
//   and Location (S9 at the API; the index race is in packages/db);
// - escalation (S4) and finance keys (row 11): 403 and ONE
//   org.invitation.denied per (org, actor, reason) per 15 minutes (C8);
//   step-up at acr pwd;
// - cross-tenant (S3): another org never sees, revokes or resends it;
// - accept: verified e-mail equal to the invited one (S6, C3 S18), the
//   uniform 404 (S14), single use (S1), expiry at the Clock (S2), resend
//   rotation (S8) and its bound, revoke, an existing member, self-invite,
//   the inviter removed (S10) or demoted (S17), the project or the org
//   archived, 20 concurrent accepts give one membership (S11);
// - activate: always 202; at most three counted (C7 S19);
// - nothing in the logs, outbox, audit rows or bodies carries the token
//   or the address (row 7).
import { createHash } from "node:crypto";
import { Writable } from "node:stream";
import { loadApiConfig } from "@bricx/config/api";
import { seedProjects } from "@bricx/db-bootstrap/fixtures";
import {
  type BootstrappedPostgres,
  type StartedValkey,
  appDatabase,
  exampleValue,
  startPostgres,
  startValkey,
} from "@bricx/db-bootstrap/stack";
import { type Database, openDatabase } from "@bricx/db/database";
import {
  hashInvitationSecret,
  invitationTokenOf,
  mintInvitationToken,
  newInvitationSecret,
} from "@bricx/db/invitations";
import { migrate } from "@bricx/db/migrate";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
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
import { memoryRateLimits } from "../support/rate-limit.js";

const HOOK_MS = 300_000;
const ORG_A = "0199e1a0-0000-7000-8000-0000000006a1";
const ORG_B = "0199e1a0-0000-7000-8000-0000000006b1";
const P1 = "0199e1a0-0000-7000-8000-0000000006c1";
const users = {
  owner: "0199e1a0-0000-7000-8000-000000000601",
  admin: "0199e1a0-0000-7000-8000-000000000602",
  auditor: "0199e1a0-0000-7000-8000-000000000603",
  ownerB: "0199e1a0-0000-7000-8000-000000000604",
  invitee: "0199e1a0-0000-7000-8000-000000000605",
  member: "0199e1a0-0000-7000-8000-000000000606",
  crowd: "0199e1a0-0000-7000-8000-000000000607",
  inviter2: "0199e1a0-0000-7000-8000-000000000608",
  inviter3: "0199e1a0-0000-7000-8000-000000000609",
} as const;
const subOf = (user: string) => `inv-${user}`;
const BUDGET_APPROVE = "finance.budget.approve.project";
const INVITATIONS = "/v1/invitations";

let pg18: BootstrappedPostgres;
let valkey: StartedValkey;
let issuer: TestIssuer;
let app: NestFastifyApplication;
let worker: Database;
const lines: string[] = [];
/** The API's Clock: real time plus `skew` ms. */
let skew = 0;
const nowMs = () => Date.now() + skew;
/** What the userinfo double answers next (per accept). */
let userinfo: (bearer: string) => UserinfoAnswer = () => {
  throw new Error("userinfo not set");
};
const roles: Record<string, string> = {};
/** Every secret and address a test used: none may leak (row 7). */
const secrets = new Set<string>();

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
  for (const user of [users.owner]) {
    await applyAccess(asAdmin, { orgId: ORG_A, userId: user, role: "owner" });
  }
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
  // The member admin: invites and manages members, no finance key.
  const admin = await seedRole(asAdmin, ORG_A, "memberadmin");
  for (const key of [
    "org.member.read.org",
    "org.member.invite.org",
    "org.member.update.org",
    "org.member.remove.org",
    "project.member.read.org",
    "project.member.assign.org",
    "project.milestone.read.org",
  ]) {
    await asAdmin(
      `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
      [seedId(), ORG_A, admin, key],
    );
  }
  for (const user of [users.admin, users.inviter2, users.inviter3]) {
    await applyAccess(asAdmin, {
      orgId: ORG_A,
      userId: user,
      role: "memberadmin",
    });
  }
  await applyAccess(asAdmin, {
    orgId: ORG_A,
    userId: users.member,
    role: "viewer",
  });
  const fin = await seedRole(asAdmin, ORG_A, "finrole");
  await asAdmin(
    `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
     VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
    [seedId(), ORG_A, fin, BUDGET_APPROVE],
  );
  await seedProjects(asAdmin, ORG_A, [P1]);
  for (const key of [
    "viewer",
    "finrole",
    "memberadmin",
    "owner",
    "project_manager",
  ]) {
    roles[key] = await seedRole(asAdmin, ORG_A, key);
  }
  roles.otherOrg = await seedRole(asAdmin, ORG_B, "viewer");
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
async function call(
  user: string | undefined,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
  options: {
    org?: string;
    acr?: string;
    key?: string | null;
    sid?: string;
  } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (user !== undefined) {
    Object.assign(
      headers,
      bearer(
        await issuer.token({
          sub: subOf(user),
          org_id: options.org ?? ORG_A,
          acr: options.acr ?? "mfa",
          ...(options.sid === undefined ? {} : { sid: options.sid }),
          iat: Math.floor(nowMs() / 1000) - 5,
          exp: Math.floor(nowMs() / 1000) + 3_600,
        }),
      ),
    );
  }
  const idempotent =
    method === "POST" &&
    !url.endsWith("/activate") &&
    !url.endsWith("/accept") &&
    !url.endsWith("/status") &&
    !url.endsWith("/archive");
  if (idempotent && options.key !== null) {
    keys += 1;
    headers[IDEMPOTENCY_KEY_HEADER] = options.key ?? `inv-key-${String(keys)}`;
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
async function signedIn(user: string, url: string, body: unknown) {
  return app.inject({
    method: "POST",
    url,
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
    payload: JSON.stringify(body),
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
  const address = `person-${String(addresses)}@builders.example`;
  secrets.add(address);
  return address;
};

async function invite(
  by: string,
  email: string,
  roleKey = "viewer",
  extra: Record<string, unknown> = {},
): Promise<{ id: string; sendSeq: number }> {
  const res = await call(by, "POST", INVITATIONS, {
    email,
    roleId: roles[roleKey],
    ...extra,
  });
  expect(res.statusCode, res.body).toBe(201);
  const id = (JSON.parse(res.body) as { id: string }).id;
  const [row] = await asAdmin<{ send_seq: number }>(
    "SELECT send_seq FROM bricx.invitations WHERE id = $1",
    [id],
  );
  return { id, sendSeq: row?.send_seq ?? 0 };
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
  secrets.add(secret);
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
  const token = invitationTokenOf("af-south-1", secret);
  secrets.add(token);
  return token;
}

const verified = (user: string, email: string): UserinfoAnswer => ({
  sub: subOf(user),
  email,
  emailVerified: true,
});

const accept = (user: string, token: string) =>
  signedIn(user, `${INVITATIONS}/accept`, { token });

const statusOf = async (id: string) =>
  (
    await asAdmin<{ status: string; revoke_reason: string | null }>(
      "SELECT status, revoke_reason FROM bricx.invitations WHERE id = $1",
      [id],
    )
  )[0];

const membershipsOf = (user: string, org = ORG_A) =>
  asAdmin<{ role_id: string }>(
    "SELECT role_id::text FROM bricx.memberships WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL",
    [org, user],
  );

const deniedEvents = (actor: string) =>
  asAdmin<{ after: { reason: string } }>(
    "SELECT after FROM bricx.audit_events WHERE action = 'org.invitation.denied' AND actor_id = $1 ORDER BY seq",
    [actor],
  );

/** A 404 body without its per-request fields, for the uniform-error comparison. */
const uniformBody = (res: Res) => {
  const body = JSON.parse(res.body) as Record<string, unknown>;
  delete body.traceId;
  return body;
};

describe("create (D13, D12, D4; rows 2, 5, 7)", () => {
  test("201: the row (no token until the worker mints one), one invitations.send with ids and the send number only, one create event without the address; a replay; the same address again is 409 with Location", async () => {
    const email = newAddress();
    const key = "create-replay-1";
    const res = await call(
      users.owner,
      "POST",
      INVITATIONS,
      { email: email.toUpperCase(), roleId: roles.viewer },
      { key },
    );
    expect(res.statusCode, res.body).toBe(201);
    const made = JSON.parse(res.body) as Record<string, unknown>;
    expect(made).toMatchObject({
      orgId: ORG_A,
      email,
      status: "pending",
      invitedBy: users.owner,
      resendCount: 0,
    });
    expect(Date.parse(String(made.expiresAt)) - nowMs()).toBeGreaterThan(
      71 * 3_600_000,
    );
    const [row] = await asAdmin<{
      token_hash: unknown;
      email_normalised: string;
    }>(
      "SELECT token_hash, email_normalised FROM bricx.invitations WHERE id = $1",
      [made.id],
    );
    expect(row).toEqual({ token_hash: null, email_normalised: email });
    expect(
      await asAdmin(
        "SELECT payload FROM bricx.outbox WHERE topic = 'invitations.send' AND payload->>'invitationId' = $1",
        [made.id],
      ),
    ).toEqual([
      {
        payload: {
          invitationId: made.id,
          sendSeq: 1,
          invitedBy: users.owner,
        },
      },
    ]);
    const events = await asAdmin<{ action: string; after: unknown }>(
      "SELECT action, after FROM bricx.audit_events WHERE entity_id = $1 ORDER BY seq",
      [made.id],
    );
    expect(events.map((e) => e.action)).toEqual(["org.invitation.create"]);
    expect(JSON.stringify(events)).not.toContain(email);
    const replay = await call(
      users.owner,
      "POST",
      INVITATIONS,
      { email: email.toUpperCase(), roleId: roles.viewer },
      { key },
    );
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toBe(res.body);
    const again = await call(users.owner, "POST", INVITATIONS, {
      email,
      roleId: roles.viewer,
    });
    expectProblem(again, 409, "invitation.pending_exists");
    expect(again.headers.location).toBe(`${INVITATIONS}/${String(made.id)}`);
  });

  test("an unknown role, another org's role, a reader, a bad body, no Idempotency-Key", async () => {
    const email = newAddress();
    expectProblem(
      await call(users.owner, "POST", INVITATIONS, { email, roleId: seedId() }),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.owner, "POST", INVITATIONS, {
        email,
        roleId: roles.otherOrg,
      }),
      404,
      "not_found",
    );
    expectProblem(
      await call(users.auditor, "POST", INVITATIONS, {
        email,
        roleId: roles.viewer,
      }),
      403,
      "forbidden",
    );
    expectProblem(
      await call(users.owner, "POST", INVITATIONS, {
        email: "not an address",
        roleId: roles.viewer,
      }),
      422,
      "validation_failed",
    );
    expectProblem(
      await call(
        users.owner,
        "POST",
        INVITATIONS,
        { email, roleId: roles.viewer },
        { key: null },
      ),
      400,
      "idempotency.key_missing",
    );
    expect(
      await asAdmin(
        "SELECT 1 FROM bricx.invitations WHERE email_normalised = $1",
        [email],
      ),
    ).toEqual([]);
  });

  test("escalation (S4, row 11): a role with a key the inviter does not hold is 403; ONE denied event per (org, actor, reason) in 15 minutes (C8); the owner may", async () => {
    for (let i = 0; i < 3; i += 1) {
      expectProblem(
        await call(users.admin, "POST", INVITATIONS, {
          email: newAddress(),
          roleId: roles.finrole,
        }),
        403,
        "forbidden",
      );
    }
    expectProblem(
      await call(users.admin, "POST", INVITATIONS, {
        email: newAddress(),
        roleId: roles.owner,
      }),
      403,
      "forbidden",
    );
    expect((await deniedEvents(users.admin)).map((e) => e.after)).toEqual([
      { reason: "escalation" },
    ]);
    await invite(users.owner, newAddress(), "finrole");
  });

  test("an admin key at acr pwd: 401 step-up (row 11)", async () => {
    const res = await call(
      users.owner,
      "POST",
      INVITATIONS,
      { email: newAddress(), roleId: roles.viewer },
      { acr: "pwd" },
    );
    expectProblem(res, 401, "permission.step_up_required");
  });

  test("cross-tenant (S3): org B never sees, resends or revokes org A's invitation", async () => {
    const { id } = await invite(users.owner, newAddress());
    for (const [method, url] of [
      ["GET", `${INVITATIONS}/${id}`],
      ["POST", `${INVITATIONS}/${id}/resend`],
      ["DELETE", `${INVITATIONS}/${id}`],
    ] as const) {
      expectProblem(
        await call(users.ownerB, method, url, undefined, { org: ORG_B }),
        404,
        "not_found",
      );
    }
    const list = await call(users.ownerB, "GET", INVITATIONS, undefined, {
      org: ORG_B,
    });
    expect(JSON.parse(list.body)).toEqual({ items: [], nextCursor: null });
    expect((await statusOf(id))?.status).toBe("pending");
  });
});

describe("accept (D7, D8, C3; rows 2, 6)", () => {
  test("a verified matching e-mail joins once: the membership, users.mfa_check, org.invitation.accept; the address and the hash are gone from the row; the same token again is the uniform 404 (S1)", async () => {
    const email = newAddress();
    const { id } = await invite(users.owner, email);
    const token = await mint(id);
    // Only SHA-256 of the secret is stored, never the token.
    const secret = token.slice(token.indexOf(".") + 1);
    const [minted] = await asAdmin<{ token_hash: Buffer }>(
      "SELECT token_hash FROM bricx.invitations WHERE id = $1",
      [id],
    );
    expect(minted?.token_hash).toEqual(
      createHash("sha256").update(Buffer.from(secret, "base64url")).digest(),
    );
    userinfo = () => verified(users.invitee, email);
    const res = await accept(users.invitee, token);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      orgId: ORG_A,
      projectId: null,
      outcome: "joined",
    });
    expect(await membershipsOf(users.invitee)).toEqual([
      { role_id: roles.viewer },
    ]);
    const [row] = await asAdmin<{
      status: string;
      email_normalised: string | null;
      accepted_by: string;
      token_hash: Buffer | null;
    }>(
      "SELECT status, email_normalised, accepted_by::text, token_hash FROM bricx.invitations WHERE id = $1",
      [id],
    );
    // The accept clears the address and the hash (D7, D9).
    expect(row).toMatchObject({
      status: "accepted",
      email_normalised: null,
      accepted_by: users.invitee,
      token_hash: null,
    });
    expect(
      await asAdmin(
        "SELECT 1 FROM bricx.outbox WHERE topic = 'users.mfa_check' AND payload->>'userId' = $1",
        [users.invitee],
      ),
    ).toHaveLength(1);
    expect(
      (
        await asAdmin<{ action: string }>(
          "SELECT action FROM bricx.audit_events WHERE entity_id = $1 ORDER BY seq",
          [id],
        )
      ).map((e) => e.action),
    ).toEqual(["org.invitation.create", "org.invitation.accept"]);
    expectProblem(
      await accept(users.invitee, token),
      404,
      "invitation.unavailable",
    );
  });

  test("the uniform 404 (S14): unverified (S6), another address, another sub (C3 S18), a bad token, another cell, an unknown token: the same body", async () => {
    const email = newAddress();
    const { id } = await invite(users.owner, email);
    const token = await mint(id);
    const cases: [UserinfoAnswer, string][] = [
      [{ ...verified(users.crowd, email), emailVerified: false }, token],
      [verified(users.crowd, newAddress()), token],
      [{ ...verified(users.crowd, email), sub: "someone-else" }, token],
      [verified(users.crowd, email), "garbage"],
      [verified(users.crowd, email), token.replace("af-south-1", "eu-west-1")],
      [
        verified(users.crowd, email),
        invitationTokenOf("af-south-1", newInvitationSecret()),
      ],
    ];
    const bodies: unknown[] = [];
    for (const [answer, t] of cases) {
      userinfo = () => answer;
      const res = await accept(users.crowd, t);
      expectProblem(res, 404, "invitation.unavailable");
      bodies.push(uniformBody(res));
    }
    expect(new Set(bodies.map((b) => JSON.stringify(b))).size).toBe(1);
    expect(await membershipsOf(users.crowd)).toEqual([]);
    expect((await statusOf(id))?.status).toBe("pending");
    // The right person still can.
    userinfo = () => verified(users.crowd, email);
    expect((await accept(users.crowd, token)).statusCode).toBe(200);
  });

  test("expiry at the Clock (S2, row 3): past expires_at the token is the uniform 404 and the invitation reads expired", async () => {
    const email = newAddress();
    const { id } = await invite(users.owner, email);
    const token = await mint(id);
    skew += 73 * 3_600_000;
    try {
      userinfo = () => verified(users.invitee, email);
      expectProblem(
        await accept(users.invitee, token),
        404,
        "invitation.unavailable",
      );
      // A fresh session: the shared one would read as idle 73 h later.
      const read = await call(
        users.owner,
        "GET",
        `${INVITATIONS}/${id}`,
        undefined,
        {
          sid: "inv-expiry-sid",
        },
      );
      expect(JSON.parse(read.body)).toMatchObject({ status: "expired" });
    } finally {
      skew -= 73 * 3_600_000;
    }
  });

  test("resend rotates (S8, row 4): the old token dies, the new one works; at most INVITATION_MAX_RESENDS (5), then 409 resend_limit; a stale send mints nothing (S20)", async () => {
    const email = newAddress();
    const { id } = await invite(users.owner, email);
    const first = await mint(id);
    const resent = await call(
      users.owner,
      "POST",
      `${INVITATIONS}/${id}/resend`,
    );
    expect(resent.statusCode, resent.body).toBe(200);
    expect(JSON.parse(resent.body)).toMatchObject({ resendCount: 1 });
    // The old token dies at the resend, before any new mint.
    userinfo = () => verified(users.member, email);
    expectProblem(
      await accept(users.member, first),
      404,
      "invitation.unavailable",
    );
    // The first send's job, run late: nothing minted.
    expect(
      await worker.withTx(
        { orgId: ORG_A, userId: users.owner, projectIds: [] },
        (tx) =>
          mintInvitationToken(tx, {
            id,
            sendSeq: 1,
            hash: hashInvitationSecret(newInvitationSecret()),
            now: new Date(nowMs()).toISOString(),
          }),
      ),
    ).toBeUndefined();
    const second = await mint(id);
    userinfo = () => verified(users.member, email);
    expectProblem(
      await accept(users.member, first),
      404,
      "invitation.unavailable",
    );
    for (let i = 2; i <= 5; i += 1) {
      expect(
        (await call(users.owner, "POST", `${INVITATIONS}/${id}/resend`))
          .statusCode,
      ).toBe(200);
    }
    expectProblem(
      await call(users.owner, "POST", `${INVITATIONS}/${id}/resend`),
      409,
      "invitation.resend_limit",
    );
    // The newest send's token is the only one; `second` died with send 3.
    expectProblem(
      await accept(users.member, second),
      404,
      "invitation.unavailable",
    );
    const last = await mint(id);
    const res = await accept(users.member, last);
    expect(res.statusCode, res.body).toBe(200);
    // An existing member: already_member, the role is never changed.
    expect(JSON.parse(res.body)).toMatchObject({ outcome: "already_member" });
    expect(await membershipsOf(users.member)).toEqual([
      { role_id: roles.viewer },
    ]);
  });

  test("revoke: the token dies; revoking again is 204 (idempotent); an accepted one is 409", async () => {
    const email = newAddress();
    const { id } = await invite(users.owner, email);
    const token = await mint(id);
    expect(
      (await call(users.owner, "DELETE", `${INVITATIONS}/${id}`)).statusCode,
    ).toBe(204);
    expect(
      (await call(users.owner, "DELETE", `${INVITATIONS}/${id}`)).statusCode,
    ).toBe(204);
    userinfo = () => verified(users.crowd, email);
    expectProblem(
      await accept(users.crowd, token),
      404,
      "invitation.unavailable",
    );
    expect(await statusOf(id)).toEqual({
      status: "revoked",
      revoke_reason: "manual",
    });
  });

  test("self-invite: the inviter accepting their own invitation is the uniform 404 and one self_invite denial", async () => {
    const email = newAddress();
    const { id } = await invite(users.inviter3, email, "memberadmin");
    const token = await mint(id);
    userinfo = () => verified(users.inviter3, email);
    expectProblem(
      await accept(users.inviter3, token),
      404,
      "invitation.unavailable",
    );
    expect((await deniedEvents(users.inviter3)).map((e) => e.after)).toEqual([
      { reason: "self_invite" },
    ]);
  });

  test("20 concurrent accepts of one invitation by its invitee: exactly one membership, one 200, no 5xx (S11)", async () => {
    const email = newAddress();
    const { id } = await invite(users.owner, email, "project_manager");
    const token = await mint(id);
    const fresh = "0199e1a0-0000-7000-8000-00000000060f";
    await seedUsers(asAdmin, [{ id: fresh, sub: subOf(fresh) }]);
    userinfo = () => verified(fresh, email);
    const answers = await Promise.all(
      Array.from({ length: 20 }, () => accept(fresh, token)),
    );
    const codes = answers.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 200)).toHaveLength(1);
    expect(codes.filter((c) => c >= 500)).toEqual([]);
    expect(codes.filter((c) => c !== 200).every((c) => c === 404)).toBe(true);
    expect(await membershipsOf(fresh)).toHaveLength(1);
  });
});

describe("the inviter, the project and the org change (rows 9, 10; D14)", () => {
  test("the inviter removed (S10): their pending invitations are revoked inviter_removed, one revoke event each", async () => {
    const { id } = await invite(users.inviter2, newAddress(), "memberadmin");
    const [membership] = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.memberships WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL",
      [ORG_A, users.inviter2],
    );
    expect(
      (await call(users.owner, "DELETE", `/v1/members/${membership?.id ?? ""}`))
        .statusCode,
    ).toBe(204);
    expect(await statusOf(id)).toEqual({
      status: "revoked",
      revoke_reason: "inviter_removed",
    });
    expect(
      (
        await asAdmin<{ action: string }>(
          "SELECT action FROM bricx.audit_events WHERE entity_id = $1 ORDER BY seq",
          [id],
        )
      ).map((e) => e.action),
    ).toEqual(["org.invitation.create", "org.invitation.revoke"]);
  });

  test("the inviter demoted (S17): at accept the invitation is revoked inviter_lacks_rights; the uniform 404; one denial", async () => {
    const email = newAddress();
    const { id } = await invite(users.admin, email, "memberadmin");
    const token = await mint(id);
    const [membership] = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.memberships WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL",
      [ORG_A, users.admin],
    );
    // Demoted as the test superuser, so no cascade runs: accept re-checks.
    await asAdmin("UPDATE bricx.memberships SET role_id = $1 WHERE id = $2", [
      roles.viewer,
      membership?.id,
    ]);
    const stranger = "0199e1a0-0000-7000-8000-00000000060e";
    await seedUsers(asAdmin, [{ id: stranger, sub: subOf(stranger) }]);
    try {
      userinfo = () => verified(stranger, email);
      expectProblem(
        await accept(stranger, token),
        404,
        "invitation.unavailable",
      );
      expect(await statusOf(id)).toEqual({
        status: "revoked",
        revoke_reason: "inviter_lacks_rights",
      });
      expect((await deniedEvents(stranger)).map((e) => e.after)).toEqual([
        { reason: "inviter_lacks_rights" },
      ]);
    } finally {
      await asAdmin("UPDATE bricx.memberships SET role_id = $1 WHERE id = $2", [
        roles.memberadmin,
        membership?.id,
      ]);
    }
  });

  test("a project invitation joins the project too; archiving the project revokes the pending ones (project_archived)", async () => {
    const email = newAddress();
    const joined = await invite(users.owner, email, "viewer", {
      projectId: P1,
      projectRoleId: roles.project_manager,
    });
    const token = await mint(joined.id);
    const fresh = "0199e1a0-0000-7000-8000-00000000060e";
    await seedUsers(asAdmin, [{ id: fresh, sub: subOf(fresh) }]);
    userinfo = () => verified(fresh, email);
    const res = await accept(fresh, token);
    expect(res.statusCode, res.body).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ projectId: P1 });
    expect(
      await asAdmin(
        "SELECT 1 FROM bricx.project_memberships WHERE project_id = $1 AND user_id = $2 AND removed_at IS NULL",
        [P1, fresh],
      ),
    ).toHaveLength(1);
    const pending = await invite(users.owner, newAddress(), "viewer", {
      projectId: P1,
      projectRoleId: roles.project_manager,
    });
    for (const to of ["archived"]) {
      const moved = await call(
        users.owner,
        "POST",
        `/v1/projects/${P1}/status`,
        { to },
      );
      expect(moved.statusCode, moved.body).toBe(200);
    }
    expect(await statusOf(pending.id)).toEqual({
      status: "revoked",
      revoke_reason: "project_archived",
    });
  });
});

describe("activate (D6, C7 S19)", () => {
  test("always 202 with one body; a good token writes one invitations.activate (ids only); at most three are counted", async () => {
    const email = newAddress();
    const { id } = await invite(users.owner, email);
    const token = await mint(id);
    const activate = (t: string) =>
      app.inject({
        method: "POST",
        url: `${INVITATIONS}/activate`,
        headers: { "content-type": "application/json" },
        payload: JSON.stringify({ token: t }),
      });
    const answers = [];
    for (const t of [
      "garbage",
      invitationTokenOf("af-south-1", newInvitationSecret()),
      token,
      token,
      token,
      token,
    ]) {
      const res = await activate(t);
      expect(res.statusCode, res.body).toBe(202);
      answers.push(res.body);
    }
    expect(new Set(answers).size).toBe(1);
    expect(
      await asAdmin(
        "SELECT payload FROM bricx.outbox WHERE topic = 'invitations.activate' AND payload->>'invitationId' = $1",
        [id],
      ),
    ).toEqual(
      Array.from({ length: 3 }, () => ({
        payload: { invitationId: id, invitedBy: users.owner },
      })),
    );
  });
});

describe("archiving the org (D14)", () => {
  test("revokes every pending invitation (org_archived)", async () => {
    const { id } = await invite(users.owner, newAddress());
    const res = await call(
      users.owner,
      "POST",
      "/v1/organizations/current/archive",
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(await statusOf(id)).toEqual({
      status: "revoked",
      revoke_reason: "org_archived",
    });
  });
});

describe("no secret anywhere (row 7)", () => {
  test("no token, secret or invited address in the logs, the outbox or the audit chain", async () => {
    const logs = lines.join("\n");
    const outbox = JSON.stringify(
      await asAdmin("SELECT topic, payload FROM bricx.outbox"),
    );
    const audit = JSON.stringify(
      await asAdmin("SELECT before, after FROM bricx.audit_events"),
    );
    expect(secrets.size).toBeGreaterThan(10);
    for (const secret of secrets) {
      expect([secret, logs.includes(secret)]).toEqual([secret, false]);
      expect([secret, outbox.includes(secret)]).toEqual([secret, false]);
      expect([secret, audit.includes(secret)]).toEqual([secret, false]);
    }
  });
});
