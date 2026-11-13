// P6-06c (ADR 0085; owner condition C5, plan K3 and K5; Done-when 15-17),
// live: the bulk consumer against compose.yml's Postgres. Batches and rows
// are seeded as the test superuser in the API's INSERT shape (a refused
// row already failed with a NULL address); the consumer runs as bricx_app
// through the real job routing (processInvitationJob, topic
// invitations.bulk) and the real send step with the Null e-mail adapter.
// - Each pending row becomes an invitation through insertPendingInvitation,
//   the single invite's own statement: the same row, one invitations.send
//   outbox row {invitationId, sendSeq, invitedBy}, one org.invitation.create
//   event; the row settles created with its invitation id and a NULL
//   address in the same UPDATE. A pending invitation for the address
//   already: the row fails pending_exists. The batch ends done with its
//   counts and one org.invitation_batch.complete event.
// - Idempotent (S20): a second run of the same job, or a run after a crash
//   half way (some rows settled), creates no duplicate.
// - The inviter re-checked (S17): suspended or removed before the run, every
//   pending row fails inviter_inactive; an archived org, org_archived.
// - K5: an inviter demoted (still active, lost the key) before the run: the
//   invitation is created and the e-mail IS sent (the Null adapter's
//   record); the API's accept then refuses it (the API suite).
// - The sweep (K3): a batch still queued one hour after creation has every
//   pending row failed not_processed with its address cleared, the batch
//   done, audited once; a second sweep does nothing.
// - No address, no token, no secret in any line, outbox row or audit row.
import { type EmailMessage } from "@bricx/adapters/types";
import { createNullEmail } from "@bricx/adapters/email";
import { seedOrganization } from "@bricx/db-bootstrap/fixtures";
import {
  type Database,
  type RelayDatabase,
  openDatabase,
  openRelayDatabase,
} from "@bricx/db/database";
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  INVITATIONS_BULK,
  INVITATIONS_SWEEP,
  type InvitationDeps,
  processInvitationJob,
} from "../src/invitations/consumer.js";
import {
  type InvitationBatchProcessor,
  createInvitationBatchProcessor,
} from "../src/invitations/bulk.js";
import {
  dueInvitationReader,
  staleBatchReader,
} from "../src/invitations/due.js";
import { createInvitationExpirer } from "../src/invitations/expiry.js";
import { createInvitationSender } from "../src/invitations/send.js";
import type { RelayLogger } from "../src/relay/relay.js";
import { type Stack, startStack } from "./stack.js";

const HOOK_MS = 600_000;
const NEEDLE = "needle6c-w";
const ids = createUuidV7Generator({ clock: { now: () => Date.now() } });

interface Logged {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  fields: Record<string, unknown>;
}
function recorder(): RelayLogger & { lines: Logged[] } {
  const lines: Logged[] = [];
  const at =
    (level: Logged["level"]) =>
    (fields: Record<string, unknown>, msg: string) => {
      lines.push({ level, msg, fields });
    };
  return {
    lines,
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
  };
}

let stack: Stack;
let app: Database;
let relayDb: RelayDatabase;
let processor: InvitationBatchProcessor;
let deps: InvitationDeps;
const log = recorder();
const captured: EmailMessage[] = [];
let outboxSeq = 0;

async function asAdmin<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await stack.postgres.admin();
  try {
    return (await client.query<T>(text, params)).rows;
  } finally {
    await client.end();
  }
}

interface Org {
  id: string;
  inviter: string;
  inviterMembership: string;
  role: string;
  inviterRole: string;
}

let userSeq = 0;
async function seedUser(): Promise<string> {
  userSeq += 1;
  const id = ids.next();
  await asAdmin(
    `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
     VALUES ($1, $2, now(), now())`,
    [id, `bulk-${String(userSeq)}`],
  );
  return id;
}

