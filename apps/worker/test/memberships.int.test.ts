// P6-06b (ADR 0084; Done-when DW10, DW12; owner condition C8), live: the
// memberships consumer and its sweep against compose.yml's Postgres and
// Valkey, with the production relay and the real BullMQ Worker; only the
// logger records. Memberships are seeded as the test superuser (created
// in the past: expires_at > created_at is a CHECK); outbox rows are
// written as bricx_app, as the API does in the assigning transaction.
// - A temporary org membership with 3 s left: the relay publishes its
//   memberships.expire row at once as a delayed job; at expires_at the
//   consumer sets expired_at and records ONE audit event (org.member.expire,
//   actor system, correlation = the outbox id); replayed, a no-op.
// - A renewed membership's old job completes as renewed and records
//   nothing; a project membership expires through the same consumer
//   (project.member.expire), under the project_memberships policies.
// - An early job (expires_at ahead, no not_before) is refused and
//   retried, then records the expiry once it is due.
// - The sweep: N registrations are one scheduler every 5 minutes; its
//   body records a due membership no job reached (correlation
//   sweep.<id>) and writes the one memberships.expiring notice of a
//   membership ending within 7 days; a second run writes neither again.
// - The suspension reason never reaches an audit event or a line.
// - Archived scope (plan edge cases): a due membership of an archived
//   organisation and a due project membership of an archived project are
//   still recorded as expired by the sweep, one event each.
import { seedOrganization, seedProject } from "@bricx/db-bootstrap/fixtures";
import { waitFor } from "@bricx/db-bootstrap/stack";
import {
  type Database,
  type RelayDatabase,
  openDatabase,
  openRelayDatabase,
} from "@bricx/db/database";
import { insertOutbox } from "@bricx/db/outbox";
import { createUuidV7Generator } from "@bricx/ids/uuid-v7";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  MEMBERSHIPS_QUEUE,
  MEMBERSHIPS_SWEEP,
  MEMBERSHIPS_SWEEP_EVERY_MS,
  MEMBERSHIPS_SWEEP_SCHEDULER_ID,
  type MembershipConsumer,
  type MembershipDeps,
  type MembershipJob,
  createMembershipConsumer,
  processMembershipJob,
  scheduleMembershipSweep,
} from "../src/memberships/consumer.js";
import { dueMembershipReader } from "../src/memberships/due.js";
import { createMembershipExpirer } from "../src/memberships/expiry.js";
import { type Publisher, createBullPublisher } from "../src/relay/publisher.js";
import {
  type OutboxJobData,
  type Relay,
  type RelayLogger,
  createRelay,
} from "../src/relay/relay.js";
import { outboxStore } from "../src/relay/store.js";
import { openConsumerValkey, openValkey } from "../src/relay/valkey.js";
import { type Stack, startStack } from "./stack.js";

const HOOK_MS = 600_000;
const ORG_A = "0199e1b4-0000-7000-8000-00000000000a";
const ADMIN = "0199e1b4-0000-7000-8000-000000000001";
const PROJECT = "0199e1b4-0000-7000-8000-000000000011";
/** Stored on a suspended temporary membership; never re-read by the worker. */
const REASON = "needle-6b12: suspended for site safety";
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
let valkey: Redis;
let consumerValkey: Redis;
let publisher: Publisher;
let relay: Relay;
let inspect: Queue<OutboxJobData>;
let role: string;
const relayLog = recorder();

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

