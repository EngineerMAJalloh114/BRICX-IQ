// P5-06 (ADR 0067, owner condition 4): recordAuditEvent() over a fake
// transaction: the checks before any SQL, the tenant and isolation
// refusals, and what one event writes for each actor (the API's `user`,
// the worker's `system`: actor_id NULL). The chain on Postgres is proven
// by apps/api's audit.int.test.ts and the worker's expiry suite.
import { type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, test } from "vitest";
import {
  AUDIT_LOCK_NAMESPACE,
  AuditContextError,
  AuditEventError,
  AuditIsolationError,
  HASH_VERSION,
  auditHash,
  genesisHash,
  recordAuditEvent,
} from "../src/audit.js";
import type { Tx } from "../src/database.js";
import { ORACLE_GENESIS, oracleHash } from "./audit-oracle.js";

const ORG = "0199e1b0-0000-7000-8000-0000000000a1";
const USER = "0199e1b0-0000-7000-8000-000000000002";
const EVENT_ID = "0199e1b0-0000-7000-8000-0000000000e1";
const NOW_MS = Date.UTC(2026, 9, 22, 12, 0, 0, 250);
const dialect = new PgDialect();

const event = {
  action: "org.access_grant.expire",
  entityType: "org.access_grant",
  entityId: "0199e1b0-0000-7000-8000-000000000030",
  before: { expiredAt: null },
  after: { expiredAt: "2026-10-22T12:00:00.250Z" },
};
const origin = { correlationId: "job-1", ip: "10.0.0.7" };

/** A transaction that fails the test if any SQL reaches it. */
const noSql = {
  execute: () => {
    throw new Error("SQL must not run");
  },
  insert: () => {
    throw new Error("SQL must not run");
  },
} as unknown as Tx;

interface Head {
  readonly seq: string | null;
  readonly hash: Buffer | null;
}

/** A transaction answering the recorder's three reads and recording the insert. */
function fakeTx(world: {
  readonly org?: string | null;
  readonly actor?: string | null;
  readonly isolation?: string;
  readonly head?: Head;
}) {
  const statements: string[] = [];
  const params: unknown[][] = [];
  const inserted: Record<string, unknown>[] = [];
  let reads = 0;
  const tx = {
    execute: (query: SQL) => {
      const rendered = dialect.sqlToQuery(query);
      statements.push(rendered.sql);
      params.push(rendered.params);
      reads += 1;
      if (reads === 1) {
        return Promise.resolve({
          rows: [
            {
              org: "org" in world ? world.org : ORG,
              actor: "actor" in world ? world.actor : USER,
            },
          ],
        });
      }
      if (reads === 2) return Promise.resolve({ rows: [] });
      return Promise.resolve({
        rows: [
          {
            isolation: world.isolation ?? "read committed",
            seq: world.head?.seq ?? null,
            hash: world.head?.hash ?? null,
            ip: origin.ip,
          },
        ],
      });
    },
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        statements.push("INSERT");
        inserted.push(row);
        return Promise.resolve();
      },
    }),
  } as unknown as Tx;
  return { tx, statements, params, inserted };
}

const options = (actor?: "user" | "system") => ({
  clock: { now: () => NOW_MS },
  ids: { next: () => EVENT_ID },
  actor,
});

describe("recordAuditEvent(): before any SQL", () => {
  test("an invalid event or origin is refused naming the field; a clock out of range is refused", async () => {
    await expect(
      recordAuditEvent(noSql, options(), { ...event, action: "Nope" }, origin),
    ).rejects.toBeInstanceOf(AuditEventError);
    await expect(
      recordAuditEvent(noSql, options(), event, { correlationId: "" }),
    ).rejects.toBeInstanceOf(AuditEventError);
    for (const ms of [-1, 1.5, Number.NaN, Date.UTC(10_000, 0, 1)]) {
      await expect(
        recordAuditEvent(
          noSql,
          { ...options(), clock: { now: () => ms } },
          event,
          origin,
        ),
      ).rejects.toThrow("audit: the clock is out of range");
    }
  });
});

