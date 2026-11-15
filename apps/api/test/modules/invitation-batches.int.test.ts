// P6-06c (ADR 0085; owner condition C5, plan K3 and K4), against a real
// Postgres 18 with the production journal, through the real app and a
// Clock the tests move. Done-when 14 and 16 (the API half).
// - POST /v1/invitation-batches (org.member.invite, @Idempotent, class
//   invitation): 1 to 200 rows; each row goes through the single invite's
//   own checks (the same validation, the same holdsAll, the owner role
//   refused); a refused row is stored failed with its code and a NULL
//   address in the same INSERT; the rest are pending. 202 {batchId,
//   accepted, failed}. Same transaction: the batch, its rows, ONE
//   invitations.bulk outbox row (the batch id and its author) and ONE
//   org.invitation_batch.create audit event (counts only). One queued or
//   running batch per org (409 invitation.bulk_running); at most 1,000
//   rows per org per 24 h, refused rows included (429
//   invitation.bulk_quota). A replayed key answers the stored 202
//   verbatim and creates nothing; the key with another body is 422; no
//   key is 400.
// - GET /v1/invitation-batches/:id and /:id/rows: counts and per-row
//   results by rowNo; never an address, never a token.
// - The lazy purge (K3, S29): with no worker, a batch read one hour after
//   creation settles every pending row failed / not_processed with its
//   address cleared, and the batch is done, audited once.
// - No address reaches a log line or the outbox.
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
  insertPendingInvitation,
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
import {
  BatchAccepted,
  InvitationBatch,
  InvitationBatchRowList,
  MAX_BATCH_ROWS,
  MAX_ROWS_PER_DAY,
} from "../../src/modules/invitation-batches/invitation-batches.dto.js";
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
const BATCHES = "/v1/invitation-batches";
const HOUR = 3_600_000;
const DAY = 86_400_000;
/** No address may reach a log line, an outbox row, an audit row or a read. */
const NEEDLE = "needle6c";
const email = (n: number, tag = "a") =>
  `${NEEDLE}-${tag}${String(n)}@site.example`;
const FINANCE_KEY = "finance.budget.approve.org";

let pg18: BootstrappedPostgres;
let valkey: StartedValkey;
let issuer: TestIssuer;
let app: NestFastifyApplication;
/** bricx_app, as the worker connects: its insert and mint statements. */
let worker: Database;
let userinfo: (bearer: string) => UserinfoAnswer = () => {
  throw new Error("userinfo not set");
};
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

const subOf = (user: string) => `batch-${user}`;
let keyCounter = 0;
const newKey = () => {
  keyCounter += 1;
  return `batch-key-${String(keyCounter)}`;
};

interface Org {
  id: string;
  owner: string;
  admin: string;
  member: string;
  ownerRole: string;
  memberRole: string;
  financeRole: string;
  project: string;
  archivedProject: string;
}

