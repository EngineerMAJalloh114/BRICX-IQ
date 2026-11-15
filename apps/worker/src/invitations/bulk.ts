// The bulk invitation consumer's work (P6-06c, ADR 0085; owner condition
// C5, plan K3 and K5). A batch's pending rows become invitations through
// the single invite's own statement (@bricx/db/invitations'
// insertPendingInvitation), each with the single invite's
// invitations.send outbox row and org.invitation.create event; the send
// step (send.ts) is the only one that mints a token. Nothing here mints.
// processRows(): ONE withTx() as bricx_app in the batch's org, as its
// author (created_by; the context feeds RLS and the audit actor):
// 1. the batch (missing or done: nothing to do); queued -> running;
// 2. the author re-checked at the run (S17): an archived org fails every
//    pending row org_archived, an author without an active membership
//    inactive_inviter; their keys are NOT re-read (K5: a demoted
//    inviter's invitation is refused at accept, the API's check);
// 3. up to `limit` pending rows in order, each locked (SKIP LOCKED): the
//    insert in a savepoint; a pending invitation for the address already
//    is pending_exists, any other refusal of the insert conflict; the row
//    settles with its invitation id or code and its address cleared in
//    the same UPDATE;
// 4. no pending row left: the batch is done with its counts and one
//    org.invitation_batch.complete event as system.
// A crash rolls the whole step back; a retry or a second run finds only
// the rows still pending (S20: no duplicate).
// purge(): the sweep's step for a batch still open an hour after creation
// (K3): every pending row failed not_processed, address cleared; done.
// Logs carry ids and counts only, never an address.
import { type AuditRecorderOptions, recordAuditEvent } from "@bricx/db/audit";
import type { Tx, TxContext } from "@bricx/db/database";
import {
  type BatchCounts,
  type BatchRowErrorCode,
  batchInvitationExpiresAt,
  batchInviterState,
  failPendingRows,
  finishBatch,
  pendingBatchRows,
  readBatch,
  settleBatchRow,
  startBatch,
} from "@bricx/db/invitation-batches";
import { insertPendingInvitation } from "@bricx/db/invitations";
import { insertOutbox } from "@bricx/db/outbox";
import type { RelayLogger } from "../relay/relay.js";
import { INVITATION_SUBJECT } from "./expiry.js";

export const INVITATION_BATCH_SUBJECT = "org.invitation_batch";
export const INVITATIONS_SEND_TOPIC = "invitations.send";
/** Rows one run takes (a batch has at most 200). */
export const BATCH_RUN_LIMIT = 200;

/** A batch as a job or the sweep names it. */
export interface BatchRef {
  readonly batchId: string;
  readonly orgId: string;
  readonly createdBy: string;
}

export type BatchRunOutcome =
  | { readonly state: "missing" | "done_already" }
  | {
      readonly state: "partial" | "done";
      readonly created: number;
      readonly failed: number;
    };

export interface InvitationBatchProcessor {
  /** One run over at most `limit` pending rows (default BATCH_RUN_LIMIT). */
  processRows(
    ref: BatchRef,
    correlationId: string,
    limit?: number,
  ): Promise<BatchRunOutcome>;
  /** The sweep's purge of a stale batch; the counts when it closed it. */
  purge(ref: BatchRef, correlationId: string): Promise<BatchCounts | undefined>;
}

