// P6-06c (ADR 0085; owner conditions C4, Q1-Q6), against a real Postgres 18
// with the production journal, through the real app with the production
// grants source and a Clock the tests move. Done-when 2-7, 9-13.
// - Start (POST /v1/organizations/current/ownership-transfers): only a
//   member whose role has system_key 'owner' (a custom role holding every
//   key is 403 plus one org.invitation.denied event, reason
//   ownership_not_owner); fresh authentication (@FreshAuth(): acr mfa and
//   auth_time within 300 s, else 401 auth.reauth_required); the recipient
//   is an open, active, internal, permanent member and not the caller; the
//   previous role is a role of the org and not the owner role; the typed
//   name equals the org's after trim and NFKC; one pending transfer per
//   org (409 ownership.transfer_pending, never 5xx, under 10 concurrent
//   starts). Same transaction: the row, org.ownership_transfer.start, the
//   recipient's users.mfa_check and the delayed ownership.expire job.
// - Accept (recipient only, @FreshAuth(), the typed name, under the org
//   lock): the recipient becomes owner and the initiator gets the previous
//   role, both audited (org.member.update each) with mfa checks; the
//   initiator accepting is 403 (ownership_self_accept); 20 concurrent
//   accepts change the owner once; the org always has an active owner.
//   One ms before expires_at it accepts; at expires_at it is 409 with
//   nothing written, and the next start records the expiry (as system).
//   K1: the outgoing owner's same token is refused an owner action on the
//   next request.
// - Decline (recipient), cancel (any active owner, acr mfa): audited, mfa
//   check for the recipient.
// - Cascades (same transaction): removing or suspending either party,
//   re-roling the recipient, archiving the org cancel the transfer with
//   the cause.
// - Q6: PATCH to or from owner is 409 ownership.transfer_required from the
//   API's own check (one denial event, ownership_transfer_required; the
//   database guard's P606C would answer the generic 409 request.conflict
//   with no denial: sabotage S26); an invitation with the owner role is
//   422.
// - The typed name never reaches a log line.
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
import { migrate } from "@bricx/db/migrate";
import { ErrorEnvelopeSchema } from "@bricx/validation/error-envelope";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createApp } from "../../src/app.js";
import { IDEMPOTENCY_KEY_HEADER } from "../../src/common/idempotency/decorator.js";
import { MyMembershipList } from "../../src/modules/memberships/memberships.dto.js";
import { MEMBERS_LOCK_NAMESPACE } from "../../src/modules/memberships/memberships.repository.js";
import { OwnershipTransfer } from "../../src/modules/ownership-transfers/ownership-transfers.dto.js";
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
const TRANSFERS = "/v1/organizations/current/ownership-transfers";
const MEMBERS = "/v1/members";
const INVITATIONS = "/v1/invitations";
const ME = "/v1/me/memberships";
/** The fixture organisation's legal name (tooling/db-bootstrap fixtures). */
const ORG_NAME = "Fixture organisation";
const DAY = 86_400_000;

let pg18: BootstrappedPostgres;
let valkey: StartedValkey;
let issuer: TestIssuer;
let app: NestFastifyApplication;
const lines: string[] = [];
let at = 0;
const nowS = () => Math.floor(at / 1000);

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

const subOf = (user: string) => `transfer-${user}`;
let keyCounter = 0;
const newKey = () => {
  keyCounter += 1;
  return `transfer-key-${String(keyCounter)}`;
};

interface Org {
  id: string;
  owner: string;
  member: string;
  other: string;
  allKeys: string;
  ownerRole: string;
  memberRole: string;
}