/** A fresh org: an owner, a member admin (member keys only), a plain member. */
async function newOrg(): Promise<Org> {
  const id = seedId();
  const org: Org = {
    id,
    owner: seedId(),
    admin: seedId(),
    member: seedId(),
    ownerRole: "",
    memberRole: "",
    financeRole: "",
    project: seedId(),
    archivedProject: seedId(),
  };
  await seedUsers(
    asAdmin,
    [org.owner, org.admin, org.member].map((u) => ({ id: u, sub: subOf(u) })),
  );
  await applyAccess(asAdmin, { orgId: id, userId: org.owner, role: "owner" });
  const adminRole = await seedRole(asAdmin, id, "memberadmin");
  for (const permission of [
    "org.member.read.org",
    "org.member.invite.org",
    "project.member.assign.org",
  ]) {
    await asAdmin(
      `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
      [seedId(), id, adminRole, permission],
    );
  }
  await applyAccess(asAdmin, {
    orgId: id,
    userId: org.admin,
    role: "memberadmin",
  });
  await applyAccess(asAdmin, { orgId: id, userId: org.member, role: "member" });
  org.ownerRole = await seedRole(asAdmin, id, "owner");
  org.memberRole = await seedRole(asAdmin, id, "member");
  org.financeRole = await seedRole(asAdmin, id, "finrole");
  await asAdmin(
    `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
     VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
    [seedId(), id, org.financeRole, FINANCE_KEY],
  );
  await seedProjects(asAdmin, id, [org.project, org.archivedProject]);
  await asAdmin(
    "UPDATE bricx.projects SET status = 'archived', archived_at = now() WHERE id = $1",
    [org.archivedProject],
  );
  return org;
}

type Res = Awaited<ReturnType<NestFastifyApplication["inject"]>>;
async function call(
  org: Org,
  user: string,
  method: "GET" | "POST",
  url: string,
  body?: unknown,
  options: { key?: string | null; sid?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = bearer(
    await issuer.token({
      sub: subOf(user),
      org_id: org.id,
      acr: "mfa",
      auth_time: nowS(),
      ...(options.sid === undefined ? {} : { sid: options.sid }),
    }),
  );
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

const acceptedOf = (res: Res) => {
  expect(res.statusCode, res.body).toBe(202);
  return BatchAccepted.schema.parse(JSON.parse(res.body));
};

const submit = (org: Org, rows: unknown[], user = org.owner, options = {}) =>
  call(org, user, "POST", BATCHES, { rows }, options);

const plainRows = (org: Org, count: number, tag = "a") =>
  Array.from({ length: count }, (_, i) => ({
    email: email(i + 1, tag),
    roleId: org.memberRole,
  }));

/** Settles a batch as the worker would (for the caps tests). */
async function finish(batchId: string): Promise<void> {
  await asAdmin(
    `UPDATE bricx.invitation_batch_rows SET status = 'failed', error_code = 'not_processed',
       email_normalised = NULL, updated_at = now()
     WHERE batch_id = $1 AND status = 'pending'`,
    [batchId],
  );
  await asAdmin(
    "UPDATE bricx.invitation_batches SET status = 'done', updated_at = now() WHERE id = $1",
    [batchId],
  );
}

const rowsOf = (batchId: string) =>
  asAdmin<{
    row_no: number;
    status: string;
    error_code: string | null;
    email_normalised: string | null;
  }>(
    `SELECT row_no, status, error_code, email_normalised
     FROM bricx.invitation_batch_rows WHERE batch_id = $1 ORDER BY row_no`,
    [batchId],
  );

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
        RATE_LIMIT_INVITATION: "ip=100000,user=100000,org=100000,window=3600",
      }),
    ),
    {
      probes: fakeProbes(),
      revocationStore: fixedRevocations(),
      rateLimitStore: memoryRateLimits(),
      clock: { now: () => at },
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
  worker = openDatabase({
    reveal: () => urlFor("bricx_app", "BRICX_APP_PASSWORD"),
  });
}, HOOK_MS);
afterAll(async () => {
  await worker.close().catch(() => undefined);
  await app.close().catch(() => undefined);
  await issuer.close();
  await valkey.stop();
  await pg18.container.stop();
}, HOOK_MS);