beforeAll(async () => {
  stack = await startStack();
  app = openDatabase({ reveal: () => stack.url("bricx_app") });
  relayDb = openRelayDatabase({ reveal: () => stack.url("bricx_relay") });
  valkey = openValkey({ reveal: () => stack.valkeyUrl() });
  await valkey.connect();
  consumerValkey = openConsumerValkey({ reveal: () => stack.valkeyUrl() });
  publisher = createBullPublisher(valkey);
  relay = createRelay({
    database: relayDb,
    store: outboxStore,
    publisher,
    logger: relayLog,
  });
  relay.start();
  inspect = new Queue(MEMBERSHIPS_QUEUE, { connection: valkey });
  await seedOrganization(asAdmin, ORG_A);
  await seedProject(asAdmin, ORG_A, PROJECT);
  await asAdmin(
    `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
     VALUES ($1, 'memberships-admin', now(), now())`,
    [ADMIN],
  );
  role = ids.next();
  await asAdmin(
    `INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at)
     VALUES ($1, $2, 'member', 'member', NULL, now(), now())`,
    [role, ORG_A],
  );
}, HOOK_MS);

afterAll(async () => {
  await relay.stop();
  await publisher.close();
  await inspect.close();
  valkey.disconnect();
  consumerValkey.disconnect();
  await relayDb.close();
  await app.close();
  await stack.stop();
}, HOOK_MS);

function deps(): MembershipDeps & { logger: ReturnType<typeof recorder> } {
  return {
    expirer: createMembershipExpirer({
      database: app,
      clock: { now: () => Date.now() },
      ids,
    }),
    due: dueMembershipReader(relayDb),
    logger: recorder(),
  };
}
function consumer(): MembershipConsumer & {
  log: ReturnType<typeof recorder>;
} {
  const d = deps();
  const c = createMembershipConsumer({ connection: consumerValkey, deps: d });
  return Object.assign(c, { log: d.logger });
}

/** The end as the API writes it (toISOString(), whole milliseconds). */
const iso = (ms: number) => new Date(ms).toISOString();

/** A new user with a temporary org membership (and optionally a project one) ending at `endsAt`. */
async function seedTemporary(options: {
  readonly endsAt: number;
  readonly project?: boolean;
  readonly suspended?: boolean;
}): Promise<{ user: string; org: string; project: string | undefined }> {
  const user = ids.next();
  await asAdmin(
    `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
     VALUES ($1, $2, now(), now())`,
    [user, `memberships-${user}`],
  );
  const org = ids.next();
  const end = iso(options.endsAt);
  const suspension = options.suspended === true;
  await asAdmin(
    `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at, expires_at,
       suspended_at, suspended_by, suspend_reason)
     VALUES ($1, $2, $3, $4, now() - interval '1 day', $5::timestamptz,
       CASE WHEN $6::boolean THEN now() END, CASE WHEN $6::boolean THEN $7::uuid END,
       CASE WHEN $6::boolean THEN $8 END)`,
    [org, ORG_A, user, role, end, suspension, ADMIN, REASON],
  );
  let project: string | undefined;
  if (options.project === true) {
    project = ids.next();
    await asAdmin(
      `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 day', $6::timestamptz)`,
      [project, ORG_A, PROJECT, user, role, end],
    );
  }
  return { user, org, project };
}

/** Commits one memberships.expire row as bricx_app, as the API does at assign. */
async function expireJob(
  kind: "org" | "project",
  membershipId: string,
  userId: string,
  expiresAt: string,
  notBefore?: string,
): Promise<string> {
  const outboxId = ids.next();
  await app.withTx(
    { orgId: ORG_A, userId: ADMIN, projectIds: [], allProjects: true },
    (tx) =>
      insertOutbox(
        tx,
        "memberships.expire",
        { kind, membershipId, userId, expiresAt },
        outboxId,
        notBefore === undefined ? {} : { notBefore },
      ),
  );
  return outboxId;
}

