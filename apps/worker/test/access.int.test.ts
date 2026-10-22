// P5-06 (D-G, owner conditions 2, 3, 4 and 6, ADR 0067; Done-when DW4
// and DW7), live: the access_grants.expire consumer and the sweep against
// compose.yml's Postgres and Valkey (@bricx/db-bootstrap/stack) and the
// real P5-01 realm (@bricx/keycloak-realm/testing). The relay is the real
// one (production defaults), the consumers the real BullMQ Workers; only
// the logger records. Grants are seeded as the test superuser, as the
// API's suites do; the outbox rows are written as bricx_app, as the API
// does in the granting transaction.
// - A grant with 3 s left (the table's window is 60 s..30 d, so every
//   seed starts in the past): the relay publishes its row at once as a delayed job; at
//   expires_at the consumer sets expired_at, records ONE audit event
//   (actor_type system, actor_id NULL, correlation = the outbox id, no
//   reason in it) and ONE users.mfa_check row, in one transaction; the
//   job replayed is a no-op (no second row of either).
// - An early job (condition 3) is refused and retried on the topic's
//   backoff, then expires the grant once it is due: still one event.
// - A revoked grant's job and a job for no grant complete without an
//   event.
// - The sweep (condition 6): N registrations are one scheduler every 5
//   minutes; its body expires a due grant no job reached, correlation
//   sweep.<grant id>.
// - DW7 (condition 2): a finance.* elevation whose starts_at is still in
//   the future already maps bricx-mfa through the users.mfa_check
//   consumer; the expiry's own users.mfa_check row clears it.
// - Condition 6: the reason text and the realm subject never reach the
//   lines of any consumer or the relay.
import { loadWorkerConfig } from "@bricx/config/worker";
import { waitFor } from "@bricx/db-bootstrap/stack";
import {
  type Database,
  type RelayDatabase,
  openDatabase,
  openRelayDatabase,
} from "@bricx/db/database";
import { OUTBOX_TOPICS, insertOutbox } from "@bricx/db/outbox";
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";
import {
  type Keycloak,
  createRealmUser,
  startKeycloak,
} from "@bricx/keycloak-realm/testing";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  ACCESS_QUEUE,
  ACCESS_SWEEP,
  type AccessConsumer,
  type AccessDeps,
  type AccessJob,
  SWEEP_EVERY_MS,
  SWEEP_SCHEDULER_ID,
  createAccessConsumer,
  processAccessJob,
  scheduleSweep,
} from "../src/access/consumer.js";
import { dueReader } from "../src/access/due.js";
import { createAccessExpirer } from "../src/access/expiry.js";
import {
  type MfaConsumer,
  USERS_QUEUE,
  createMfaConsumer,
} from "../src/mfa/consumer.js";
import { mfaTruth } from "../src/mfa/truth.js";
import { type Publisher, createBullPublisher } from "../src/relay/publisher.js";
import {
  type OutboxJobData,
  type Relay,
  RELAY_DEFAULTS,
  type RelayLogger,
  createRelay,
} from "../src/relay/relay.js";
import { outboxStore } from "../src/relay/store.js";
import { openConsumerValkey, openValkey } from "../src/relay/valkey.js";
import {
  type KeycloakAdmin,
  MFA_ROLE,
  createKeycloakSessionEnder,
} from "../src/revocation/keycloak.js";
import { workerEnv } from "./env.js";
import { type Stack, startStack } from "./stack.js";

const HOOK_MS = 600_000;
const ORG_A = "0199e1a0-0000-7000-8000-00000000000a";
/** The granter (a users row; never elevated here). */
const GRANTER = "0199e1a0-0000-7000-8000-000000000002";
/** The elevated user: a realm user, so DW7 can read its role mappings. */
const USER = "0199e1a0-0000-7000-8000-000000000003";
/** A project id for project-scoped keys (no row needed: the column has no FK). */
const PROJECT = "0199e1a0-0000-7000-8000-000000000011";
const PASSWORD = "test-only-access-login-pw-1";
const USERNAME = "access-user";
/** The reason text: audited at grant by the API, never re-read by the worker. */
const REASON = "needle-7f3a: month-end close cover";
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
let keycloak: Keycloak;
let issuer: string;
let sub: string;
let app: Database;
let relayDb: RelayDatabase;
let valkey: Redis;
let consumerValkey: Redis;
let publisher: Publisher;
let relay: Relay;
let inspect: Queue<OutboxJobData>;
let users: Queue<OutboxJobData>;
let admin: KeycloakAdmin;
const relayLog = recorder();
const closers: (() => Promise<unknown>)[] = [];

