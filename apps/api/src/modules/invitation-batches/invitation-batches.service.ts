// Bulk invitations' service (P6-06c, ADR 0085; owner condition C5, answer
// Q5, plan K3 and K4). A batch is a list of single invites: each row is
// parsed with the single invite's schema and runs the single invite's own
// checks (InvitationsService.checkRow: the role, the project, holdsAll,
// the temporary-membership bounds); a row naming the owner role is
// refused first (owner_role: an owner comes only from a transfer, Q6,
// whoever sends it). A refused row is stored failed with its code and no
// inputs (no address) from the start; the rest are stored pending. The
// worker makes the invitations (the single invite's insert) and the send
// step mints the tokens (C5: no second mint path).
// - submit (org.member.invite, @Idempotent): under the org's batch lock,
//   the lazy purge of the org's stale batch, then one queued or running
//   batch per org (409 invitation.bulk_running) and the quota of
//   MAX_ROWS_PER_DAY rows per 24 h, refused rows counted (429
//   invitation.bulk_quota). Same transaction: the batch, its rows, ONE
//   invitations.bulk outbox row (the batch id and author) and ONE
//   org.invitation_batch.create event (counts only). A row refused for
//   escalation records one deduplicated escalation denial after commit.
//   202 {batchId, accepted, failed}.
// - reads (org.member.read): the batch with its counts, its rows by
//   number; never an address.
// - the lazy purge (K3, S29): a batch still queued or running an hour
//   after creation (the worker is down or behind) has every pending row
//   failed not_processed with its address cleared, and is done, with one
//   org.invitation_batch.complete event as system; on any read of it and
//   on any submit in its org. The worker's sweep does the same in every
//   org (residual: owner condition C4, ADR 0085).
// No address reaches a log line, an outbox row or an audit event.
import type { Tx } from "@bricx/db/database";
import {
  BATCH_PURGE_AFTER_MS,
  failPendingRows,
  finishBatch,
} from "@bricx/db/invitation-batches";
import {
  type UuidV7Generator,
  createUuidV7Generator,
} from "@bricx/ids/uuid-v7";
import { Inject, Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { membershipAbilityFor } from "../../common/auth/ability.js";
import { CLOCK, type Clock } from "../../common/clock.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError } from "../../common/errors/api-error.js";
import { AuditService, DenialRecorder } from "../audit/public-api.js";
import {
  CreateInvitation,
  InvitationsService,
  type RowRefusal,
  ownerRoleRefusal,
} from "../invitations/public-api.js";
import { OutboxService } from "../outbox/public-api.js";
import { RolesRepository } from "../roles/public-api.js";
import {
  type TransactionRunner,
  requireIdentity,
} from "../sessions/public-api.js";
import {
  BATCH_ROW_LIST_LIMIT,
  type BatchAcceptedData,
  type BatchRowData,
  type BatchRowsInput,
  type InvitationBatchData,
  MAX_ROWS_PER_DAY,
  QUOTA_WINDOW_MS,
  type SubmitBatchInput,
  decodeRowCursor,
  encodeRowCursor,
} from "./invitation-batches.dto.js";
import {
  INVITATIONS_BULK,
  type InvitationsBulk,
} from "./invitation-batches.events.js";
import {
  InvitationBatchesRepository,
  type NewBatchRow,
} from "./invitation-batches.repository.js";

/** The audited subject. */
export const INVITATION_BATCH_SUBJECT = "org.invitation_batch";

export type BatchAudit = Pick<AuditService, "record" | "recordSystem">;
export type BatchOutbox = Pick<OutboxService, "enqueue">;
export type BatchDenials = Pick<DenialRecorder, "record">;
type RowChecks = Pick<InvitationsService, "checkRow">;
type Roles = Pick<RolesRepository, "findOpen">;

/** What the controller calls. */
export type InvitationBatchesPort = Pick<
  InvitationBatchesService,
  "submit" | "get" | "rows"
>;

@Injectable()
export class InvitationBatchesService {
  private readonly ids: UuidV7Generator;

  constructor(
    @Inject(TxRunner) private readonly runner: TransactionRunner,
    @Inject(InvitationBatchesRepository)
    private readonly repository: InvitationBatchesRepository,
    @Inject(InvitationsService) private readonly invitations: RowChecks,
    @Inject(RolesRepository) private readonly roles: Roles,
    @Inject(AuditService) private readonly audit: BatchAudit,
    @Inject(OutboxService) private readonly outbox: BatchOutbox,
    @Inject(DenialRecorder) private readonly denials: BatchDenials,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.ids = createUuidV7Generator({ clock });
    this.logger.setContext("invitation-batches");
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /**
   * Settles `batch` when it is still open an hour after creation (K3):
   * pending rows not_processed (addresses cleared), the batch done, one
   * complete event as system. The batch as it now stands.
   */
  private async purgeIfStale(
    tx: Tx,
    orgId: string,
    batch: InvitationBatchData,
    now: string,
  ): Promise<InvitationBatchData> {
    if (
      batch.status === "done" ||
      Date.parse(batch.createdAt) + BATCH_PURGE_AFTER_MS > Date.parse(now)
    ) {
      return batch;
    }
    await failPendingRows(tx, batch.id, "not_processed", now);
    const counts = await finishBatch(tx, batch.id, now);
    if (counts !== undefined) {
      await this.audit.recordSystem(tx, {
        action: `${INVITATION_BATCH_SUBJECT}.complete`,
        entityType: INVITATION_BATCH_SUBJECT,
        entityId: batch.id,
        before: { status: batch.status },
        after: {
          status: "done",
          created: counts.created,
          failed: counts.failed,
        },
      });
      this.logger.info({ orgId, batchId: batch.id }, "invitation_batch.purged");
    }
    return (await this.repository.find(tx, orgId, batch.id)) ?? batch;
  }

  /** One row: parsed, then the single invite's checks (owner role first). */
  private async rowOf(
    tx: Tx,
    check: {
      readonly identity: ReturnType<typeof requireIdentity>;
      readonly ability: ReturnType<typeof membershipAbilityFor>;
      readonly now: string;
    },
    rowNo: number,
    raw: unknown,
  ): Promise<NewBatchRow> {
    const failed = (errorCode: RowRefusal): NewBatchRow => ({
      rowNo,
      status: "failed",
      errorCode,
    });
    const parsed = CreateInvitation.schema.safeParse(raw);
    if (!parsed.success) return failed("validation_failed");
    const input = parsed.data;
    const { orgId } = check.identity;
    const role = await this.roles.findOpen(tx, orgId, input.roleId);
    const projectRole =
      input.projectRoleId === undefined
        ? undefined
        : await this.roles.findOpen(tx, orgId, input.projectRoleId);
    const refusal = ownerRoleRefusal(role, projectRole);
    if (refusal !== undefined) return failed(refusal);
    const verdict = await this.invitations.checkRow(
      tx,
      check.identity,
      check.ability,
      input,
      check.now,
    );
    if (!verdict.ok) return failed(verdict.code);
    return {
      rowNo,
      status: "pending",
      email: input.email,
      roleId: verdict.role.roleId,
      projectId: verdict.project?.id ?? null,
      projectRoleId: verdict.project?.role.roleId ?? null,
      external: verdict.external,
      membershipExpiresAt: verdict.membershipExpiresAt,
    };
  }

  async submit(input: SubmitBatchInput): Promise<BatchAcceptedData> {
    const identity = requireIdentity();
    const { orgId, userId } = identity;
    const ability = membershipAbilityFor(identity);
    const batchId = this.ids.next();
    // Set inside the transaction; the answer alone is what an @Idempotent
    // run stores and replays.
    const seen: { escalated: boolean } = { escalated: false };
    const answer = await this.runner.run(
      async (tx): Promise<BatchAcceptedData> => {
        const now = this.now();
        await this.repository.lock(tx, orgId);
        const open = await this.repository.open(tx, orgId);
        if (
          open !== undefined &&
          (await this.purgeIfStale(tx, orgId, open, now)).status !== "done"
        ) {
          throw new ApiError("invitation.bulk_running");
        }
        const since = new Date(Date.parse(now) - QUOTA_WINDOW_MS).toISOString();
        const used = await this.repository.rowsSince(tx, orgId, since);
        if (used + input.rows.length > MAX_ROWS_PER_DAY) {
          this.logger.warn({ orgId, userId }, "invitation.bulk_quota");
          throw new ApiError("invitation.bulk_quota");
        }
        const rows: NewBatchRow[] = [];
        for (const [i, raw] of input.rows.entries()) {
          rows.push(
            await this.rowOf(tx, { identity, ability, now }, i + 1, raw),
          );
        }
        await this.repository.insert(tx, {
          id: batchId,
          orgId,
          createdBy: userId,
          rows,
          now,
        });
        const failed = rows.filter((row) => row.status === "failed").length;
        const accepted = rows.length - failed;
        const bulk: InvitationsBulk = { batchId, createdBy: userId };
        await this.outbox.enqueue(tx, INVITATIONS_BULK, bulk);
        await this.audit.record(tx, {
          action: `${INVITATION_BATCH_SUBJECT}.create`,
          entityType: INVITATION_BATCH_SUBJECT,
          entityId: batchId,
          after: { rowCount: rows.length, accepted, failed },
        });
        seen.escalated = rows.some(
          (row) => row.status === "failed" && row.errorCode === "escalation",
        );
        return { batchId, accepted, failed };
      },
    );
    if (seen.escalated) {
      this.logger.warn(
        { userId, orgId, reason: "escalation" },
        "invitation.denied",
      );
      await this.denials.record({
        orgId,
        actorId: userId,
        reason: "escalation",
        entityId: batchId,
        entityType: INVITATION_BATCH_SUBJECT,
      });
    }
    return answer;
  }

  /** The batch with its counts (purged first when stale). */
  async get(id: string): Promise<InvitationBatchData> {
    const { orgId } = requireIdentity();
    return this.runner.run(async (tx) => {
      const batch = await this.repository.find(tx, orgId, id);
      if (batch === undefined) throw new ApiError("not_found");
      return this.purgeIfStale(tx, orgId, batch, this.now());
    });
  }

  /** The batch's rows by number (purged first when stale). */
  async rows(
    id: string,
    query: BatchRowsInput,
  ): Promise<{ items: BatchRowData[]; nextCursor: string | null }> {
    const { orgId } = requireIdentity();
    const limit = query.limit ?? BATCH_ROW_LIST_LIMIT;
    const after =
      query.cursor === undefined ? 0 : (decodeRowCursor(query.cursor) ?? 0);
    return this.runner.run(async (tx) => {
      const batch = await this.repository.find(tx, orgId, id);
      if (batch === undefined) throw new ApiError("not_found");
      await this.purgeIfStale(tx, orgId, batch, this.now());
      const items = await this.repository.rows(tx, orgId, id, after, limit + 1);
      const page = items.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page,
        nextCursor:
          items.length > limit && last !== undefined
            ? encodeRowCursor(last.rowNo)
            : null,
      };
    });
  }
}