/** A fresh organisation: one owner, two members, a custom all-keys member. */
async function newOrg(): Promise<Org> {
  // The fixtures below are written at the database clock (created_at =
  // now() - 1 minute), and the API writes at the Clock. A Clock frozen at
  // the suite's start falls behind on a slow run (CI on a896d5d: removing
  // a member set removed_at before its created_at, CHECK
  // memberships_removed, 500). Each org starts with the Clock caught up to
  // the wall clock, never moved back.
  at = Math.max(at, Math.floor(Date.now() / 1000) * 1000);
  const id = seedId();
  const org = {
    id,
    owner: seedId(),
    member: seedId(),
    other: seedId(),
    allKeys: seedId(),
    ownerRole: "",
    memberRole: "",
  };
  await seedUsers(
    asAdmin,
    [org.owner, org.member, org.other, org.allKeys].map((u) => ({
      id: u,
      sub: subOf(u),
    })),
  );
  await applyAccess(asAdmin, { orgId: id, userId: org.owner, role: "owner" });
  for (const u of [org.member, org.other]) {
    await applyAccess(asAdmin, { orgId: id, userId: u, role: "member" });
  }
  const { CATALOGUE } = await import("@bricx/permissions/catalogue");
  const all = await seedRole(asAdmin, id, "allkeys");
  for (const permission of CATALOGUE) {
    await asAdmin(
      `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
      [seedId(), id, all, permission],
    );
  }
  await applyAccess(asAdmin, {
    orgId: id,
    userId: org.allKeys,
    role: "allkeys",
  });
  org.ownerRole = await seedRole(asAdmin, id, "owner");
  org.memberRole = await seedRole(asAdmin, id, "member");
  return org;
}

interface CallOptions {
  /** The token's auth_time; default the Clock's second; null drops it. */
  authTime?: number | null;
  acr?: "mfa" | "pwd";
  /** A token minted earlier (K1). */
  token?: string;
  key?: string;
  /** A sign-in of its own (after the Clock jumps past the idle limit). */
  sid?: string;
}

async function tokenFor(
  org: Org,
  user: string,
  options: CallOptions = {},
): Promise<string> {
  const authTime =
    options.authTime === undefined ? nowS() : (options.authTime ?? undefined);
  return issuer.token({
    sub: subOf(user),
    org_id: org.id,
    acr: options.acr ?? "mfa",
    auth_time: authTime,
    ...(options.sid === undefined ? {} : { sid: options.sid }),
  });
}

type Res = Awaited<ReturnType<NestFastifyApplication["inject"]>>;
async function call(
  org: Org,
  user: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  url: string,
  body?: unknown,
  options: CallOptions = {},
): Promise<Res> {
  const headers: Record<string, string> = bearer(
    options.token ?? (await tokenFor(org, user, options)),
  );
  if (method === "POST")
    headers[IDEMPOTENCY_KEY_HEADER] = options.key ?? newKey();
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

const transferOf = (res: Res, status = 200) => {
  expect(res.statusCode, res.body).toBe(status);
  return OwnershipTransfer.schema.parse(JSON.parse(res.body));
};

const start = (
  org: Org,
  extra: Record<string, unknown> = {},
  options: CallOptions = {},
) =>
  call(
    org,
    org.owner,
    "POST",
    TRANSFERS,
    {
      toUserId: org.member,
      previousOwnerRoleId: org.memberRole,
      organisationName: ORG_NAME,
      ...extra,
    },
    options,
  );
const accept = (
  org: Org,
  id: string,
  user = org.member,
  options: CallOptions = {},
  name = ORG_NAME,
) =>
  call(
    org,
    user,
    "POST",
    `${TRANSFERS}/${id}/accept`,
    { organisationName: name },
    options,
  );

const roleOf = async (org: Org, user: string) =>
  (
    await asAdmin<{ role_id: string }>(
      `SELECT role_id::text FROM bricx.memberships
       WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL`,
      [org.id, user],
    )
  )[0]?.role_id;
const openOwners = async (org: Org) =>
  (
    await asAdmin<{ n: number }>(
      `SELECT count(*)::int AS n FROM bricx.memberships m
       JOIN bricx.roles r ON r.org_id = m.org_id AND r.id = m.role_id
       WHERE m.org_id = $1 AND m.removed_at IS NULL AND m.suspended_at IS NULL
         AND r.system_key = 'owner'`,
      [org.id],
    )
  )[0]?.n;
const transferRow = async (id: string) =>
  (
    await asAdmin<{
      status: string;
      cancel_reason: string | null;
      settled_by: string | null;
    }>(
      "SELECT status, cancel_reason, settled_by::text FROM bricx.ownership_transfers WHERE id = $1",
      [id],
    )
  )[0];
const auditActions = (entityId: string) =>
  asAdmin<{ action: string; actor_id: string | null }>(
    "SELECT action, actor_id::text FROM bricx.audit_events WHERE entity_id = $1 ORDER BY seq",
    [entityId],
  );
const denials = (org: Org, reason: string) =>
  asAdmin<{ n: number }>(
    `SELECT count(*)::int AS n FROM bricx.audit_events
     WHERE org_id = $1 AND action = 'org.invitation.denied' AND after->>'reason' = $2`,
    [org.id, reason],
  ).then((rows) => rows[0]?.n ?? 0);
const mfaChecks = (user: string) =>
  asAdmin<{ n: number }>(
    `SELECT count(*)::int AS n FROM bricx.outbox WHERE topic = 'users.mfa_check' AND payload->>'userId' = $1`,
    [user],
  ).then((rows) => rows[0]?.n ?? 0);
const membershipId = async (org: Org, user: string) => {
  const [row] = await asAdmin<{ id: string }>(
    "SELECT id::text FROM bricx.memberships WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL",
    [org.id, user],
  );
  if (row === undefined) throw new Error("no membership");
  return row.id;
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
  at = Math.floor(Date.now() / 1000) * 1000;
  issuer.nowSeconds = nowS;
  app = await createApp(
    loadApiConfig(
      apiEnv({
        ...issuer.env(),
        DATABASE_URL: urlFor("bricx_app", "BRICX_APP_PASSWORD"),
        VALKEY_URL: valkey.url(),
        // The suite's volume, not the limit, is under test here.
        RATE_LIMIT_AUTH_ADJACENT: "ip=100000,user=100000,org=100000,window=600",
        RATE_LIMIT_INVITATION: "ip=100000,user=100000,org=100000,window=3600",
      }),
    ),
    {
      probes: fakeProbes(),
      revocationStore: fixedRevocations(),
      rateLimitStore: memoryRateLimits(),
      clock: { now: () => at },
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

describe("start (DW2-DW5)", () => {
  test("201: one pending row, org.ownership_transfer.start, the recipient's mfa check and the delayed ownership.expire job in the same transaction", async () => {
    const org = await newOrg();
    const before = await mfaChecks(org.member);
    const t = transferOf(await start(org), 201);
    expect(t).toMatchObject({
      status: "pending",
      initiatedBy: org.owner,
      toUserId: org.member,
      previousOwnerRoleId: org.memberRole,
      settledAt: null,
      settledBy: null,
      cancelReason: null,
    });
    expect(Date.parse(t.expiresAt) - at).toBe(DAY);
    expect(await auditActions(t.id)).toEqual([
      { action: "org.ownership_transfer.start", actor_id: org.owner },
    ]);
    expect(await mfaChecks(org.member)).toBe(before + 1);
    expect(
      await asAdmin(
        `SELECT payload, to_char(not_before AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS not_before
         FROM bricx.outbox WHERE topic = 'ownership.expire' AND payload->>'transferId' = $1`,
        [t.id],
      ),
    ).toEqual([
      {
        payload: {
          transferId: t.id,
          toUserId: org.member,
          expiresAt: t.expiresAt,
        },
        not_before: t.expiresAt,
      },
    ]);
    // The pending transfer is readable by an owner and by the recipient,
    // not by another member.
    expect(
      transferOf(await call(org, org.owner, "GET", `${TRANSFERS}/pending`)).id,
    ).toBe(t.id);
    expect(
      transferOf(await call(org, org.member, "GET", `${TRANSFERS}/pending`)).id,
    ).toBe(t.id);
    expectProblem(
      await call(org, org.other, "GET", `${TRANSFERS}/pending`),
      404,
      "not_found",
    );
  });

  test("fresh authentication: missing, stale (301 s), future (6 s) auth_time or acr pwd are 401 auth.reauth_required; 300 s passes", async () => {
    const org = await newOrg();
    for (const options of [
      { authTime: null },
      { authTime: nowS() - 301 },
      { authTime: nowS() + 6 },
      { acr: "pwd" as const },
    ]) {
      expectProblem(await start(org, {}, options), 401, "auth.reauth_required");
    }
    expect(
      await asAdmin(
        "SELECT 1 FROM bricx.ownership_transfers WHERE org_id = $1",
        [org.id],
      ),
    ).toEqual([]);
    transferOf(await start(org, {}, { authTime: nowS() - 300 }), 201);
  });

  test("owner by system_key only (DW3, S1): a custom role holding every key is 403 with one ownership_not_owner denial; a plain member is 403", async () => {
    const org = await newOrg();
    const before = await denials(org, "ownership_not_owner");
    for (let i = 0; i < 3; i += 1) {
      expectProblem(
        await call(org, org.allKeys, "POST", TRANSFERS, {
          toUserId: org.member,
          previousOwnerRoleId: org.memberRole,
          organisationName: ORG_NAME,
        }),
        403,
        "forbidden",
      );
    }
    // Deduplicated per 15-minute bucket.
    expect(await denials(org, "ownership_not_owner")).toBe(before + 1);
    expectProblem(
      await call(org, org.other, "POST", TRANSFERS, {
        toUserId: org.member,
        previousOwnerRoleId: org.memberRole,
        organisationName: ORG_NAME,
      }),
      403,
      "forbidden",
    );
  });

  test("the recipient and the previous role (DW4): self 422, a non-member 404, a suspended, temporary or external member 409, the owner role 422, an unknown role 404, a wrong name 422; trim and NFKC apply to the name (S15)", async () => {
    const org = await newOrg();
    expectProblem(
      await start(org, { toUserId: org.owner }),
      422,
      "validation_failed",
    );
    expectProblem(await start(org, { toUserId: seedId() }), 404, "not_found");
    expectProblem(
      await start(org, { previousOwnerRoleId: org.ownerRole }),
      422,
      "validation_failed",
    );
    expectProblem(
      await start(org, { previousOwnerRoleId: seedId() }),
      404,
      "not_found",
    );
    for (const name of ["fixture organisation", "Fixture organisation!", ""]) {
      expectProblem(
        await start(org, { organisationName: name }),
        422,
        "validation_failed",
      );
    }
    // Suspended, temporary, external recipients.
    const suspended = await membershipId(org, org.other);
    await asAdmin(
      `UPDATE bricx.memberships SET suspended_at = now(), suspended_by = $2, suspend_reason = 'x' WHERE id = $1`,
      [suspended, org.owner],
    );
    expectProblem(
      await start(org, { toUserId: org.other }),
      409,
      "request.conflict",
    );
    await asAdmin(
      `UPDATE bricx.memberships SET suspended_at = NULL, suspended_by = NULL, suspend_reason = NULL WHERE id = $1`,
      [suspended],
    );
    await asAdmin(
      `UPDATE bricx.memberships SET expires_at = now() + interval '30 days' WHERE id = $1`,
      [suspended],
    );
    expectProblem(
      await start(org, { toUserId: org.other }),
      409,
      "request.conflict",
    );
    const external = seedId();
    await seedUsers(asAdmin, [{ id: external, sub: subOf(external) }]);
    await asAdmin(
      `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at, is_external)
       VALUES ($1, $2, $3, $4, now() - interval '1 minute', true)`,
      [seedId(), org.id, external, org.memberRole],
    );
    expectProblem(
      await start(org, { toUserId: external }),
      409,
      "request.conflict",
    );
    expect(
      await asAdmin(
        "SELECT 1 FROM bricx.ownership_transfers WHERE org_id = $1",
        [org.id],
      ),
    ).toEqual([]);
    // Fullwidth letters and surrounding spaces fold to the org's name.
    transferOf(
      await start(org, { organisationName: "  Ｆｉｘｔｕｒｅ organisation " }),
      201,
    );
  });

  test("one pending transfer (DW5): 10 concurrent starts give exactly one 201, the rest 409 ownership.transfer_pending, no 5xx", async () => {
    const org = await newOrg();
    const results = await Promise.all(
      Array.from({ length: 10 }, () => start(org)),
    );
    const codes = results.map((r) => r.statusCode).sort();
    expect(codes.filter((c) => c === 201)).toHaveLength(1);
    expect(codes.filter((c) => c >= 500)).toEqual([]);
    for (const r of results.filter((x) => x.statusCode !== 201)) {
      expectProblem(r, 409, "ownership.transfer_pending");
    }
  });
});

describe("accept (DW6, DW7, DW12)", () => {
  test("the recipient accepts: roles swap, both audited, mfa checks for both; the outgoing owner's same token is refused an owner action on the next request (K1)", async () => {
    const org = await newOrg();
    const t = transferOf(await start(org), 201);
    const ownerToken = await tokenFor(org, org.owner);
    const checks = [await mfaChecks(org.owner), await mfaChecks(org.member)];
    const accepted = transferOf(await accept(org, t.id));
    expect(accepted).toMatchObject({
      status: "accepted",
      settledBy: org.member,
    });
    expect(await roleOf(org, org.member)).toBe(org.ownerRole);
    expect(await roleOf(org, org.owner)).toBe(org.memberRole);
    expect(await openOwners(org)).toBe(1);
    expect((await auditActions(t.id)).map((a) => a.action)).toEqual([
      "org.ownership_transfer.start",
      "org.ownership_transfer.accept",
    ]);
    for (const user of [org.owner, org.member]) {
      expect(
        (await auditActions(await membershipId(org, user))).map(
          (a) => a.action,
        ),
      ).toContain("org.member.update");
    }
    expect([await mfaChecks(org.owner), await mfaChecks(org.member)]).toEqual([
      (checks[0] ?? 0) + 1,
      (checks[1] ?? 0) + 1,
    ]);
    // K1: the same, unexpired token of the outgoing owner, next request.
    expectProblem(
      await call(
        org,
        org.owner,
        "POST",
        TRANSFERS,
        {
          toUserId: org.other,
          previousOwnerRoleId: org.memberRole,
          organisationName: ORG_NAME,
        },
        { token: ownerToken },
      ),
      403,
      "forbidden",
    );
    const mine = await call(org, org.owner, "GET", ME, undefined, {
      token: ownerToken,
    });
    expect(mine.statusCode, mine.body).toBe(200);
    const items = MyMembershipList.schema.parse(JSON.parse(mine.body)).items;
    expect(items.find((m) => m.orgId === org.id)?.roleId).toBe(org.memberRole);
    // Settled: a second accept is 409.
    expectProblem(await accept(org, t.id), 409, "request.conflict");
  });

  test("SoD (DW7, Q1, S10): the initiator accepting is 403 with one ownership_self_accept denial; another member is 404; fresh authentication and the typed name are required", async () => {
    const org = await newOrg();
    const t = transferOf(await start(org), 201);
    expectProblem(await accept(org, t.id, org.owner), 403, "forbidden");
    expect(await denials(org, "ownership_self_accept")).toBe(1);
    expectProblem(await accept(org, t.id, org.other), 404, "not_found");
    expectProblem(
      await accept(org, t.id, org.member, { authTime: nowS() - 301 }),
      401,
      "auth.reauth_required",
    );
    expectProblem(
      await accept(org, t.id, org.member, { authTime: null }),
      401,
      "auth.reauth_required",
    );
    expectProblem(
      await accept(org, t.id, org.member, {}, "Another organisation"),
      422,
      "validation_failed",
    );
    expect((await transferRow(t.id))?.status).toBe("pending");
    expect(await roleOf(org, org.owner)).toBe(org.ownerRole);
  });

  test("20 concurrent accepts change the owner once (S7); an accept racing a cancel stays consistent; never 0 active owners", async () => {
    const org = await newOrg();
    const t = transferOf(await start(org), 201);
    const results = await Promise.all(
      Array.from({ length: 20 }, () => accept(org, t.id)),
    );
    expect(results.filter((r) => r.statusCode === 200)).toHaveLength(1);
    expect(results.filter((r) => r.statusCode >= 500)).toEqual([]);
    expect(await openOwners(org)).toBe(1);
    expect(
      (await auditActions(t.id)).filter(
        (a) => a.action === "org.ownership_transfer.accept",
      ),
    ).toHaveLength(1);

    const org2 = await newOrg();
    const t2 = transferOf(await start(org2), 201);
    const [acc, can] = await Promise.all([
      accept(org2, t2.id),
      call(org2, org2.owner, "POST", `${TRANSFERS}/${t2.id}/cancel`),
    ]);
    expect([acc.statusCode, can.statusCode].sort()).toEqual([200, 409]);
    const row = await transferRow(t2.id);
    if (acc.statusCode === 200) {
      expect(row?.status).toBe("accepted");
      expect(await roleOf(org2, org2.member)).toBe(org2.ownerRole);
    } else {
      expect(row?.status).toBe("cancelled");
      expect(await roleOf(org2, org2.owner)).toBe(org2.ownerRole);
    }
    expect(await openOwners(org2)).toBe(1);
  });

  test("accept waits for the org lock (S7): while another transaction holds the org's members lock, the accept blocks on it and writes nothing; once released it completes", async () => {
    const org = await newOrg();
    const t = transferOf(await start(org), 201);
    const holder = await pg18.admin();
    try {
      await holder.query("BEGIN");
      await holder.query(
        "SELECT pg_advisory_xact_lock($1::integer, hashtext($2))",
        [MEMBERS_LOCK_NAMESPACE, org.id],
      );
      const [self] = (
        await holder.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")
      ).rows;
      const state = { settled: false };
      const pending = accept(org, t.id).finally(() => {
        state.settled = true;
      });
      // The accept's backend waits on an advisory lock (wait_event
      // 'advisory'); a version without lockOrg completes instead.
      let waiting = false;
      for (let i = 0; i < 100 && !waiting && !state.settled; i += 1) {
        const rows = await asAdmin<{ n: number }>(
          "SELECT count(*)::int AS n FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND wait_event = 'advisory' AND pid <> $1",
          [self?.pid ?? 0],
        );
        waiting = (rows[0]?.n ?? 0) > 0;
        if (!waiting) await new Promise((r) => setTimeout(r, 50));
      }
      expect(state.settled).toBe(false);
      expect(waiting).toBe(true);
      expect((await transferRow(t.id))?.status).toBe("pending");
      await holder.query("COMMIT");
      expect((await pending).statusCode).toBe(200);
    } finally {
      await holder.end();
    }
    expect((await transferRow(t.id))?.status).toBe("accepted");
  });

  test("the expiry boundary at the Clock (DW8, S14): 1 ms before expires_at accepts; at expires_at accept is 409 with nothing written (an @Idempotent route stores only a success); a start then records the expiry once, as system, and starts anew", async () => {
    const org = await newOrg();
    const t = transferOf(await start(org), 201);
    const startAt = at;
    try {
      at = Date.parse(t.expiresAt) - 1;
      transferOf(await accept(org, t.id, org.member, { sid: "expiry-sid-1" }));
    } finally {
      at = startAt;
    }
    const org2 = await newOrg();
    const t2 = transferOf(await start(org2), 201);
    try {
      at = Date.parse(t2.expiresAt);
      for (const sid of ["expiry-sid-2", "expiry-sid-3"]) {
        expectProblem(
          await accept(org2, t2.id, org2.member, { sid }),
          409,
          "request.conflict",
        );
      }
      expect((await transferRow(t2.id))?.status).toBe("pending");
      expect(await roleOf(org2, org2.owner)).toBe(org2.ownerRole);
      // The pending row is due: a start expires it in its own transaction
      // (the ownership.expire job and the sweep would too, worker suite).
      const t3 = transferOf(
        await start(org2, {}, { sid: "expiry-sid-4" }),
        201,
      );
      expect(t3.id).not.toBe(t2.id);
    } finally {
      at = startAt;
    }
    expect((await transferRow(t2.id))?.status).toBe("expired");
    expect(
      (await auditActions(t2.id)).filter(
        (a) => a.action === "org.ownership_transfer.expire",
      ),
    ).toEqual([{ action: "org.ownership_transfer.expire", actor_id: null }]);
    expect(await roleOf(org2, org2.owner)).toBe(org2.ownerRole);
  });
});

describe("decline and cancel (DW10, S12)", () => {
  test("the recipient declines; an owner cancels (acr mfa, not fresh); both audited with the recipient's mfa check; a member cannot cancel", async () => {
    const org = await newOrg();
    const t = transferOf(await start(org), 201);
    expectProblem(
      await call(org, org.other, "POST", `${TRANSFERS}/${t.id}/decline`),
      404,
      "not_found",
    );
    const before = await mfaChecks(org.member);
    expect(
      transferOf(
        await call(org, org.member, "POST", `${TRANSFERS}/${t.id}/decline`),
      ),
    ).toMatchObject({ status: "declined", settledBy: org.member });
    expect(await mfaChecks(org.member)).toBe(before + 1);

    const t2 = transferOf(await start(org), 201);
    expectProblem(
      await call(org, org.member, "POST", `${TRANSFERS}/${t2.id}/cancel`),
      403,
      "forbidden",
    );
    expectProblem(
      await call(
        org,
        org.owner,
        "POST",
        `${TRANSFERS}/${t2.id}/cancel`,
        undefined,
        { acr: "pwd" },
      ),
      401,
      "permission.step_up_required",
    );
    const mid = await mfaChecks(org.member);
    expect(
      transferOf(
        await call(
          org,
          org.owner,
          "POST",
          `${TRANSFERS}/${t2.id}/cancel`,
          undefined,
          { authTime: nowS() - 3_600 },
        ),
      ),
    ).toMatchObject({
      status: "cancelled",
      cancelReason: "manual",
      settledBy: org.owner,
    });
    expect(await mfaChecks(org.member)).toBe(mid + 1);
    expect((await auditActions(t2.id)).map((a) => a.action)).toEqual([
      "org.ownership_transfer.start",
      "org.ownership_transfer.cancel",
    ]);
  });
});

describe("cascades in the same transaction (DW9, S13)", () => {
  test("suspending the recipient, removing the recipient, re-roling the recipient, suspending the initiator, archiving the org: each cancels the pending transfer with its cause", async () => {
    const cases: [string, (org: Org) => Promise<Res>, string][] = [
      [
        "recipient suspended",
        async (org) =>
          call(
            org,
            org.owner,
            "POST",
            `${MEMBERS}/${await membershipId(org, org.member)}/suspend`,
            { reason: "cascade" },
          ),
        "recipient_changed",
      ],
      [
        "recipient removed",
        async (org) =>
          call(
            org,
            org.owner,
            "DELETE",
            `${MEMBERS}/${await membershipId(org, org.member)}`,
          ),
        "recipient_changed",
      ],
      [
        "recipient re-roled",
        async (org) =>
          call(
            org,
            org.owner,
            "PATCH",
            `${MEMBERS}/${await membershipId(org, org.member)}`,
            {
              roleId: await seedRole(asAdmin, org.id, "project_manager"),
            },
          ),
        "recipient_changed",
      ],
      [
        "org archived",
        (org) =>
          call(org, org.owner, "POST", "/v1/organizations/current/archive"),
        "org_archived",
      ],
    ];
    for (const [label, act, cause] of cases) {
      const org = await newOrg();
      const t = transferOf(await start(org), 201);
      const res = await act(org);
      expect(res.statusCode, `${label}: ${res.body}`).toBeLessThan(300);
      expect(await transferRow(t.id), label).toMatchObject({
        status: "cancelled",
        cancel_reason: cause,
      });
    }
    // The initiator suspended by a second owner (seeded as a fixture).
    const org = await newOrg();
    const second = seedId();
    await seedUsers(asAdmin, [{ id: second, sub: subOf(second) }]);
    await asAdmin(
      `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 minute')`,
      [seedId(), org.id, second, org.ownerRole],
    );
    const t = transferOf(await start(org), 201);
    const res = await call(
      org,
      second,
      "POST",
      `${MEMBERS}/${await membershipId(org, org.owner)}/suspend`,
      {
        reason: "cascade",
      },
    );
    expect(res.statusCode, res.body).toBe(200);
    expect(await transferRow(t.id)).toMatchObject({
      status: "cancelled",
      cancel_reason: "initiator_changed",
    });
  });
});