describe("submit (DW14)", () => {
  test("202: every row checked like a single invite; refused rows failed with their code and a NULL address from the start; one outbox row, one audit event, counts only", async () => {
    const org = await newOrg();
    const rows = [
      { email: email(1), roleId: org.memberRole },
      { email: "not-an-address", roleId: org.memberRole },
      { email: email(3), roleId: seedId() },
      { email: email(4), roleId: org.ownerRole },
      { email: email(5), roleId: org.financeRole },
      {
        email: email(6),
        roleId: org.memberRole,
        projectId: org.archivedProject,
        projectRoleId: org.memberRole,
      },
      {
        email: email(7),
        roleId: org.memberRole,
        projectId: org.project,
        projectRoleId: org.memberRole,
      },
      { email: email(8), roleId: org.memberRole, unknownField: true },
    ];
    const res = await submit(org, rows, org.admin);
    const body = acceptedOf(res);
    expect(body).toEqual({ batchId: body.batchId, accepted: 2, failed: 6 });
    expect(await rowsOf(body.batchId)).toEqual([
      {
        row_no: 1,
        status: "pending",
        error_code: null,
        email_normalised: email(1),
      },
      {
        row_no: 2,
        status: "failed",
        error_code: "validation_failed",
        email_normalised: null,
      },
      {
        row_no: 3,
        status: "failed",
        error_code: "not_found",
        email_normalised: null,
      },
      {
        row_no: 4,
        status: "failed",
        error_code: "owner_role",
        email_normalised: null,
      },
      // The member admin does not hold the finance key (holdsAll).
      {
        row_no: 5,
        status: "failed",
        error_code: "escalation",
        email_normalised: null,
      },
      {
        row_no: 6,
        status: "failed",
        error_code: "project_archived",
        email_normalised: null,
      },
      {
        row_no: 7,
        status: "pending",
        error_code: null,
        email_normalised: email(7),
      },
      {
        row_no: 8,
        status: "failed",
        error_code: "validation_failed",
        email_normalised: null,
      },
    ]);
    expect(
      await asAdmin(
        "SELECT topic, payload FROM bricx.outbox WHERE payload->>'batchId' = $1",
        [body.batchId],
      ),
    ).toEqual([
      {
        topic: "invitations.bulk",
        payload: { batchId: body.batchId, createdBy: org.admin },
      },
    ]);
    expect(
      await asAdmin(
        "SELECT action, after FROM bricx.audit_events WHERE entity_id = $1 ORDER BY seq",
        [body.batchId],
      ),
    ).toEqual([
      {
        action: "org.invitation_batch.create",
        after: { rowCount: 8, accepted: 2, failed: 6 },
      },
      // Row 5's escalation: one deduplicated denial, after the commit.
      { action: "org.invitation.denied", after: { reason: "escalation" } },
    ]);
    // No invitation exists yet: the worker creates them.
    expect(
      await asAdmin("SELECT 1 FROM bricx.invitations WHERE org_id = $1", [
        org.id,
      ]),
    ).toEqual([]);
  });

  test("bounds: 0 or 201 rows, a non-array, a non-JSON body are 422; no key is 400; a member without org.member.invite is 403", async () => {
    const org = await newOrg();
    expect(MAX_BATCH_ROWS).toBe(200);
    for (const body of [
      { rows: [] },
      { rows: plainRows(org, 201) },
      { rows: "x" },
      { rows: plainRows(org, 1), extra: 1 },
    ]) {
      expectProblem(
        await call(org, org.owner, "POST", BATCHES, body),
        422,
        "validation_failed",
      );
    }
    expectProblem(
      await submit(org, plainRows(org, 1), org.owner, { key: null }),
      400,
      "idempotency.key_missing",
    );
    expectProblem(
      await submit(org, plainRows(org, 1), org.member),
      403,
      "forbidden",
    );
    expect(
      await asAdmin(
        "SELECT 1 FROM bricx.invitation_batches WHERE org_id = $1",
        [org.id],
      ),
    ).toEqual([]);
  });

  test("one queued or running batch per org: a second is 409 invitation.bulk_running; another org is not blocked", async () => {
    const org = await newOrg();
    const first = acceptedOf(await submit(org, plainRows(org, 2)));
    expectProblem(
      await submit(org, plainRows(org, 2, "b")),
      409,
      "invitation.bulk_running",
    );
    const other = await newOrg();
    acceptedOf(await submit(other, plainRows(other, 2)));
    await finish(first.batchId);
    acceptedOf(await submit(org, plainRows(org, 2, "c")));
  });

  test("the quota (K4, S28): 1,000 rows per org per 24 h, refused rows included; the 1,001st is 429 invitation.bulk_quota", async () => {
    const org = await newOrg();
    expect(MAX_ROWS_PER_DAY).toBe(1_000);
    for (let i = 0; i < 5; i += 1) {
      // Every row of the last batch is refused: it still counts.
      const rows =
        i === 4
          ? Array.from({ length: 200 }, () => ({
              email: "bad",
              roleId: org.memberRole,
            }))
          : plainRows(org, 200, `q${String(i)}-`);
      const b = acceptedOf(await submit(org, rows));
      await finish(b.batchId);
    }
    expectProblem(
      await submit(org, plainRows(org, 1, "over")),
      429,
      "invitation.bulk_quota",
    );
    // 24 h later the window has moved.
    const startAt = at;
    try {
      at += DAY + 1_000;
      acceptedOf(
        await submit(org, plainRows(org, 1, "next"), org.owner, {
          sid: "quota-sid",
        }),
      );
    } finally {
      at = startAt;
    }
  });

  test("replay (K4, S30): the same key and body answers the stored 202 verbatim and creates nothing; the key with another body is 422; after 24 h the key is new", async () => {
    const org = await newOrg();
    const key = newKey();
    const rows = plainRows(org, 3);
    const first = await submit(org, rows, org.owner, { key });
    const body = acceptedOf(first);
    const again = await submit(org, rows, org.owner, { key });
    expect(again.statusCode).toBe(202);
    expect(again.body).toBe(first.body);
    expect(again.headers["idempotent-replayed"]).toBe("true");
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM bricx.invitation_batches WHERE org_id = $1",
        [org.id],
      ),
    ).toEqual([{ n: 1 }]);
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM bricx.outbox WHERE topic = 'invitations.bulk' AND payload->>'batchId' = $1",
        [body.batchId],
      ),
    ).toEqual([{ n: 1 }]);
    expectProblem(
      await submit(org, plainRows(org, 2), org.owner, { key }),
      422,
      "idempotency.key_reused",
    );
    await finish(body.batchId);
    // The key store keeps a key 24 h by the database clock: aged here.
    await asAdmin(
      `UPDATE bricx.idempotency_keys SET created_at = created_at - interval '25 hours',
         expires_at = expires_at - interval '25 hours' WHERE key = $1`,
      [key],
    );
    const startAt = at;
    try {
      at += DAY + 1_000;
      const later = acceptedOf(
        await submit(org, rows, org.owner, { key, sid: "replay-sid" }),
      );
      expect(later.batchId).not.toBe(body.batchId);
    } finally {
      at = startAt;
    }
  });

  test("concurrent submits with one key give one batch", async () => {
    const org = await newOrg();
    const key = newKey();
    const rows = plainRows(org, 2);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => submit(org, rows, org.owner, { key })),
    );
    expect(results.filter((r) => r.statusCode >= 500)).toEqual([]);
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM bricx.invitation_batches WHERE org_id = $1",
        [org.id],
      ),
    ).toEqual([{ n: 1 }]);
  });
});

