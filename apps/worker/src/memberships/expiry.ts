// What the end of a temporary membership writes (P6-06b, ADR 0084; the
// P5-06 pattern of apps/worker/src/access/expiry.ts). The access itself
// ended at expires_at with no job: the API's grants source reads active
// rows at the request's Clock. What is left is the record.
// expire(): ONE withTx() as bricx_app in the membership's org, as its
// user, with every project of that org in scope (allProjects: the
// project_memberships policies need the row's project, which the job
// does not carry; the statements address one row by id):
// 1. expireMembership(): expired_at = now() by the database clock on an
//    open row past expires_at, else the row's state and no change (a
//    renewed row is `renewed` for a job made for the earlier end);
// 2. when it changed, recordAuditEvent() as actor `system` through the
//    shared recorder (@bricx/db/audit): action org.member.expire or
//    project.member.expire, entity the membership, before/after the
//    audited columns (never the suspension reason, which the worker never
//    reads), correlation = the outbox id (or sweep.<membership id>).
// All or nothing: a membership is audited exactly once, and never marked
// expired without its event. Sessions are not closed (owner answer Q4):
// the member's next request is refused by the grants source.
// notify(): ONE withTx() the same way: markExpiryNotified() claims the
// row's one notice, then one memberships.expiring outbox row (owner
// condition C8); false when another run claimed it.
import {
  type AuditEventInput,
  type AuditOriginInput,
  type AuditRecorderOptions,
  type RecordedAuditEvent,
  recordAuditEvent,
} from "@bricx/db/audit";
import type { Tx, TxContext } from "@bricx/db/database";
import {
  type DueMembership,
  type MembershipExpireOutcome,
  type MembershipKind,
  expireMembership,
  markExpiryNotified,
} from "@bricx/db/memberships";
import { insertOutbox } from "@bricx/db/outbox";

/** The audited subjects (the API's membership events share them). */
export const ORG_MEMBER_SUBJECT = "org.member";
export const PROJECT_MEMBER_SUBJECT = "project.member";
export const MEMBERSHIPS_EXPIRING = "memberships.expiring";

export const subjectOf = (kind: MembershipKind): string =>
  kind === "org" ? ORG_MEMBER_SUBJECT : PROJECT_MEMBER_SUBJECT;

export interface MembershipExpirer {
  /**
   * Records the expiry of `membership` when it is due; undefined when the
   * transaction sees no such row. `scheduledFor` is the end a delayed job
   * was made for.
   */
  expire(
    membership: DueMembership,
    correlationId: string,
    scheduledFor?: string,
  ): Promise<MembershipExpireOutcome | undefined>;
  /** Writes the row's one expiry notice; false when it already has one. */
  notify(membership: DueMembership): Promise<boolean>;
}

/** The statements; the production ones unless a test says otherwise. */
export interface MembershipStatements {
  expire(
    tx: Tx,
    kind: MembershipKind,
    id: string,
    scheduledFor?: string,
  ): Promise<MembershipExpireOutcome | undefined>;
  record(
    tx: Tx,
    options: AuditRecorderOptions,
    event: AuditEventInput,
    origin: AuditOriginInput,
  ): Promise<RecordedAuditEvent>;
  claimNotice(tx: Tx, kind: MembershipKind, id: string): Promise<boolean>;
  enqueue(tx: Tx, topic: string, payload: unknown, id: string): Promise<void>;
}

const PRODUCTION: MembershipStatements = {
  expire: expireMembership,
  record: recordAuditEvent,
  claimNotice: markExpiryNotified,
  enqueue: (tx, topic, payload, id) => insertOutbox(tx, topic, payload, id),
};

export interface MembershipExpirerOptions {
  /** The bricx_app pool (DATABASE_URL). */
  readonly database: {
    withTx<T>(context: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  };
  /** The worker's clock: occurred_at of the event (CLAUDE.md rule 7). */
  readonly clock: { now(): number };
  /** UUIDv7 ids for the event and the outbox row. */
  readonly ids: { next(): string };
  readonly statements?: MembershipStatements | undefined;
}

export function createMembershipExpirer(
  options: MembershipExpirerOptions,
): MembershipExpirer {
  const { database, clock, ids } = options;
  const statements = options.statements ?? PRODUCTION;
  const recorder: AuditRecorderOptions = { clock, ids, actor: "system" };
  const contextOf = (membership: DueMembership): TxContext => ({
    orgId: membership.orgId,
    userId: membership.userId,
    projectIds: [],
    allProjects: true,
  });
  return {
    expire: (membership, correlationId, scheduledFor) =>
      database.withTx(contextOf(membership), async (tx) => {
        const outcome = await statements.expire(
          tx,
          membership.kind,
          membership.id,
          scheduledFor,
        );
        if (outcome === undefined || !outcome.changed) return outcome;
        const subject = subjectOf(membership.kind);
        await statements.record(
          tx,
          recorder,
          {
            action: `${subject}.expire`,
            entityType: subject,
            entityId: outcome.membership.id,
            before: { ...outcome.membership, expiredAt: null },
            after: outcome.membership,
          },
          { correlationId },
        );
        return outcome;
      }),
    notify: (membership) =>
      database.withTx(contextOf(membership), async (tx) => {
        const claimed = await statements.claimNotice(
          tx,
          membership.kind,
          membership.id,
        );
        if (!claimed) return false;
        await statements.enqueue(
          tx,
          MEMBERSHIPS_EXPIRING,
          {
            kind: membership.kind,
            membershipId: membership.id,
            userId: membership.userId,
          },
          ids.next(),
        );
        return true;
      }),
  };
}