async function asAdmin<T extends Record<string, unknown>>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await stack.postgres.admin();
  try {
    const result = await client.query<T>(text, params);
    return result.rows;
  } finally {
    await client.end();
  }
}

beforeAll(async () => {
  [stack, keycloak] = await Promise.all([startStack(), startKeycloak()]);
  issuer = `${keycloak.base}/realms/bricx`;
  app = openDatabase({ reveal: () => stack.url("bricx_app") });
  relayDb = openRelayDatabase({ reveal: () => stack.url("bricx_relay") });
  valkey = openValkey({ reveal: () => stack.valkeyUrl() });
  await valkey.connect();
  consumerValkey = openConsumerValkey({ reveal: () => stack.valkeyUrl() });
  publisher = createBullPublisher(valkey);
  closers.push(() => publisher.close());
  // The production relay: every option its default.
  relay = createRelay({
    database: relayDb,
    store: outboxStore,
    publisher,
    logger: relayLog,
  });
  relay.start();
  inspect = new Queue(ACCESS_QUEUE, { connection: valkey });
  users = new Queue(USERS_QUEUE, { connection: valkey });
  admin = createKeycloakSessionEnder(config().keycloak);
  sub = await createRealmUser(keycloak, {
    username: USERNAME,
    password: PASSWORD,
    orgId: ORG_A,
  });
  for (const [id, keycloakSub] of [
    [GRANTER, "granter-subject-sentinel-3d7c"],
    [USER, sub],
  ]) {
    await asAdmin(
      `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
       VALUES ($1, $2, now(), now())`,
      [id, keycloakSub],
    );
  }
  // An empty org role and open memberships, as the API requires of a grantee.
  const role = ids.next();
  await asAdmin(
    `INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at)
     VALUES ($1, $2, 'member', 'member', NULL, now(), now())`,
    [role, ORG_A],
  );
  for (const user of [GRANTER, USER]) {
    await asAdmin(
      `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at)
       VALUES ($1, $2, $3, $4, now())`,
      [ids.next(), ORG_A, user, role],
    );
  }
}, HOOK_MS);

afterAll(async () => {
  await relay.stop();
  for (const close of closers.reverse()) await close();
  await inspect.close();
  await users.close();
  valkey.disconnect();
  consumerValkey.disconnect();
  await relayDb.close();
  await app.close();
  await Promise.all([stack.stop(), keycloak.container.stop()]);
}, HOOK_MS);

/** The worker's config for this stack (the realm's dev secret, .env.example). */
function config() {
  return loadWorkerConfig(
    workerEnv({
      DATABASE_URL: stack.url("bricx_app"),
      RELAY_DATABASE_URL: stack.url("bricx_relay"),
      VALKEY_URL: stack.valkeyUrl(),
      KEYCLOAK_ISSUER: issuer,
    }),
  );
}

/** The production dependencies over this stack, with the recording logger. */
function deps(): AccessDeps & { logger: ReturnType<typeof recorder> } {
  return {
    expirer: createAccessExpirer({
      database: app,
      clock: { now: () => Date.now() },
      ids,
    }),
    due: dueReader(relayDb),
    logger: recorder(),
  };
}

/** A consumer on the real queue; closed by the caller. */
function consumer(): AccessConsumer & { log: ReturnType<typeof recorder> } {
  const d = deps();
  const c = createAccessConsumer({ connection: consumerValkey, deps: d });
  return Object.assign(c, { log: d.logger });
}

/** The real users.mfa_check consumer (P5-05), for DW7; closed by the caller. */
function mfaConsumer(): MfaConsumer & { log: ReturnType<typeof recorder> } {
  const log = recorder();
  const c = createMfaConsumer({
    connection: consumerValkey,
    deps: { truth: mfaTruth(relayDb), keycloak: admin, logger: log },
  });
  return Object.assign(c, { log });
}