describe("reads", () => {
  test("GET the batch and its rows: counts and per-row results by rowNo, never an address; another org is 404; limit and cursor", async () => {
    const org = await newOrg();
    const b = acceptedOf(
      await submit(org, [
        ...plainRows(org, 3),
        { email: "bad", roleId: org.memberRole },
      ]),
    );
    const res = await call(org, org.admin, "GET", `${BATCHES}/${b.batchId}`);
    expect(res.statusCode, res.body).toBe(200);
    expect(InvitationBatch.schema.parse(JSON.parse(res.body))).toMatchObject({
      id: b.batchId,
      status: "queued",
      rowCount: 4,
      createdCount: 0,
      failedCount: 1,
    });
    const page1 = await call(
      org,
      org.admin,
      "GET",
      `${BATCHES}/${b.batchId}/rows?limit=2`,
    );
    expect(page1.statusCode, page1.body).toBe(200);
    const list1 = InvitationBatchRowList.schema.parse(JSON.parse(page1.body));
    expect(list1.items.map((r) => r.rowNo)).toEqual([1, 2]);
    expect(list1.nextCursor).not.toBeNull();
    const page2 = await call(
      org,
      org.admin,
      "GET",
      `${BATCHES}/${b.batchId}/rows?limit=2&cursor=${list1.nextCursor ?? ""}`,
    );
    const list2 = InvitationBatchRowList.schema.parse(JSON.parse(page2.body));
    expect(list2.items).toEqual([
      { rowNo: 3, status: "pending", errorCode: null, invitationId: null },
      {
        rowNo: 4,
        status: "failed",
        errorCode: "validation_failed",
        invitationId: null,
      },
    ]);
    for (const body of [res.body, page1.body, page2.body]) {
      expect(body).not.toContain("@");
      expect(body).not.toContain(NEEDLE);
    }
    expectProblem(
      await call(
        org,
        org.admin,
        "GET",
        `${BATCHES}/${b.batchId}/rows?limit=101`,
      ),
      422,
      "validation_failed",
    );
    const other = await newOrg();
    expectProblem(
      await call(other, other.owner, "GET", `${BATCHES}/${b.batchId}`),
      404,
      "not_found",
    );
    expectProblem(
      await call(org, org.member, "GET", `${BATCHES}/${b.batchId}`),
      403,
      "forbidden",
    );
  });
});