export interface InvitationBatchProcessorOptions {
  readonly database: {
    withTx<T>(context: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  };
  readonly clock: { now(): number };
  readonly ids: { next(): string };
  readonly logger: RelayLogger;
}

/** A savepoint's insert refused by the database (any SQLSTATE). */
class RowRefused extends Error {}

export function createInvitationBatchProcessor(
  options: InvitationBatchProcessorOptions,
): InvitationBatchProcessor {
  const { database, clock, ids, logger } = options;
  const asUser: AuditRecorderOptions = { clock, ids, actor: "user" };
  const asSystem: AuditRecorderOptions = { clock, ids, actor: "system" };
  const contextOf = (ref: BatchRef): TxContext => ({
    orgId: ref.orgId,
    userId: ref.createdBy,
    projectIds: [],
    allProjects: true,
  });

  const finish = async (
    tx: Tx,
    ref: BatchRef,
    now: string,
    correlationId: string,
  ): Promise<BatchCounts | undefined> => {
    const counts = await finishBatch(tx, ref.batchId, now);
    if (counts === undefined) return undefined;
    await recordAuditEvent(
      tx,
      asSystem,
      {
        action: `${INVITATION_BATCH_SUBJECT}.complete`,
        entityType: INVITATION_BATCH_SUBJECT,
        entityId: ref.batchId,
        after: { created: counts.created, failed: counts.failed },
      },
      { correlationId },
    );
    return counts;
  };

  return {
    processRows: (ref, correlationId, limit = BATCH_RUN_LIMIT) =>
      database.withTx(contextOf(ref), async (tx): Promise<BatchRunOutcome> => {
        const now = new Date(clock.now()).toISOString();
        const batch = await readBatch(tx, ref.batchId);
        if (batch === undefined) return { state: "missing" };
        if (batch.status === "done") return { state: "done_already" };
        await startBatch(tx, ref.batchId, now);
        const inviter = await batchInviterState(
          tx,
          ref.orgId,
          batch.createdBy,
          now,
        );
        let created = 0;
        let failed = 0;
        if (inviter !== "active") {
          failed = await failPendingRows(
            tx,
            ref.batchId,
            inviter === "org_archived" ? "org_archived" : "inviter_inactive",
            now,
          );
        } else {
          const expiresAt = await batchInvitationExpiresAt(tx, ref.orgId, now);
          for (const row of await pendingBatchRows(tx, ref.batchId, limit)) {
            const id = ids.next();
            let code: BatchRowErrorCode | undefined;
            let sendSeq = 0;
            try {
              const inserted = await tx.transaction(async (savepoint) => {
                try {
                  return await insertPendingInvitation(savepoint, {
                    id,
                    orgId: ref.orgId,
                    projectId: row.projectId,
                    email: row.email,
                    roleId: row.roleId,
                    projectRoleId: row.projectRoleId,
                    invitedBy: batch.createdBy,
                    expiresAt,
                    now,
                    external: row.external,
                    membershipExpiresAt: row.membershipExpiresAt,
                  });
                } catch {
                  throw new RowRefused();
                }
              });
              if (inserted === undefined) code = "pending_exists";
              else sendSeq = inserted.sendSeq;
            } catch (error) {
              if (!(error instanceof RowRefused)) throw error;
              code = "conflict";
            }
            if (code !== undefined) {
              await settleBatchRow(tx, {
                batchId: ref.batchId,
                rowNo: row.rowNo,
                now,
                errorCode: code,
              });
              failed += 1;
              continue;
            }
            await insertOutbox(
              tx,
              INVITATIONS_SEND_TOPIC,
              { invitationId: id, sendSeq, invitedBy: batch.createdBy },
              ids.next(),
            );
            await recordAuditEvent(
              tx,
              asUser,
              {
                action: `${INVITATION_SUBJECT}.create`,
                entityType: INVITATION_SUBJECT,
                entityId: id,
                after: {
                  status: "pending",
                  projectId: row.projectId,
                  roleId: row.roleId,
                  projectRoleId: row.projectRoleId,
                  expiresAt,
                  resendCount: 0,
                  external: row.external,
                  membershipExpiresAt: row.membershipExpiresAt,
                  batchId: ref.batchId,
                },
              },
              { correlationId },
            );
            await settleBatchRow(tx, {
              batchId: ref.batchId,
              rowNo: row.rowNo,
              now,
              invitationId: id,
            });
            created += 1;
          }
        }
        const counts = await finish(tx, ref, now, correlationId);
        logger.info(
          {
            batchId: ref.batchId,
            orgId: ref.orgId,
            created,
            failed,
            done: counts !== undefined,
          },
          "invitation_batch.run",
        );
        return {
          state: counts === undefined ? "partial" : "done",
          created,
          failed,
        };
      }),
    purge: (ref, correlationId) =>
      database.withTx(contextOf(ref), async (tx) => {
        const now = new Date(clock.now()).toISOString();
        const batch = await readBatch(tx, ref.batchId);
        if (batch === undefined || batch.status === "done") return undefined;
        await failPendingRows(tx, ref.batchId, "not_processed", now);
        return finish(tx, ref, now, correlationId);
      }),
  };
}