const iso = (ms: number) => new Date(ms).toISOString();

interface Seed {
  readonly permission?: string;
  readonly scopeId?: string | null;
  readonly startsAt: number;
  readonly expiresAt: number;
  readonly revoked?: boolean;
}

/** A grant row for USER, seeded as the superuser (the API's own INSERT shape). */
async function seedGrant(seed: Seed): Promise<string> {
  const id = ids.next();
  await asAdmin(
    `INSERT INTO bricx.access_grants
       (id, org_id, user_id, permission, scope_id, reason, granted_by,
        starts_at, expires_at, revoked_at, revoked_by, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9::timestamptz,
             CASE WHEN $10::boolean THEN now() END,
             CASE WHEN $10::boolean THEN $7::uuid END,
             least($8::timestamptz, now()))`,
    [
      id,
      ORG_A,
      USER,
      seed.permission ?? "org.role.read.org",
      seed.scopeId ?? null,
      REASON,
      GRANTER,
      iso(seed.startsAt),
      iso(seed.expiresAt),
      seed.revoked ?? false,
    ],
  );
  return id;
}

/** Commits one access_grants.expire row as bricx_app, as the API does at grant. */
async function expireJob(grantId: string, notBefore?: string): Promise<string> {
  const outboxId = ids.next();
  await app.withTx({ orgId: ORG_A, userId: GRANTER, projectIds: [] }, (tx) =>
    insertOutbox(
      tx,
      "access_grants.expire",
      { grantId, userId: USER },
      outboxId,
      notBefore === undefined ? {} : { notBefore },
    ),
  );
  return outboxId;
}

/** Revokes a grant as the superuser (the shape of the API's DELETE). */
async function revokeGrant(id: string): Promise<void> {
  await asAdmin(
    `UPDATE bricx.access_grants SET revoked_at = now(), revoked_by = $2
     WHERE id = $1 AND revoked_at IS NULL`,
    [id, GRANTER],
  );
}

/** Commits one users.mfa_check row as bricx_app, as the API does at grant. */
async function mfaCheck(): Promise<string> {
  const outboxId = ids.next();
  await app.withTx({ orgId: ORG_A, userId: GRANTER, projectIds: [] }, (tx) =>
    insertOutbox(tx, "users.mfa_check", { userId: USER }, outboxId),
  );
  return outboxId;
}

type GrantState = {
  expired_at: string | null;
  revoked_at: string | null;
};
const grantOf = async (id: string): Promise<GrantState | undefined> =>
  (
    await asAdmin<GrantState>(
      `SELECT expired_at::text, revoked_at::text FROM bricx.access_grants WHERE id = $1`,
      [id],
    )
  )[0];

type AuditRow = {
  action: string;
  actor_type: string;
  actor_id: string | null;
  correlation_id: string;
  entity_type: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
};
const auditOf = (grantId: string) =>
  asAdmin<AuditRow>(
    `SELECT action, actor_type, actor_id::text, correlation_id, entity_type, "before", "after"
     FROM bricx.audit_events WHERE org_id = $1 AND entity_id = $2 ORDER BY seq`,
    [ORG_A, grantId],
  );

/** The ids of USER's users.mfa_check outbox rows, oldest first. */
const mfaRows = async (): Promise<string[]> =>
  (
    await asAdmin<{ id: string }>(
      `SELECT id::text FROM bricx.outbox
       WHERE org_id = $1 AND topic = 'users.mfa_check' AND payload = $2::jsonb
       ORDER BY id`,
      [ORG_A, JSON.stringify({ userId: USER })],
    )
  ).map((r) => r.id);

/** The names of the realm roles mapped to USER, read as the realm admin. */
async function realmRoles(): Promise<string[]> {
  const mapped = await keycloak.admin(
    "GET",
    `/users/${sub}/role-mappings/realm`,
  );
  if (!Array.isArray(mapped)) throw new Error("role mappings: not a list");
  const list: unknown[] = mapped;
  const names: string[] = [];
  for (const role of list) {
    if (
      typeof role === "object" &&
      role !== null &&
      "name" in role &&
      typeof role.name === "string"
    ) {
      names.push(role.name);
    }
  }
  return names.sort();
}