describe("the lazy purge (DW16, K3, S29)", () => {
  test("no worker: a read one hour after creation settles every pending row not_processed with its address cleared; the batch is done and audited once; a later submit is allowed", async () => {
    const org = await newOrg();
    const b = acceptedOf(await submit(org, plainRows(org, 3)));
    // 59 minutes: nothing changes.
    const startAt = at;
    try {
      at += HOUR - 60_000;
      await call(org, org.owner, "GET", `${BATCHES}/${b.batchId}`, undefined, {
        sid: "purge-1",
      });
      expect((await rowsOf(b.batchId)).map((r) => r.status)).toEqual([
        "pending",
        "pending",
        "pending",
      ]);
      at = startAt + HOUR;
      const res = await call(
        org,
        org.owner,
        "GET",
        `${BATCHES}/${b.batchId}`,
        undefined,
        { sid: "purge-2" },
      );
      expect(res.statusCode, res.body).toBe(200);
      expect(InvitationBatch.schema.parse(JSON.parse(res.body))).toMatchObject({
        status: "done",
        failedCount: 3,
      });
      expect(await rowsOf(b.batchId)).toEqual(
        [1, 2, 3].map((n) => ({
          row_no: n,
          status: "failed",
          error_code: "not_processed",
          email_normalised: null,
        })),
      );
      await call(org, org.owner, "GET", `${BATCHES}/${b.batchId}`, undefined, {
        sid: "purge-3",
      });
      expect(
        await asAdmin(
          "SELECT action FROM bricx.audit_events WHERE entity_id = $1 ORDER BY seq",
          [b.batchId],
        ),
      ).toEqual([
        { action: "org.invitation_batch.create" },
        { action: "org.invitation_batch.complete" },
      ]);
      // A submit in the org purges too, and is then allowed.
      const c = acceptedOf(
        await submit(org, plainRows(org, 1, "z"), org.owner, {
          sid: "purge-4",
        }),
      );
      at += HOUR;
      acceptedOf(
        await submit(org, plainRows(org, 1, "y"), org.owner, {
          sid: "purge-5",
        }),
      );
      expect((await rowsOf(c.batchId))[0]).toMatchObject({
        status: "failed",
        error_code: "not_processed",
        email_normalised: null,
      });
    } finally {
      at = startAt;
    }
  });
});

describe("the owner role and the idempotency store (owner conditions 3 and 4, 2026-11-13)", () => {
  test("the single invite and a bulk row refuse the owner role (org role or project role) with the same code from the same check, ownerRoleRefusal: the single invite answers it as 422 at roleId, the bulk row stores owner_role", async () => {
    const org = await newOrg();
    const orgOwner = { email: email(1, "own"), roleId: org.ownerRole };
    const projectOwner = {
      email: email(2, "own"),
      roleId: org.memberRole,
      projectId: org.project,
      projectRoleId: org.ownerRole,
    };
    for (const row of [orgOwner, projectOwner]) {
      const single = await call(org, org.owner, "POST", "/v1/invitations", row);
      expectProblem(single, 422, "validation_failed");
      expect(JSON.parse(single.body)).toMatchObject({
        issues: [{ path: ["roleId"] }],
      });
    }
    const batch = acceptedOf(await submit(org, [orgOwner, projectOwner]));
    expect(batch).toMatchObject({ accepted: 0, failed: 2 });
    expect(await rowsOf(batch.batchId)).toEqual([
      {
        row_no: 1,
        status: "failed",
        error_code: "owner_role",
        email_normalised: null,
      },
      {
        row_no: 2,
        status: "failed",
        error_code: "owner_role",
        email_normalised: null,
      },
    ]);
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM bricx.invitations WHERE org_id = $1",
        [org.id],
      ),
    ).toEqual([{ n: 0 }]);
  });

  test("the idempotency_keys row of a bulk submit holds exactly the 202 answer {batchId, accepted, failed}: no address, no token, no role or project input of any row, failed or pending", async () => {
    const org = await newOrg();
    const key = newKey();
    const rows = [
      { email: email(1, "idem"), roleId: org.memberRole },
      { email: email(2, "idem"), roleId: org.ownerRole },
      { email: email(3, "idem"), roleId: org.financeRole },
      {
        email: email(4, "idem"),
        roleId: org.memberRole,
        projectId: org.archivedProject,
        projectRoleId: org.memberRole,
      },
    ];
    const answer = acceptedOf(await submit(org, rows, org.admin, { key }));
    expect(answer).toMatchObject({ accepted: 1, failed: 3 });
    const stored = await asAdmin<{
      response: string | null;
      headers: unknown;
      route: string;
    }>(
      "SELECT response, headers, route FROM bricx.idempotency_keys WHERE org_id = $1 AND key = $2",
      [org.id, key],
    );
    expect(stored).toHaveLength(1);
    const [entry] = stored;
    expect(entry?.route).toBe("POST /v1/invitation-batches");
    const response = entry?.response ?? "";
    expect(Object.keys(JSON.parse(response) as object).sort()).toEqual([
      "accepted",
      "batchId",
      "failed",
    ]);
    expect(JSON.parse(response)).toEqual(answer);
    const text = `${response} ${JSON.stringify(entry?.headers ?? null)}`;
    for (const forbidden of [
      NEEDLE,
      "@site.example",
      "token",
      org.ownerRole,
      org.memberRole,
      org.financeRole,
      org.project,
      org.archivedProject,
    ]) {
      expect(text).not.toContain(forbidden);
    }
  });
});

