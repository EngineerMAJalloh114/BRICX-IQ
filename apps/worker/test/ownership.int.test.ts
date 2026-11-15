// P6-06c (ADR 0085; owner condition C4; Done-when 8 and 10), live: the
// ownership.expire job and the sweep against compose.yml's Postgres,
// through the memberships queue's own routing (processMembershipJob).
// Transfers are seeded as the test superuser (created in the past:
// expires_at > created_at is a CHECK).
// - ownership.expire {transferId, toUserId, expiresAt}: at or after expires_at the
//   pending transfer becomes expired with ONE org.ownership_transfer.expire
//   event (actor system, correlation = the outbox id) and one
//   users.mfa_check for the recipient; replayed, a no-op; a settled one is
//   left alone. Before expires_at the job is refused (retried, S14), and
//   records nothing.
// - The sweep (memberships.sweep, every 5 minutes) expires a due transfer
//   no job reached, in every org, once.
// - After the expiry app.mfa_state() no longer asks the recipient for MFA
//   (v4: only a pending, unexpired transfer counts).
import { seedOrganization } from "@bricx/db-bootstrap/fixtures";
import {
  type Database,
  type RelayDatabase,
  openDatabase,
  openRelayDatabase,
} from "@bricx/db/database";
import { mfaState } from "@bricx/db/mfa";
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  MEMBERSHIPS_SWEEP,
  type MembershipDeps,
  processMembershipJob,
} from "../src/memberships/consumer.js";
import { dueMembershipReader } from "../src/memberships/due.js";
import { createMembershipExpirer } from "../src/memberships/expiry.js";
import {
  OWNERSHIP_EXPIRE,
  OwnershipNotDueError,
  createOwnershipExpirer,
  dueOwnershipReader,
} from "../src/ownership/expiry.js";
import type { RelayLogger } from "../src/relay/relay.js";
import { type Stack, startStack } from "./stack.js";

const HOOK_MS = 600_000;
const ids = createUuidV7Generator({ clock: { now: () => Date.now() } });

function recorder(): RelayLogger & { lines: { msg: string }[] } {
  const lines: { msg: string }[] = [];
  const at = () => (_fields: Record<string, unknown>, msg: string) => {
    lines.push({ msg });
  };
  return { lines, debug: at(), info: at(), warn: at(), error: at() };
}

let stack: Stack;
let app: Database;
let relayDb: RelayDatabase;
let deps: MembershipDeps;
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

interface Seeded {
  org: string;
  owner: string;
  recipient: string;
  transfer: string;
  expiresAt: string;
}

let userSeq = 0;
async function seedUser(): Promise<string> {
  userSeq += 1;
  const id = ids.next();
  await asAdmin(
    `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
     VALUES ($1, $2, now(), now())`,
    [id, `ownership-${String(userSeq)}`],
  );
  return id;
}

/** An org, its owner, a member and a pending transfer ending `expiresIn` from now (database clock). */
async function seed(expiresIn: string): Promise<Seeded> {
  const org = ids.next();
  await seedOrganization(asAdmin, org);
  const ownerRole = ids.next();
  const memberRole = ids.next();
  await asAdmin(
    `INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at)
     VALUES ($1, $3, 'owner', 'owner', 'owner', now() - interval '3 days', now() - interval '3 days'),
            ($2, $3, 'member', 'member', NULL, now() - interval '3 days', now() - interval '3 days')`,
    [ownerRole, memberRole, org],
  );
  const owner = await seedUser();
  const recipient = await seedUser();
  await asAdmin(
    `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at)
     VALUES ($1, $3, $4, $5, now() - interval '3 days'), ($2, $3, $6, $7, now() - interval '3 days')`,
    [ids.next(), ids.next(), org, owner, ownerRole, recipient, memberRole],
  );
  const transfer = ids.next();
  const [row] = await asAdmin<{ expires_at: string }>(
    `INSERT INTO bricx.ownership_transfers
       (id, org_id, initiated_by, to_user_id, previous_owner_role_id, expires_at, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, now() + $6::interval, now() - interval '2 days', now() - interval '2 days')
     RETURNING to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`,
    [transfer, org, owner, recipient, memberRole, expiresIn],
  );
  return { org, owner, recipient, transfer, expiresAt: row?.expires_at ?? "" };
}

const expireJob = (s: Seeded) => {
  outboxSeq += 1;
  return {
    name: OWNERSHIP_EXPIRE,
    data: {
      outboxId: String(8_000_000 + outboxSeq),
      orgId: s.org,
      topic: OWNERSHIP_EXPIRE,
      payload: {
        transferId: s.transfer,
        toUserId: s.recipient,
        expiresAt: s.expiresAt,
      },
    },
    attemptsMade: 0,
    opts: {},
  };
};
const sweepJob = {
  name: MEMBERSHIPS_SWEEP,
  data: undefined,
  attemptsMade: 0,
  opts: {},
};