const line = (
  log: ReturnType<typeof recorder>,
  msg: string,
  match: (fields: Record<string, unknown>) => boolean,
) => log.lines.find((l) => l.msg === msg && match(l.fields));

/** Waits for the line; a timeout reports what was logged instead (ids and counts only). */
async function awaitLine(
  log: ReturnType<typeof recorder>,
  msg: string,
  match: (fields: Record<string, unknown>) => boolean,
  timeoutMs = 30_000,
): Promise<Logged> {
  try {
    return await waitFor(
      msg,
      () => Promise.resolve(line(log, msg, match)),
      timeoutMs,
      20,
    );
  } catch (error) {
    throw new Error(`${String(error)}; logged: ${JSON.stringify(log.lines)}`, {
      cause: error,
    });
  }
}
const byOutbox = (outboxId: string) => (f: Record<string, unknown>) =>
  f.outboxId === outboxId;

/** The job the relay published for the row, once it is in Valkey. */
const awaitJob = (outboxId: string) =>
  waitFor(
    "the job",
    async () => (await inspect.getJob(outboxId)) ?? undefined,
    30_000,
    50,
  );

describe("the consumer, live (DW4)", () => {
  test("a 3 s grant: the row is published at once as a delayed job; at expires_at the consumer sets expired_at and records one audit event as system and one users.mfa_check row; replayed, a no-op with no second row", async () => {
    const now = Date.now();
    const grant = await seedGrant({
      startsAt: now - 57_000,
      expiresAt: now + 3_000,
    });
    const mfaBefore = await mfaRows();
    const c = consumer();
    try {
      const outboxId = await expireJob(grant, iso(now + 3_000));
      const job = await awaitJob(outboxId);
      // Published before expires_at, delayed until it (the database clock's
      // distance; a little under 3 s by the time the relay claimed it).
      expect(job.delay).toBeGreaterThan(0);
      expect(job.delay).toBeLessThanOrEqual(3_000);
      expect(job.opts.attempts).toBe(
        OUTBOX_TOPICS["access_grants.expire"]?.delivery?.attempts,
      );
      expect(["delayed", "waiting", "active", "completed"]).toContain(
        await job.getState(),
      );
      expect(await grantOf(grant)).toEqual({
        expired_at: null,
        revoked_at: null,
      });

      const applied = await awaitLine(
        c.log,
        "access.expired",
        byOutbox(outboxId),
      );
      const lateMs = Math.round(Date.now() - (now + 3_000));
      process.stdout.write(
        `[P5-06] expires_at to access.expired (production relay, idlePollMs ${String(RELAY_DEFAULTS.idlePollMs)}): ${String(lateMs)} ms\n`,
      );
      expect(lateMs).toBeGreaterThanOrEqual(0);
      expect(applied.fields).toEqual({
        outboxId,
        grantId: grant,
        userId: USER,
        orgId: ORG_A,
        source: "job",
        attempt: 1,
      });
      expect((await grantOf(grant))?.expired_at).not.toBeNull();
      expect(await (await inspect.getJob(outboxId))?.getState()).toBe(
        "completed",
      );

      const events = await auditOf(grant);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "org.access_grant.expire",
        actor_type: "system",
        actor_id: null,
        correlation_id: outboxId,
        entity_type: "org.access_grant",
      });
      expect(events[0]?.before).toMatchObject({
        id: grant,
        userId: USER,
        permission: "org.role.read.org",
        expiredAt: null,
      });
      expect(typeof events[0]?.after?.expiredAt).toBe("string");
      expect(JSON.stringify(events)).not.toContain(REASON);
      expect(Object.keys(events[0]?.after ?? {})).not.toContain("reason");

      const mfaAfter = await mfaRows();
      expect(mfaAfter.length).toBe(mfaBefore.length + 1);

      // The job replayed (the same payload, a new row): nothing changes.
      const replay = await expireJob(grant);
      const noop = await awaitLine(
        c.log,
        "access.expire_noop",
        byOutbox(replay),
      );
      expect(noop.fields).toEqual({
        outboxId: replay,
        grantId: grant,
        state: "expired",
      });
      expect(await (await inspect.getJob(replay))?.getState()).toBe(
        "completed",
      );
      expect(await auditOf(grant)).toHaveLength(1);
      expect(await mfaRows()).toEqual(mfaAfter);
      expect(JSON.stringify(c.log.lines)).not.toContain(REASON);
      expect(JSON.stringify(relayLog.lines)).not.toContain(REASON);
    } finally {
      await c.close();
    }
  });

  test("an early job (condition 3) is refused and retried on the topic's backoff, then expires the grant on a later attempt: still one audit event", async () => {
    const now = Date.now();
    const grant = await seedGrant({
      startsAt: now - 54_000,
      expiresAt: now + 6_000,
    });
    const c = consumer();
    try {
      // No not_before: the job runs at once, 6 s early.
      const outboxId = await expireJob(grant);
      const retry = await awaitLine(c.log, "access.retry", byOutbox(outboxId));
      expect(retry).toEqual({
        level: "debug",
        msg: "access.retry",
        fields: {
          outboxId,
          grantId: grant,
          attempt: 1,
          notDue: true,
          sqlstate: undefined,
        },
      });
      expect(c.log.lines.filter((l) => l.msg === "access.expire_noop")).toEqual(
        [],
      );
      expect(await grantOf(grant)).toEqual({
        expired_at: null,
        revoked_at: null,
      });
      const job = await inspect.getJob(outboxId);
      expect(job?.attemptsMade).toBeGreaterThanOrEqual(1);
      expect(job?.delay).toBe(1_000);

      const applied = await awaitLine(
        c.log,
        "access.expired",
        byOutbox(outboxId),
        60_000,
      );
      process.stdout.write(
        `[P5-06] early job expired on attempt ${String(applied.fields.attempt)}\n`,
      );
      expect(applied.fields.attempt).toBeGreaterThan(1);
      expect((await grantOf(grant))?.expired_at).not.toBeNull();
      expect(await auditOf(grant)).toHaveLength(1);
      expect(await (await inspect.getJob(outboxId))?.getState()).toBe(
        "completed",
      );
    } finally {
      await c.close();
    }
  });

  test("a revoked grant's job: access.expire_noop revoked; a job for no grant: access.grant_missing; both complete, no event", async () => {
    const now = Date.now();
    const grant = await seedGrant({
      startsAt: now - 65_000,
      expiresAt: now - 1_000,
      revoked: true,
    });
    const ghost = ids.next();
    const mfaBefore = await mfaRows();
    const c = consumer();
    try {
      const revoked = await expireJob(grant);
      const noop = await awaitLine(
        c.log,
        "access.expire_noop",
        byOutbox(revoked),
      );
      expect(noop.fields).toEqual({
        outboxId: revoked,
        grantId: grant,
        state: "revoked",
      });
      expect((await grantOf(grant))?.expired_at).toBeNull();
      expect(await auditOf(grant)).toEqual([]);

      const missing = await expireJob(ghost);
      const warned = await awaitLine(
        c.log,
        "access.grant_missing",
        byOutbox(missing),
      );
      expect(warned).toEqual({
        level: "warn",
        msg: "access.grant_missing",
        fields: { outboxId: missing, grantId: ghost },
      });
      for (const id of [revoked, missing]) {
        expect(await (await inspect.getJob(id))?.getState()).toBe("completed");
      }
      expect(await mfaRows()).toEqual(mfaBefore);
    } finally {
      await c.close();
    }
  });
});