describe("logs and the outbox (DW15, S22)", () => {
  test("no address in any log line, any outbox row or any audit row", async () => {
    expect(lines.join("\n")).not.toContain(NEEDLE);
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM bricx.outbox WHERE payload::text LIKE $1",
        [`%${NEEDLE}%`],
      ),
    ).toEqual([{ n: 0 }]);
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM bricx.audit_events WHERE coalesce(before::text, '') || coalesce(after::text, '') LIKE $1",
        [`%${NEEDLE}%`],
      ),
    ).toEqual([{ n: 0 }]);
  });
});

describe("an inviter demoted before the worker runs (DW17, K5): the API half", () => {
  test("the row's invitation, made by the worker's own insert for the demoted inviter, is refused at accept with the uniform 404 and revoked inviter_lacks_rights", async () => {
    const org = await newOrg();
    const target = email(1, "k5");
    const b = acceptedOf(
      await submit(org, [{ email: target, roleId: org.memberRole }], org.admin),
    );
    // Demoted as the test superuser after the submit: still an active
    // member, without org.member.invite.
    const [membership] = await asAdmin<{ id: string }>(
      "SELECT id::text FROM bricx.memberships WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL",
      [org.id, org.admin],
    );
    await asAdmin("UPDATE bricx.memberships SET role_id = $1 WHERE id = $2", [
      org.memberRole,
      membership?.id,
    ]);
    // The worker's step for row 1: insertPendingInvitation as the inviter
    // (the bulk consumer's statement; the worker suite runs the consumer).
    const invitationId = seedId();
    const nowIso = new Date(at).toISOString();
    await worker.withTx(
      { orgId: org.id, userId: org.admin, projectIds: [] },
      async (tx) => {
        const row = await insertPendingInvitation(tx, {
          id: invitationId,
          orgId: org.id,
          projectId: null,
          email: target,
          roleId: org.memberRole,
          projectRoleId: null,
          invitedBy: org.admin,
          expiresAt: new Date(at + 72 * HOUR).toISOString(),
          now: nowIso,
          external: false,
          membershipExpiresAt: null,
        });
        expect(row?.id).toBe(invitationId);
      },
    );
    // The send step mints the token (the e-mail goes out: the worker suite).
    const secret = newInvitationSecret();
    const minted = await worker.withTx(
      { orgId: org.id, userId: org.admin, projectIds: [] },
      (tx) =>
        mintInvitationToken(tx, {
          id: invitationId,
          sendSeq: 1,
          hash: hashInvitationSecret(secret),
          now: nowIso,
        }),
    );
    expect(minted?.id).toBe(invitationId);
    const invitee = seedId();
    await seedUsers(asAdmin, [{ id: invitee, sub: subOf(invitee) }]);
    userinfo = () => ({
      sub: subOf(invitee),
      email: target,
      emailVerified: true,
    });
    const res = await app.inject({
      method: "POST",
      url: "/v1/invitations/accept",
      headers: {
        ...bearer(await issuer.token({ sub: subOf(invitee), acr: "mfa" })),
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        token: invitationTokenOf("af-south-1", secret),
      }),
    });
    expectProblem(res, 404, "invitation.unavailable");
    expect(
      await asAdmin(
        "SELECT status, revoke_reason FROM bricx.invitations WHERE id = $1",
        [invitationId],
      ),
    ).toEqual([{ status: "revoked", revoke_reason: "inviter_lacks_rights" }]);
    expect(b.accepted).toBe(1);
  });
});