async function newOrg(): Promise<Org> {
  const id = ids.next();
  await seedOrganization(asAdmin, id);
  const role = ids.next();
  const inviterRole = ids.next();
  for (const [roleId, key] of [
    [role, "member"],
    [inviterRole, "memberadmin"],
  ] as const) {
    await asAdmin(
      `INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at)
       VALUES ($1, $2, $3, $3, NULL, now() - interval '1 hour', now() - interval '1 hour')`,
      [roleId, id, key],
    );
  }
  for (const permission of ["org.member.read.org", "org.member.invite.org"]) {
    await asAdmin(
      `INSERT INTO bricx.role_permissions (id, org_id, role_id, permission, granted_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
      [ids.next(), id, inviterRole, permission],
    );
  }
  const inviter = await seedUser();
  const inviterMembership = ids.next();
  await asAdmin(
    `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at)
     VALUES ($1, $2, $3, $4, now() - interval '1 hour')`,
    [inviterMembership, id, inviter, inviterRole],
  );
  return { id, inviter, inviterMembership, role, inviterRole };
}

const address = (n: number, tag: string) =>
  `${NEEDLE}-${tag}${String(n)}@site.example`;

/** A batch in the API's shape: `pending` addresses, then `failed` refused rows. */
async function seedBatch(
  org: Org,
  pending: string[],
  failed = 0,
  createdAgo = "1 minute",
): Promise<string> {
  const id = ids.next();
  await asAdmin(
    `INSERT INTO bricx.invitation_batches (id, org_id, created_by, row_count, failed_count, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now() - $6::interval, now() - $6::interval)`,
    [id, org.id, org.inviter, pending.length + failed, failed, createdAgo],
  );
  let rowNo = 0;
  for (const email of pending) {
    rowNo += 1;
    await asAdmin(
      `INSERT INTO bricx.invitation_batch_rows (org_id, batch_id, row_no, email_normalised, role_id, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())`,
      [org.id, id, rowNo, email, org.role],
    );
  }
  for (let i = 0; i < failed; i += 1) {
    rowNo += 1;
    await asAdmin(
      `INSERT INTO bricx.invitation_batch_rows (org_id, batch_id, row_no, email_normalised, role_id, status, error_code, updated_at)
       VALUES ($1, $2, $3, NULL, $4, 'failed', 'validation_failed', now())`,
      [org.id, id, rowNo, org.role],
    );
  }
  return id;
}

const bulkJob = (org: Org, batchId: string) => {
  outboxSeq += 1;
  return {
    name: INVITATIONS_BULK,
    data: {
      outboxId: String(9_000_000 + outboxSeq),
      orgId: org.id,
      topic: INVITATIONS_BULK,
      payload: { batchId, createdBy: org.inviter },
    },
    attemptsMade: 0,
    opts: {},
  };
};

const rowsOf = (batchId: string) =>
  asAdmin<{
    row_no: number;
    status: string;
    error_code: string | null;
    email_normalised: string | null;
    has_invitation: boolean;
  }>(
    `SELECT row_no, status, error_code, email_normalised, invitation_id IS NOT NULL AS has_invitation
     FROM bricx.invitation_batch_rows WHERE batch_id = $1 ORDER BY row_no`,
    [batchId],
  );
const batchOf = async (batchId: string) =>
  (
    await asAdmin<{
      status: string;
      created_count: number;
      failed_count: number;
    }>(
      "SELECT status, created_count, failed_count FROM bricx.invitation_batches WHERE id = $1",
      [batchId],
    )
  )[0];
const invitationsOf = (org: Org) =>
  asAdmin<{
    id: string;
    email_normalised: string;
    invited_by: string;
    role_id: string;
    status: string;
    send_seq: number;
    token_hash: Buffer | null;
  }>(
    `SELECT id::text, email_normalised, invited_by::text, role_id::text, status, send_seq, token_hash
     FROM bricx.invitations WHERE org_id = $1 ORDER BY email_normalised`,
    [org.id],
  );

beforeAll(async () => {
  stack = await startStack();
  app = openDatabase({ reveal: () => stack.url("bricx_app") });
  relayDb = openRelayDatabase({ reveal: () => stack.url("bricx_relay") });
  const clock = { now: () => Date.now() };
  processor = createInvitationBatchProcessor({
    database: app,
    clock,
    ids,
    logger: log,
  });
  deps = {
    sender: createInvitationSender({
      database: app,
      clock,
      email: createNullEmail({ capture: (message) => captured.push(message) }),
      linkBase: "https://app.bricx.example",
      cellId: "af-south-1",
    }),
    activator: {
      activate: () => Promise.reject(new Error("not in this suite")),
    },
    expirer: createInvitationExpirer({ database: app, clock, ids }),
    due: dueInvitationReader(relayDb),
    logger: log,
    batches: processor,
    staleBatches: staleBatchReader(relayDb),
  };
}, HOOK_MS);
afterAll(async () => {
  await app.close().catch(() => undefined);
  await relayDb.close().catch(() => undefined);
  await stack.stop();
}, HOOK_MS);

describe("the bulk job (DW15)", () => {
  test("each pending row becomes an invitation by the single invite's statement; rows settle with their invitation and a NULL address; the batch is done with its counts and one complete event; nothing is minted here", async () => {
    const org = await newOrg();
    const batch = await seedBatch(org, [address(1, "a"), address(2, "a")], 1);
    await processInvitationJob(bulkJob(org, batch), deps);
    expect(await rowsOf(batch)).toEqual([
      {
        row_no: 1,
        status: "created",
        error_code: null,
        email_normalised: null,
        has_invitation: true,
      },
      {
        row_no: 2,
        status: "created",
        error_code: null,
        email_normalised: null,
        has_invitation: true,
      },
      {
        row_no: 3,
        status: "failed",
        error_code: "validation_failed",
        email_normalised: null,
        has_invitation: false,
      },
    ]);
    expect(await batchOf(batch)).toEqual({
      status: "done",
      created_count: 2,
      failed_count: 1,
    });
    const invitations = await invitationsOf(org);
    expect(
      invitations.map((i) => [
        i.email_normalised,
        i.invited_by,
        i.role_id,
        i.status,
        i.send_seq,
        i.token_hash,
      ]),
    ).toEqual([
      [address(1, "a"), org.inviter, org.role, "pending", 1, null],
      [address(2, "a"), org.inviter, org.role, "pending", 1, null],
    ]);
    for (const inv of invitations) {
      expect(
        await asAdmin(
          "SELECT topic, payload FROM bricx.outbox WHERE payload->>'invitationId' = $1",
          [inv.id],
        ),
      ).toEqual([
        {
          topic: "invitations.send",
          payload: { invitationId: inv.id, sendSeq: 1, invitedBy: org.inviter },
        },
      ]);
      expect(
        await asAdmin<{ action: string; actor_id: string }>(
          "SELECT action, actor_id::text FROM bricx.audit_events WHERE entity_id = $1 ORDER BY seq",
          [inv.id],
        ),
      ).toEqual([{ action: "org.invitation.create", actor_id: org.inviter }]);
    }
    expect(
      await asAdmin(
        "SELECT action, after FROM bricx.audit_events WHERE entity_id = $1 ORDER BY seq",
        [batch],
      ),
    ).toEqual([
      {
        action: "org.invitation_batch.complete",
        after: { created: 2, failed: 1 },
      },
    ]);
  });

  test("an address with a pending invitation already fails pending_exists; the others go on", async () => {
    const org = await newOrg();
    const first = await seedBatch(org, [address(1, "dup")]);
    await processInvitationJob(bulkJob(org, first), deps);
    const second = await seedBatch(org, [address(1, "dup"), address(2, "dup")]);
    await processInvitationJob(bulkJob(org, second), deps);
    expect(
      (await rowsOf(second)).map((r) => [
        r.status,
        r.error_code,
        r.email_normalised,
      ]),
    ).toEqual([
      ["failed", "pending_exists", null],
      ["created", null, null],
    ]);
    expect(await invitationsOf(org)).toHaveLength(2);
  });

  test("idempotent (S20): the same job twice, and a run after a crash half way, create no duplicate", async () => {
    const org = await newOrg();
    const batch = await seedBatch(
      org,
      [1, 2, 3].map((n) => address(n, "idem")),
    );
    // A crash half way: row 1 settled by an earlier attempt (its invitation
    // made through the same path), rows 2 and 3 still pending.
    await processor.processRows(
      { batchId: batch, orgId: org.id, createdBy: org.inviter },
      "crash",
      1,
    );
    expect((await rowsOf(batch)).map((r) => r.status)).toEqual([
      "created",
      "pending",
      "pending",
    ]);
    await processInvitationJob(bulkJob(org, batch), deps);
    await processInvitationJob(bulkJob(org, batch), deps);
    expect((await rowsOf(batch)).map((r) => r.status)).toEqual([
      "created",
      "created",
      "created",
    ]);
    expect(await invitationsOf(org)).toHaveLength(3);
    expect(
      await asAdmin(
        "SELECT count(*)::int AS n FROM bricx.audit_events WHERE entity_id = $1 AND action = 'org.invitation_batch.complete'",
        [batch],
      ),
    ).toEqual([{ n: 1 }]);
  });
});

describe("the inviter re-checked at the run (DW17, S17, K5)", () => {
  test("suspended or removed: every pending row fails inviter_inactive; an archived org: org_archived; no invitation", async () => {
    for (const change of ["suspend", "remove", "archive"] as const) {
      const org = await newOrg();
      const batch = await seedBatch(org, [
        address(1, change),
        address(2, change),
      ]);
      if (change === "suspend") {
        await asAdmin(
          `UPDATE bricx.memberships SET suspended_at = now(), suspended_by = user_id, suspend_reason = 'x' WHERE id = $1`,
          [org.inviterMembership],
        );
      } else if (change === "remove") {
        await asAdmin(
          "UPDATE bricx.memberships SET removed_at = now() WHERE id = $1",
          [org.inviterMembership],
        );
      } else {
        await asAdmin(
          "UPDATE bricx.organizations SET archived_at = now() WHERE id = $1",
          [org.id],
        );
      }
      await processInvitationJob(bulkJob(org, batch), deps);
      const code = change === "archive" ? "org_archived" : "inviter_inactive";
      expect(
        (await rowsOf(batch)).map((r) => [
          r.status,
          r.error_code,
          r.email_normalised,
        ]),
      ).toEqual([
        ["failed", code, null],
        ["failed", code, null],
      ]);
      expect(await invitationsOf(org)).toEqual([]);
      expect(await batchOf(batch)).toEqual({
        status: "done",
        created_count: 0,
        failed_count: 2,
      });
    }
  });

  test("demoted (still active, lost org.member.invite): the invitation is created and its e-mail IS sent (the Null adapter's record); the API's accept refuses it (K5)", async () => {
    const org = await newOrg();
    const email = address(1, "demoted");
    const batch = await seedBatch(org, [email]);
    await asAdmin(
      "UPDATE bricx.role_permissions SET revoked_at = now() WHERE role_id = $1 AND permission = 'org.member.invite.org'",
      [org.inviterRole],
    );
    await processInvitationJob(bulkJob(org, batch), deps);
    const [inv] = await invitationsOf(org);
    expect(inv?.status).toBe("pending");
    const before = captured.length;
    await processInvitationJob(
      {
        name: "invitations.send",
        data: {
          outboxId: "9999999",
          orgId: org.id,
          topic: "invitations.send",
          payload: {
            invitationId: inv?.id,
            sendSeq: 1,
            invitedBy: org.inviter,
          },
        },
        attemptsMade: 0,
        opts: {},
      },
      deps,
    );
    expect(captured.length).toBe(before + 1);
    expect(captured.at(-1)?.to).toBe(email);
  });
});

describe("the sweep (DW16, K3)", () => {
  test("a batch still queued an hour after creation: pending rows failed not_processed, addresses cleared, the batch done, audited once; a second sweep does nothing", async () => {
    const org = await newOrg();
    const stale = await seedBatch(
      org,
      [address(1, "stale"), address(2, "stale")],
      0,
      "61 minutes",
    );
    const org2 = await newOrg();
    const fresh = await seedBatch(org2, [address(1, "fresh")], 0, "10 minutes");
    const sweep = {
      name: INVITATIONS_SWEEP,
      data: undefined,
      attemptsMade: 0,
      opts: {},
    };
    await processInvitationJob(sweep, deps);
    expect(
      (await rowsOf(stale)).map((r) => [
        r.status,
        r.error_code,
        r.email_normalised,
      ]),
    ).toEqual([
      ["failed", "not_processed", null],
      ["failed", "not_processed", null],
    ]);
    expect(await batchOf(stale)).toEqual({
      status: "done",
      created_count: 0,
      failed_count: 2,
    });
    expect((await rowsOf(fresh))[0]?.status).toBe("pending");
    await processInvitationJob(sweep, deps);
    expect(
      await asAdmin(
        "SELECT action FROM bricx.audit_events WHERE entity_id = $1 ORDER BY seq",
        [stale],
      ),
    ).toEqual([{ action: "org.invitation_batch.complete" }]);
    // The bulk job arriving late does nothing more.
    await processInvitationJob(bulkJob(org, stale), deps);
    expect(await invitationsOf(org)).toEqual([]);
  });
});

describe("no address in logs, the outbox or audit (DW15, S22)", () => {
  test("nothing carries an address", async () => {
    expect(JSON.stringify(log.lines)).not.toContain(NEEDLE);
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