describe("a removal is never a 500 (owner review of PR #95, item B)", () => {
  test("removing a member whose rows are newer than the Clock (clock skew) is 204 with a pending transfer: removed_at is the row's created_at, never before it (CHECK *_removed was 23514)", async () => {
    const org = await newOrg();
    const id = await membershipId(org, org.member);
    const t = transferOf(await start(org), 201);
    // The row was written by a clock 5 minutes ahead of this API's Clock.
    await asAdmin(
      "UPDATE bricx.memberships SET created_at = $2::timestamptz + interval '5 minutes' WHERE id = $1",
      [id, new Date(at).toISOString()],
    );
    const res = await call(org, org.owner, "DELETE", `${MEMBERS}/${id}`);
    expect(res.statusCode, res.body).toBe(204);
    const [row] = await asAdmin<{ same: boolean }>(
      "SELECT removed_at = created_at AS same FROM bricx.memberships WHERE id = $1",
      [id],
    );
    expect(row?.same).toBe(true);
    expect(await transferRow(t.id)).toMatchObject({
      status: "cancelled",
      cancel_reason: "recipient_changed",
    });
  });
});

describe("Q6: owner changes outside a transfer (DW13, S26)", () => {
  test("PATCH to or from owner is 409 ownership.transfer_required from the API's own check: no database error, one ownership_transfer_required denial", async () => {
    const org = await newOrg();
    const second = seedId();
    await seedUsers(asAdmin, [{ id: second, sub: subOf(second) }]);
    await asAdmin(
      `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 minute')`,
      [seedId(), org.id, second, org.ownerRole],
    );
    // The API's own check answers ownership.transfer_required; the
    // database guard's P606C, should a request ever reach it, maps to the
    // generic 409 request.conflict and writes no denial. So the code and
    // the denial below prove the API refused first (S26), and either way
    // the answer is a 409, never a 500.
    expectProblem(
      await call(
        org,
        org.owner,
        "PATCH",
        `${MEMBERS}/${await membershipId(org, org.member)}`,
        {
          roleId: org.ownerRole,
        },
      ),
      409,
      "ownership.transfer_required",
    );
    expectProblem(
      await call(
        org,
        org.owner,
        "PATCH",
        `${MEMBERS}/${await membershipId(org, second)}`,
        {
          roleId: org.memberRole,
        },
      ),
      409,
      "ownership.transfer_required",
    );
    expect(await denials(org, "ownership_transfer_required")).toBe(1);
    expect(await roleOf(org, org.member)).toBe(org.memberRole);
    expect(await roleOf(org, second)).toBe(org.ownerRole);
  });

  test("an invitation with the owner role is 422", async () => {
    const org = await newOrg();
    expectProblem(
      await call(org, org.owner, "POST", INVITATIONS, {
        email: "owner-invite@site.example",
        roleId: org.ownerRole,
      }),
      422,
      "validation_failed",
    );
  });
});

describe("logs (DW11)", () => {
  test("the typed organisation name and the tokens never reach a log line", () => {
    const all = lines.join("\n");
    expect(all).not.toContain(ORG_NAME);
    expect(all).not.toContain("Ｆｉｘｔｕｒｅ");
    expect(all).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}/);
  });
});