describe("recordAuditEvent(): in the transaction", () => {
  test("no tenant context (org or user unset) is AuditContextError after the first read; an isolation other than READ COMMITTED is AuditIsolationError after the lock", async () => {
    const noOrg = fakeTx({ org: null });
    await expect(
      recordAuditEvent(noOrg.tx, options(), event, origin),
    ).rejects.toBeInstanceOf(AuditContextError);
    expect(noOrg.statements).toHaveLength(1);
    const noUser = fakeTx({ actor: null });
    await expect(
      recordAuditEvent(noUser.tx, options("system"), event, origin),
    ).rejects.toBeInstanceOf(AuditContextError);
    const rr = fakeTx({ isolation: "repeatable read" });
    await expect(
      recordAuditEvent(rr.tx, options(), event, origin),
    ).rejects.toBeInstanceOf(AuditIsolationError);
    expect(rr.statements).toHaveLength(3);
    expect(rr.statements[1]).toContain("pg_advisory_xact_lock");
    expect(rr.inserted).toEqual([]);
  });

  test("the first event of an org: seq 1, linked to the genesis hash, actor user from the transaction; the hash matches the oracle", async () => {
    const f = fakeTx({});
    const recorded = await recordAuditEvent(f.tx, options(), event, origin);
    expect(recorded).toEqual({
      id: EVENT_ID,
      seq: "1",
      hash: expect.stringMatching(/^[0-9a-f]{64}$/) as string,
    });
    expect(f.statements.map((s) => s.slice(0, 6))).toEqual([
      "SELECT",
      "SELECT",
      "SELECT",
      "INSERT",
    ]);
    expect(f.statements[1]).toBe(
      "SELECT pg_advisory_xact_lock($1::integer, hashtext($2))",
    );
    expect(f.params[1]).toEqual([AUDIT_LOCK_NAMESPACE, ORG]);
    expect(f.inserted).toEqual([
      {
        id: EVENT_ID,
        orgId: ORG,
        seq: 1n,
        hashVersion: HASH_VERSION,
        occurredAt: "2026-10-22T12:00:00.250Z",
        actorType: "user",
        actorId: USER,
        deviceId: null,
        ip: origin.ip,
        geo: null,
        correlationId: "job-1",
        action: event.action,
        entityType: event.entityType,
        entityId: event.entityId,
        before: event.before,
        after: event.after,
        prevHash: genesisHash(),
        hash: expect.any(Buffer) as Buffer,
      },
    ]);
    const row = f.inserted[0];
    expect(row).toBeDefined();
    if (row === undefined) return;
    const expected = oracleHash(ORACLE_GENESIS, {
      id: EVENT_ID,
      org_id: ORG,
      seq: "1",
      hash_version: HASH_VERSION,
      occurred_at: "2026-10-22T12:00:00.250Z",
      actor_type: "user",
      actor_id: USER,
      device_id: null,
      ip: origin.ip,
      geo: null,
      correlation_id: "job-1",
      action: event.action,
      entity_type: event.entityType,
      entity_id: event.entityId,
      before: event.before,
      after: event.after,
    });
    expect((row.hash as Buffer).toString("hex")).toBe(expected.toString("hex"));
    expect(recorded.hash).toBe(expected.toString("hex"));
  });

  test("a later event links to the head: seq + 1 and prev_hash = the head's hash; the system actor writes actor_type system and actor_id NULL whatever the transaction's user", async () => {
    const head = { seq: "41", hash: Buffer.alloc(32, 7) };
    const f = fakeTx({ head });
    const recorded = await recordAuditEvent(
      f.tx,
      options("system"),
      event,
      origin,
    );
    expect(recorded.seq).toBe("42");
    const row = f.inserted[0];
    expect(row).toMatchObject({
      seq: 42n,
      actorType: "system",
      actorId: null,
      prevHash: head.hash,
    });
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect((row.hash as Buffer).toString("hex")).toBe(
      auditHash(head.hash, {
        id: EVENT_ID,
        org_id: ORG,
        seq: "42",
        hash_version: HASH_VERSION,
        occurred_at: "2026-10-22T12:00:00.250Z",
        actor_type: "system",
        actor_id: null,
        device_id: null,
        ip: origin.ip,
        geo: null,
        correlation_id: "job-1",
        action: event.action,
        entity_type: event.entityType,
        entity_id: event.entityId,
        before: event.before,
        after: event.after,
      }).toString("hex"),
    );
  });
});
