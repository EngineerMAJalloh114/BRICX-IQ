// AuditService.record() (P4-05, ADR 0055): appends one event to the
// current org's hash chain, inside the caller's transaction (TxRunner or
// withTx), so the event commits or rolls back with the change it records.
//   1. Validate the event and its origin (no database work before this).
//   2. Read app.current_org() and app.current_user_id(): the tenant and the
//      actor come from the transaction, never from the caller.
//   3. pg_advisory_xact_lock(AUDIT_LOCK_NAMESPACE, hashtext(org)): one
//      writer per org chain until the transaction ends.
//   4. Refuse unless READ COMMITTED (condition 4), read the chain head and
//      the ip in Postgres's inet::text form, insert seq + 1 with
//      hash = sha256(head hash ‖ JCS(row)).
// The lock is held until COMMIT, so record() is the last statement of the
// request transaction (ADR 0055): anything after it lengthens the time
// other writers in the org wait.
import { type Tx } from "@bricx/db/database";
import { auditEvents } from "@bricx/db/schema";
import {
  createUuidV7Generator,
  type UuidV7Generator,
} from "@bricx/ids/uuid-v7";
import { Inject, Injectable } from "@nestjs/common";
import { sql } from "drizzle-orm";
import { CLOCK, type Clock } from "../../common/clock.js";
import { currentRequestContext } from "../../common/db/request-context.js";
import { AuditContextError, AuditIsolationError } from "./audit-errors.js";
import {
  type AuditEventInput,
  type AuditOriginInput,
  validateAuditEvent,
  validateOrigin,
} from "./audit-event.js";
import {
  HASH_VERSION,
  type HashedRow,
  auditHash,
  genesisHash,
} from "./audit-hash.js";

/**
 * The first key of the two-key advisory lock ("AUDT"): its key space never
 * overlaps the migrator's one-key lock, and P9's journal chain takes its
 * own namespace.
 */
export const AUDIT_LOCK_NAMESPACE = 0x41_55_44_54;

/** The latest instant toISOString() writes as YYYY-MM-DDTHH:MM:SS.sssZ. */
const MAX_ISO_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

export interface RecordedAuditEvent {
  readonly id: string;
  readonly seq: string;
  /** The row's hash, lower-case hex. */
  readonly hash: string;
}

@Injectable()
export class AuditService {
  private readonly ids: UuidV7Generator;

  constructor(@Inject(CLOCK) private readonly clock: Clock) {
    this.ids = createUuidV7Generator({ clock });
  }

  /**
   * Appends `event` to the org's chain in `tx`. `origin` defaults to the
   * current request's (correlation id, ip, device, geo); outside a request,
   * to a fresh UUIDv7 correlation id and nothing else.
   */
  async record(
    tx: Tx,
    event: AuditEventInput,
    origin?: AuditOriginInput,
  ): Promise<RecordedAuditEvent> {
    const valid = validateAuditEvent(event);
    const from = validateOrigin(origin ?? this.requestOrigin());
    const ms = this.clock.now();
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_ISO_MS) {
      throw new Error("audit: the clock is out of range");
    }

    const who = await tx.execute<{ org: string | null; actor: string | null }>(
      sql`SELECT app.current_org()::text AS org, app.current_user_id()::text AS actor`,
    );
    const org = who.rows[0]?.org ?? null;
    const actor = who.rows[0]?.actor ?? null;
    if (org === null || actor === null) throw new AuditContextError();

    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_NAMESPACE}::integer, hashtext(${org}))`,
    );
    const state = await tx.execute<{
      isolation: string;
      seq: string | null;
      hash: Buffer | null;
      ip: string | null;
    }>(
      sql`SELECT current_setting('transaction_isolation') AS isolation,
                 head.seq::text AS seq, head.hash, ${from.ip}::inet::text AS ip
          FROM (SELECT 1) AS one
          LEFT JOIN LATERAL (
            SELECT seq, hash FROM bricx.audit_events
            WHERE org_id = ${org}::uuid ORDER BY seq DESC LIMIT 1
          ) AS head ON true`,
    );
    const now = state.rows[0];
    if (now?.isolation !== "read committed") throw new AuditIsolationError();
    const prev = now.hash ?? genesisHash();
    const seq = now.seq === null ? "1" : String(BigInt(now.seq) + 1n);

    const id = this.ids.next();
    const occurredAt = new Date(ms).toISOString();
    const row: HashedRow = {
      id,
      org_id: org,
      seq,
      hash_version: HASH_VERSION,
      occurred_at: occurredAt,
      actor_type: "user",
      actor_id: actor,
      device_id: from.deviceId,
      ip: now.ip,
      geo: from.geo,
      correlation_id: from.correlationId,
      action: valid.action,
      entity_type: valid.entityType,
      entity_id: valid.entityId,
      before: valid.before,
      after: valid.after,
    };
    const hash = auditHash(prev, row);
    await tx.insert(auditEvents).values({
      id,
      orgId: org,
      seq: BigInt(seq),
      hashVersion: HASH_VERSION,
      occurredAt,
      actorType: "user",
      actorId: actor,
      deviceId: from.deviceId,
      ip: now.ip,
      geo: from.geo,
      correlationId: from.correlationId,
      action: valid.action,
      entityType: valid.entityType,
      entityId: valid.entityId,
      before: valid.before,
      after: valid.after,
      prevHash: prev,
      hash,
    });
    return { id, seq, hash: hash.toString("hex") };
  }

  private requestOrigin(): AuditOriginInput {
    const context = currentRequestContext();
    if (context === undefined) return { correlationId: this.ids.next() };
    return {
      correlationId: context.correlationId,
      ip: context.ip,
      deviceId: context.deviceId,
      geo: context.geo,
    };
  }
}