describe("the sweep, live (condition 6)", () => {
  test("N registrations are one scheduler on queue access, every 5 minutes; its body expires a due grant no job reached, once, with correlation sweep.<grant id>", async () => {
    await Promise.all([
      scheduleSweep(publisher),
      scheduleSweep(publisher),
      scheduleSweep(publisher),
    ]);
    await scheduleSweep(publisher);
    const schedulers = await inspect.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: SWEEP_SCHEDULER_ID,
      name: ACCESS_SWEEP,
      every: SWEEP_EVERY_MS,
    });

    // The schedule's first job is removed with the scheduler below, so it
    // never races the delayed jobs of the next suite.
    const now = Date.now();
    const grant = await seedGrant({
      startsAt: now - 70_000,
      expiresAt: now - 1_000,
    });
    const mfaBefore = await mfaRows();
    const d = deps();
    // The sweep's body, as the scheduler's job runs it (the schedule
    // itself fires in 5 minutes; waiting for it is not a test).
    const sweep: AccessJob = {
      name: ACCESS_SWEEP,
      data: {},
      attemptsMade: 0,
      opts: {},
    };
    await processAccessJob(sweep, d);
    const summary = d.logger.lines.find((l) => l.msg === "access.sweep");
    expect(summary?.fields).toMatchObject({ failed: 0 });
    expect(summary?.fields.due).toBeGreaterThanOrEqual(1);
    expect(
      line(d.logger, "access.expired", (f) => f.grantId === grant)?.fields,
    ).toEqual({ grantId: grant, userId: USER, orgId: ORG_A, source: "sweep" });
    expect((await grantOf(grant))?.expired_at).not.toBeNull();
    const events = await auditOf(grant);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "org.access_grant.expire",
      actor_type: "system",
      actor_id: null,
      correlation_id: `sweep.${grant}`,
    });
    expect((await mfaRows()).length).toBe(mfaBefore.length + 1);

    // Run again: the grant is expired now, so the sweep skips it.
    const again = deps();
    await processAccessJob(sweep, again);
    expect(
      line(again.logger, "access.expired", (f) => f.grantId === grant),
    ).toBeUndefined();
    expect(await auditOf(grant)).toHaveLength(1);
    expect(JSON.stringify(d.logger.lines)).not.toContain(REASON);
    expect(await inspect.removeJobScheduler(SWEEP_SCHEDULER_ID)).toBe(true);
    expect(await inspect.getJobSchedulers()).toEqual([]);
  });
});