const statusOf = async (transfer: string) =>
  (
    await asAdmin<{ status: string; settled: boolean }>(
      "SELECT status, settled_at IS NOT NULL AS settled FROM bricx.ownership_transfers WHERE id = $1",
      [transfer],
    )
  )[0];
const expireEvents = (transfer: string) =>
  asAdmin<{ actor_id: string | null; correlation_id: string | null }>(
    `SELECT actor_id::text, correlation_id FROM bricx.audit_events
     WHERE entity_id = $1 AND action = 'org.ownership_transfer.expire'`,
    [transfer],
  );
const mfaChecks = (user: string) =>
  asAdmin<{ n: number }>(
    `SELECT count(*)::int AS n FROM bricx.outbox WHERE topic = 'users.mfa_check' AND payload->>'userId' = $1`,
    [user],
  ).then((rows) => rows[0]?.n ?? 0);
const required = async (user: string) =>
  (await relayDb.withRelayTx((tx) => mfaState(tx, user)))?.required;

beforeAll(async () => {
  stack = await startStack();
  app = openDatabase({ reveal: () => stack.url("bricx_app") });
  relayDb = openRelayDatabase({ reveal: () => stack.url("bricx_relay") });
  const clock = { now: () => Date.now() };
  deps = {
    expirer: createMembershipExpirer({ database: app, clock, ids }),
    due: dueMembershipReader(relayDb),
    logger: recorder(),
    ownership: createOwnershipExpirer({ database: app, clock }),
    ownershipDue: dueOwnershipReader(relayDb),
  };
}, HOOK_MS);
afterAll(async () => {
  await app.close().catch(() => undefined);
  await relayDb.close().catch(() => undefined);
  await stack.stop();
}, HOOK_MS);

describe("ownership.expire (DW8, DW10)", () => {
  test("a due transfer expires once: one event as system with the outbox id, one mfa check for the recipient; MFA no longer required; a replay is a no-op", async () => {
    const s = await seed("-1 minute");
    expect(await required(s.recipient)).toBe(false);
    const checks = await mfaChecks(s.recipient);
    const job = expireJob(s);
    await processMembershipJob(job, deps);
    expect(await statusOf(s.transfer)).toEqual({
      status: "expired",
      settled: true,
    });
    expect(await expireEvents(s.transfer)).toEqual([
      { actor_id: null, correlation_id: job.data.outboxId },
    ]);
    expect(await mfaChecks(s.recipient)).toBe(checks + 1);
    await processMembershipJob(job, deps);
    expect(await expireEvents(s.transfer)).toHaveLength(1);
    expect(await mfaChecks(s.recipient)).toBe(checks + 1);
  });

  test("an early job is refused (retried) and records nothing (S14); MFA is still required while it is pending", async () => {
    const s = await seed("1 hour");
    expect(await required(s.recipient)).toBe(true);
    await expect(
      processMembershipJob(expireJob(s), deps),
    ).rejects.toBeInstanceOf(OwnershipNotDueError);
    expect(await statusOf(s.transfer)).toEqual({
      status: "pending",
      settled: false,
    });
    expect(await expireEvents(s.transfer)).toEqual([]);
  });

  test("a settled transfer is left alone", async () => {
    const s = await seed("-1 minute");
    await asAdmin(
      `UPDATE bricx.ownership_transfers SET status = 'cancelled', cancel_reason = 'manual',
         settled_by = $2, settled_at = now(), updated_at = now() WHERE id = $1`,
      [s.transfer, s.owner],
    );
    await processMembershipJob(expireJob(s), deps);
    expect((await statusOf(s.transfer))?.status).toBe("cancelled");
    expect(await expireEvents(s.transfer)).toEqual([]);
  });

  test("a malformed payload is unrecoverable", async () => {
    const s = await seed("-1 minute");
    const job = expireJob(s);
    await expect(
      processMembershipJob(
        {
          ...job,
          data: {
            ...job.data,
            payload: {
              transferId: "x",
              toUserId: s.recipient,
              expiresAt: s.expiresAt,
            },
          },
        },
        deps,
      ),
    ).rejects.toThrow("invalid ownership.expire job");
  });
});

describe("the sweep (DW8)", () => {
  test("due transfers no job reached, in two orgs, expire once each (correlation sweep.<id>); a second sweep writes nothing", async () => {
    const a = await seed("-5 minutes");
    const b = await seed("-3 minutes");
    const live = await seed("2 hours");
    await processMembershipJob(sweepJob, deps);
    for (const s of [a, b]) {
      expect((await statusOf(s.transfer))?.status).toBe("expired");
      expect(await expireEvents(s.transfer)).toEqual([
        { actor_id: null, correlation_id: `sweep.${s.transfer}` },
      ]);
    }
    expect((await statusOf(live.transfer))?.status).toBe("pending");
    await processMembershipJob(sweepJob, deps);
    for (const s of [a, b]) {
      expect(await expireEvents(s.transfer)).toHaveLength(1);
    }
  });
});
