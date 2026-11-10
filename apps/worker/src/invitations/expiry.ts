// Expiring one invitation (P6-06, ADR 0077, D10): ONE withTx() as bricx_app
// in the invitation's org, as its inviter (the context only feeds RLS):
// expireInvitation() sets a pending row past expires_at (by the worker's
// Clock) to expired, and when it changed, recordAuditEvent() as actor
// `system` writes org.invitation.expire, the same event the API's lazy
// expiry writes (before {status pending}, after {status expired,
// projectId}). The row and its event commit together: an invitation is
// expired once and audited once, whichever of the sweeper and the API
// gets there first (the other sees no pending row).
import {
  type AuditEventInput,
  type AuditOriginInput,
  type AuditRecorderOptions,
  type RecordedAuditEvent,
  recordAuditEvent,
} from "@bricx/db/audit";
import type { Tx, TxContext } from "@bricx/db/database";
import {
  type InvitationRef,
  type SettledInvitation,
  expireInvitation,
} from "@bricx/db/invitations";

export const INVITATION_SUBJECT = "org.invitation";
export const INVITATION_EXPIRE_ACTION = `${INVITATION_SUBJECT}.expire`;

export interface InvitationExpirer {
  /** Expires `ref` when due; undefined when it was not (or is gone). */
  expire(
    ref: InvitationRef,
    correlationId: string,
  ): Promise<SettledInvitation | undefined>;
}

export interface InvitationExpiryStatements {
  expire: typeof expireInvitation;
  record(
    tx: Tx,
    options: AuditRecorderOptions,
    event: AuditEventInput,
    origin: AuditOriginInput,
  ): Promise<RecordedAuditEvent>;
}

const PRODUCTION: InvitationExpiryStatements = {
  expire: expireInvitation,
  record: recordAuditEvent,
};

export interface InvitationExpirerOptions {
  readonly database: {
    withTx<T>(context: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  };
  readonly clock: { now(): number };
  readonly ids: { next(): string };
  readonly statements?: InvitationExpiryStatements | undefined;
}

export function createInvitationExpirer(
  options: InvitationExpirerOptions,
): InvitationExpirer {
  const { database, clock, ids } = options;
  const statements = options.statements ?? PRODUCTION;
  const recorder: AuditRecorderOptions = { clock, ids, actor: "system" };
  return {
    expire: (ref, correlationId) =>
      database.withTx(
        { orgId: ref.orgId, userId: ref.invitedBy, projectIds: [] },
        async (tx) => {
          const settled = await statements.expire(
            tx,
            ref.id,
            new Date(clock.now()).toISOString(),
          );
          if (settled === undefined) return undefined;
          await statements.record(
            tx,
            recorder,
            {
              action: INVITATION_EXPIRE_ACTION,
              entityType: INVITATION_SUBJECT,
              entityId: settled.id,
              before: { status: "pending" },
              after: { status: "expired", projectId: settled.projectId },
            },
            { correlationId },
          );
          return settled;
        },
      ),
  };
}