describe("MFA, live (DW7, condition 2)", () => {
  test("a finance.* elevation with starts_at still ahead maps bricx-mfa through the users.mfa_check consumer; once it is revoked and the last finance elevation expires, the expiry's own check clears it; the subject never reaches the lines", async () => {
    expect(await realmRoles()).not.toContain(MFA_ROLE);
    const now = Date.now();
    // Pending: starts in 30 s. Counted by app.mfa_state() all the same.
    const pending = await seedGrant({
      permission: "finance.payment.approve.project",
      scopeId: PROJECT,
      startsAt: now + 30_000,
      expiresAt: now + 120_000,
    });
    const m = mfaConsumer();
    const c = consumer();
    try {
      // As the API's granting transaction: the check (and the expire row,
      // which the test never waits for: the pending grant is revoked below).
      await expireJob(pending, iso(now + 120_000));
      const check = await mfaCheck();
      const mapped = await awaitLine(m.log, "mfa.applied", byOutbox(check));
      // The consumer reads the truth per job, so an older check in the queue
      // may have mapped the role first (changed false here): convergent.
      expect(mapped.fields).toMatchObject({ userId: USER, required: true });
      expect(await realmRoles()).toContain(MFA_ROLE);

      // The pending grant revoked (the API's DELETE), and an active finance
      // elevation with 3 s left: its expiry is the last finance key going.
      await revokeGrant(pending);
      const at = Date.now();
      const grant = await seedGrant({
        permission: "finance.payment.approve.project",
        scopeId: PROJECT,
        startsAt: at - 57_000,
        expiresAt: at + 3_000,
      });
      const expire = await expireJob(grant, iso(at + 3_000));
      const applied = await awaitLine(
        c.log,
        "access.expired",
        byOutbox(expire),
        60_000,
      );
      expect(applied.fields).toMatchObject({ grantId: grant, source: "job" });
      // The consumer's users.mfa_check row is the newest one for USER.
      const rows = await mfaRows();
      const cleared = rows[rows.length - 1] ?? "";
      expect(cleared).not.toBe(check);
      const unmapped = await awaitLine(
        m.log,
        "mfa.applied",
        byOutbox(cleared),
        60_000,
      );
      expect(unmapped.fields).toMatchObject({ userId: USER, required: false });
      expect(await realmRoles()).not.toContain(MFA_ROLE);
      expect(await (await users.getJob(cleared))?.getState()).toBe("completed");

      for (const log of [m.log, c.log, relayLog]) {
        const text = JSON.stringify(log.lines);
        expect(text).not.toContain(sub);
        expect(text).not.toContain(REASON);
      }
    } finally {
      await c.close();
      await m.close();
    }
  });
});
