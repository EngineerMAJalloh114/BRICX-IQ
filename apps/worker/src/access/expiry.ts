// What expiring one grant writes (P5-06, D-G, owner conditions 3, 4 and
// 6, ADR 0067): ONE withTx() as bricx_app in the grant's org (the API's
// role; RLS scopes every statement), as its user (the context only feeds
// RLS: the audit actor is `system`):
// 1. expireAccessGrant(): expired_at = now() by the database clock on an
//    open grant past expires_at, else the row's state and no change;
// 2. when it changed, recordAuditEvent() as actor `system` (actor_id
//    NULL) through the shared recorder (@bricx/db/audit, the same hash
//    chain the API appends to): action org.access_grant.expire, entity
//    the grant, before/after the audited columns (never the reason, which
//    the worker never reads), correlation = the outbox id (or
//    sweep.<grant id>), occurred_at from the injected Clock;
// 3. then one users.mfa_check row for the user (the MFA consumer clears
//    bricx-mfa when nothing else needs it).
// All or nothing: the row, its event and the check commit together, so a
// grant is audited exactly once, and never expired without its event.
import {
  type DueAccessGrant,
  type ExpireOutcome,
  expireAccessGrant,
} from "@bricx/db/access-grants";
import {
  type AuditEventInput,
  type AuditOriginInput,
  type AuditRecorderOptions,
  type RecordedAuditEvent,
  recordAuditEvent,
} from "@bricx/db/audit";
import type { Tx, TxContext } from "@bricx/db/database";
import { insertOutbox } from "@bricx/db/outbox";

/** The audited action and its subject (the API's grant and revoke share the subject). */
export const ACCESS_GRANT_SUBJECT = "org.access_grant";
export const ACCESS_GRANT_EXPIRE_ACTION = `${ACCESS_GRANT_SUBJECT}.expire`;
const MFA_CHECK = "users.mfa_check";

export interface AccessExpirer {
  /**
   * Expires `grant` when it is due, in one transaction with its audit
   * event and MFA check; undefined when the transaction sees no such row.
   */
  expire(
    grant: DueAccessGrant,
    correlationId: string,
  ): Promise<ExpireOutcome | undefined>;
}

/** The statements of one expiry; the production ones unless a test says otherwise. */
export interface ExpiryStatements {
  expire(tx: Tx, grantId: string): Promise<ExpireOutcome | undefined>;
  record(
    tx: Tx,
    options: AuditRecorderOptions,
    event: AuditEventInput,
    origin: AuditOriginInput,
  ): Promise<RecordedAuditEvent>;
  enqueue(tx: Tx, topic: string, payload: unknown, id: string): Promise<void>;
}

const PRODUCTION: ExpiryStatements = {
  expire: expireAccessGrant,
  record: recordAuditEvent,
  enqueue: (tx, topic, payload, id) => insertOutbox(tx, topic, payload, id),
};

export interface AccessExpirerOptions {
  /** The bricx_app pool (DATABASE_URL). */
  readonly database: {
    withTx<T>(context: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  };
  /** The worker's clock: occurred_at of the event (CLAUDE.md rule 7). */
  readonly clock: { now(): number };
  /** UUIDv7 ids for the event and the outbox row. */
  readonly ids: { next(): string };
  readonly statements?: ExpiryStatements | undefined;
}

export function createAccessExpirer(
  options: AccessExpirerOptions,
): AccessExpirer {
  const { database, clock, ids } = options;
  const statements = options.statements ?? PRODUCTION;
  const recorder: AuditRecorderOptions = { clock, ids, actor: "system" };
  return {
    expire: (grant, correlationId) =>
      database.withTx(
        { orgId: grant.orgId, userId: grant.userId, projectIds: [] },
        async (tx) => {
          const outcome = await statements.expire(tx, grant.id);
          if (outcome === undefined || !outcome.changed) return outcome;
          await statements.record(
            tx,
            recorder,
            {
              action: ACCESS_GRANT_EXPIRE_ACTION,
              entityType: ACCESS_GRANT_SUBJECT,
              entityId: outcome.grant.id,
              before: { ...outcome.grant, expiredAt: null },
              after: outcome.grant,
            },
            { correlationId },
          );
          await statements.enqueue(
            tx,
            MFA_CHECK,
            { userId: outcome.grant.userId },
            ids.next(),
          );
          return outcome;
        },
      ),
  };
}