const stateOf = async (table: string, id: string) =>
  (
    await asAdmin<{ expired: boolean; notified: boolean }>(
      `SELECT (expired_at IS NOT NULL) AS expired, (expiry_notified_at IS NOT NULL) AS notified
       FROM bricx.${table} WHERE id = $1`,
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
const auditOf = (id: string) =>
  asAdmin<AuditRow>(
    `SELECT action, actor_type, actor_id::text, correlation_id, entity_type, "before", "after"
     FROM bricx.audit_events WHERE org_id = $1 AND entity_id = $2 ORDER BY seq`,
    [ORG_A, id],
  );
const noticesOf = (id: string) =>
  asAdmin<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM bricx.outbox WHERE topic = 'memberships.expiring' AND payload->>'membershipId' = $1`,
    [id],
  );

const line = (
  log: ReturnType<typeof recorder>,
  msg: string,
  match: (fields: Record<string, unknown>) => boolean,
) => log.lines.find((l) => l.msg === msg && match(l.fields));
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
const awaitJob = (outboxId: string) =>
  waitFor(
    "the job",
    async () => (await inspect.getJob(outboxId)) ?? undefined,
    30_000,
    50,
  );
const settledState = (id: string, want: string) =>
  waitFor(
    `job ${want}`,
    async () => {
      const state = await (await inspect.getJob(id))?.getState();
      return state === want ? state : undefined;
    },
    10_000,
    20,
  );

describe("the consumer, live (DW10)", () => {
  test("a 3 s temporary org membership: published at once as a delayed job; at expires_at the consumer sets expired_at and records one org.member.expire event as system with the outbox id as correlation; replayed, a no-op", async () => {
    const end = Date.now() + 3_000;
    const m = await seedTemporary({ endsAt: end });
    const c = consumer();
    try {
      const outboxId = await expireJob(
        "org",
        m.org,
        m.user,
        iso(end),
        iso(end),
      );
      const job = await awaitJob(outboxId);
      expect(job.delay).toBeGreaterThan(0);
      expect(job.delay).toBeLessThanOrEqual(3_000);
      expect((await stateOf("memberships", m.org))?.expired).toBe(false);
      const applied = await awaitLine(
        c.log,
        "membership.expired",
        byOutbox(outboxId),
      );
      expect(Date.now()).toBeGreaterThanOrEqual(end);
      expect(applied.fields).toEqual({
        outboxId,
        membershipId: m.org,
        kind: "org",
        userId: m.user,
        orgId: ORG_A,
        source: "job",
        attempt: 1,
      });
      expect((await stateOf("memberships", m.org))?.expired).toBe(true);
      expect(await settledState(outboxId, "completed")).toBe("completed");
      const events = await auditOf(m.org);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: "org.member.expire",
        actor_type: "system",
        actor_id: null,
        correlation_id: outboxId,
        entity_type: "org.member",
        before: {
          id: m.org,
          userId: m.user,
          expiresAt: iso(end),
          expiredAt: null,
        },
      });
      expect(events[0]?.after?.expiredAt).not.toBeNull();

      // Replayed (the same payload, a new outbox row): a no-op.
      const replay = await expireJob("org", m.org, m.user, iso(end));
      const noop = await awaitLine(
        c.log,
        "membership.expire_noop",
        byOutbox(replay),
      );
      expect(noop.fields).toMatchObject({ state: "expired" });
      expect(await auditOf(m.org)).toHaveLength(1);
    } finally {
      await c.close();
    }
  });

  test("a renewed membership's old job completes as renewed and records nothing; a project membership expires as project.member.expire under its own policies", async () => {
    const past = Date.now() - 1_000;
    const renewed = await seedTemporary({ endsAt: Date.now() + 86_400_000 });
    const m = await seedTemporary({ endsAt: past, project: true });
    const c = consumer();
    try {
      const stale = await expireJob(
        "org",
        renewed.org,
        renewed.user,
        iso(past),
      );
      expect(
        (await awaitLine(c.log, "membership.expire_noop", byOutbox(stale)))
          .fields,
      ).toMatchObject({ state: "renewed", membershipId: renewed.org });
      expect(await auditOf(renewed.org)).toEqual([]);
      expect((await stateOf("memberships", renewed.org))?.expired).toBe(false);

      const projectJob = await expireJob(
        "project",
        m.project ?? "",
        m.user,
        iso(past),
      );
      await awaitLine(c.log, "membership.expired", byOutbox(projectJob));
      expect(
        (await stateOf("project_memberships", m.project ?? ""))?.expired,
      ).toBe(true);
      const events = await auditOf(m.project ?? "");
      expect(events.map((e) => [e.action, e.entity_type])).toEqual([
        ["project.member.expire", "project.member"],
      ]);
      expect(events[0]?.before).toMatchObject({
        kind: "project",
        projectId: PROJECT,
      });
    } finally {
      await c.close();
    }
  });

  test("an early job (expires_at 2 s ahead, published at once) is refused and retried, then records the expiry once it is due: one event", async () => {
    const end = Date.now() + 2_000;
    const m = await seedTemporary({ endsAt: end });
    const c = consumer();
    try {
      const outboxId = await expireJob("org", m.org, m.user, iso(end));
      const applied = await awaitLine(
        c.log,
        "membership.expired",
        byOutbox(outboxId),
        60_000,
      );
      expect(applied.fields.attempt).toBeGreaterThan(1);
      expect(
        line(
          c.log,
          "membership.retry",
          (f) => f.outboxId === outboxId && f.notDue === true,
        ),
      ).toBeDefined();
      expect(await auditOf(m.org)).toHaveLength(1);
    } finally {
      await c.close();
    }
  }, 90_000);
});

describe("the sweep, live (DW10, DW12, C8)", () => {
  test("N registrations are one scheduler on queue memberships, every 5 minutes; its body records a due membership no job reached (sweep.<id>) and writes the one notice of a membership ending within 7 days; a second run writes neither again; the suspension reason never reaches an event or a line", async () => {
    await Promise.all([
      scheduleMembershipSweep(publisher),
      scheduleMembershipSweep(publisher),
      scheduleMembershipSweep(publisher),
    ]);
    const schedulers = await inspect.getJobSchedulers();
    expect(schedulers).toHaveLength(1);
    expect(schedulers[0]).toMatchObject({
      key: MEMBERSHIPS_SWEEP_SCHEDULER_ID,
      name: MEMBERSHIPS_SWEEP,
      every: MEMBERSHIPS_SWEEP_EVERY_MS,
    });

    const due = await seedTemporary({
      endsAt: Date.now() - 1_000,
      suspended: true,
    });
    const soon = await seedTemporary({
      endsAt: Date.now() + 3 * 86_400_000,
      project: true,
    });
    const later = await seedTemporary({ endsAt: Date.now() + 8 * 86_400_000 });
    const sweep: MembershipJob = {
      name: MEMBERSHIPS_SWEEP,
      data: {},
      attemptsMade: 0,
      opts: {},
    };
    const d = deps();
    await processMembershipJob(sweep, d);
    const summary = d.logger.lines.find((l) => l.msg === "membership.sweep");
    expect(summary?.fields).toMatchObject({ failed: 0 });
    expect(
      line(d.logger, "membership.expired", (f) => f.membershipId === due.org)
        ?.fields,
    ).toEqual({
      membershipId: due.org,
      kind: "org",
      userId: due.user,
      orgId: ORG_A,
      source: "sweep",
    });
    const events = await auditOf(due.org);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "org.member.expire",
      actor_type: "system",
      correlation_id: `sweep.${due.org}`,
    });
    // The notices: the org and the project row of `soon`, not `later`, not the expired one.
    for (const id of [soon.org, soon.project ?? ""]) {
      expect(await noticesOf(id)).toHaveLength(1);
    }
    expect((await stateOf("memberships", soon.org))?.notified).toBe(true);
    expect(await noticesOf(later.org)).toEqual([]);
    expect(await noticesOf(due.org)).toEqual([]);
    expect((await noticesOf(soon.project ?? ""))[0]?.payload).toEqual({
      kind: "project",
      membershipId: soon.project,
      userId: soon.user,
    });

    const again = deps();
    await processMembershipJob(sweep, again);
    expect(
      line(
        again.logger,
        "membership.expired",
        (f) => f.membershipId === due.org,
      ),
    ).toBeUndefined();
    expect(await auditOf(due.org)).toHaveLength(1);
    expect(await noticesOf(soon.org)).toHaveLength(1);

    const everything = JSON.stringify([
      d.logger.lines,
      again.logger.lines,
      relayLog.lines,
      events,
    ]);
    expect(everything).not.toContain("needle-6b12");
    expect(
      await inspect.removeJobScheduler(MEMBERSHIPS_SWEEP_SCHEDULER_ID),
    ).toBe(true);
    expect(await inspect.getJobSchedulers()).toEqual([]);
  });
});

describe("archived scope: the expiry is still recorded (plan edge cases)", () => {
  test("a due org membership of an archived organisation and a due project membership of an archived project: the sweep records both, one event each; a second run records nothing", async () => {
    const archivedOrg = ids.next();
    await seedOrganization(asAdmin, archivedOrg);
    const archivedRole = ids.next();
    await asAdmin(
      `INSERT INTO bricx.roles (id, org_id, key, name, system_key, created_at, updated_at)
       VALUES ($1, $2, 'member', 'member', NULL, now(), now())`,
      [archivedRole, archivedOrg],
    );
    const user = ids.next();
    await asAdmin(
      `INSERT INTO bricx.users (id, keycloak_sub, created_at, last_seen_at)
       VALUES ($1, $2, now(), now())`,
      [user, `memberships-${user}`],
    );
    const orgMembership = ids.next();
    await asAdmin(
      `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, now() - interval '1 day', now() - interval '1 second')`,
      [orgMembership, archivedOrg, user, archivedRole],
    );
    await asAdmin(
      "UPDATE bricx.organizations SET archived_at = now() WHERE id = $1",
      [archivedOrg],
    );

    const archivedProject = ids.next();
    await seedProject(asAdmin, ORG_A, archivedProject);
    const projectUser = await seedTemporary({
      endsAt: Date.now() + 86_400_000 * 60,
    });
    const projectMembership = ids.next();
    await asAdmin(
      `INSERT INTO bricx.project_memberships (id, org_id, project_id, user_id, role_id, created_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() - interval '1 day', now() - interval '1 second')`,
      [projectMembership, ORG_A, archivedProject, projectUser.user, role],
    );
    await asAdmin(
      "UPDATE bricx.projects SET status = 'archived', archived_at = now() WHERE id = $1",
      [archivedProject],
    );

    const sweep: MembershipJob = {
      name: MEMBERSHIPS_SWEEP,
      data: {},
      attemptsMade: 0,
      opts: {},
    };
    const d = deps();
    await processMembershipJob(sweep, d);
    expect(
      d.logger.lines.find((l) => l.msg === "membership.sweep")?.fields,
    ).toMatchObject({ failed: 0 });
    expect((await stateOf("memberships", orgMembership))?.expired).toBe(true);
    expect(
      (await stateOf("project_memberships", projectMembership))?.expired,
    ).toBe(true);
    const orgEvents = await asAdmin<{ action: string; correlation_id: string }>(
      `SELECT action, correlation_id FROM bricx.audit_events WHERE org_id = $1 AND entity_id = $2`,
      [archivedOrg, orgMembership],
    );
    expect(orgEvents).toEqual([
      { action: "org.member.expire", correlation_id: `sweep.${orgMembership}` },
    ]);
    expect(
      (await auditOf(projectMembership)).map((e) => [
        e.action,
        e.correlation_id,
      ]),
    ).toEqual([["project.member.expire", `sweep.${projectMembership}`]]);

    const again = deps();
    await processMembershipJob(sweep, again);
    expect(
      line(again.logger, "membership.expired", (f) =>
        [orgMembership, projectMembership].some((id) => id === f.membershipId),
      ),
    ).toBeUndefined();
    expect(await auditOf(projectMembership)).toHaveLength(1);
  });
});
