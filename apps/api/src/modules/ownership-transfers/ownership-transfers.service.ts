// Ownership transfers' service (P6-06c, ADR 0085; owner answers Q1-Q6,
// conditions C1-C5). The only way the owner role moves (Q6): an owner
// starts a transfer to a member, the member accepts it. Every call runs in
// one TxRunner transaction under the org's members lock (the memberships
// module's advisory lock), so a transfer, the cascades and the member
// changes serialise per org.
// - start: the caller is an ACTIVE member whose role has system_key
//   'owner' (a custom role holding every key is not an owner: 403 and one
//   deduplicated ownership_not_owner denial); the typed name equals the
//   org's legal name after NFKC and trim (422 at organisationName); the
//   recipient is not the caller (422), an open member (404), active,
//   internal and permanent (409 request.conflict); the previous role is an
//   open role of the org (404) and not the owner role (422); one pending
//   transfer per org (409 ownership.transfer_pending; the partial unique
//   index is the backstop under concurrency). Same transaction: the row
//   (expires_at = Clock + 24 h), org.ownership_transfer.start, the
//   recipient's users.mfa_check (app.mfa_state v4 counts a pending
//   transfer) and the delayed ownership.expire job.
// - accept (recipient only; the initiator is 403 and one
//   ownership_self_accept denial, Q1 SoD; anyone else 404): pending and
//   live at the Clock, else 409 (a due row is refused with nothing
//   written: these routes are @Idempotent, one transaction storing only a
//   success; the ownership.expire job and the sweep record the expiry as
//   system, and a start in the org records it lazily); the typed name;
//   both parties still in place (409). Then the transfer is accepted (the
//   guard records accepted_xact) and the memberships repository's one
//   dedicated method (transferOwnership) gives the recipient the owner
//   role and the initiator the previous role, then re-checks that an
//   active owner remains: memberships_guard v2 lets exactly these two
//   role changes through in this transaction. Audited: accept and one
//   org.member.update per membership; a users.mfa_check for each party.
//   Sessions are kept (Q2): the next request reads the new grants (K1).
// - decline (recipient), cancel (any active owner; acr mfa, else 401
//   permission.step_up_required; not fresh; a settled one is 409 first,
//   so a cancel that lost the race to an accept is 409): audited, with
//   the recipient's users.mfa_check.
// - GET pending: the org's pending transfer, for an active owner or the
//   recipient, else 404.
// The typed name is never logged, stored or answered (DW11).
import type { Tx } from "@bricx/db/database";
import { expireOwnershipTransfer } from "@bricx/db/ownership";
import {
  type UuidV7Generator,
  createUuidV7Generator,
} from "@bricx/ids/uuid-v7";
import { errorEnvelope } from "@bricx/validation/error-envelope";
import { Inject, Injectable } from "@nestjs/common";
import { PinoLogger } from "nestjs-pino";
import { CLOCK, type Clock } from "../../common/clock.js";
import { OWNERSHIP_TRANSFER_SUBJECT } from "../../common/db/ownership-canceller.js";
import type { Identity } from "../../common/db/request-context.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError, ValidationError } from "../../common/errors/api-error.js";
import { MFA_ACR } from "../../common/auth/token-verifier.js";
import {
  AuditService,
  type DeniedReason,
  DenialRecorder,
} from "../audit/public-api.js";
import { MembershipsRepository } from "../memberships/public-api.js";
import { OutboxService } from "../outbox/public-api.js";
import {
  RolesRepository,
  USERS_MFA_CHECK,
  type UsersMfaCheck,
} from "../roles/public-api.js";
import {
  type TransactionRunner,
  requireIdentity,
} from "../sessions/public-api.js";
import type {
  OwnershipTransferData,
  StartTransferInput,
  TransferNameInput,
} from "./ownership-transfers.dto.js";
import {
  OWNERSHIP_EXPIRE,
  type OwnershipExpire,
} from "./ownership-transfers.events.js";
import { OwnershipTransfersRepository } from "./ownership-transfers.repository.js";

/** How long a transfer stays pending (Q5: 24 h). */
export const TRANSFER_TTL_MS = 86_400_000;
/** The membership audit subject (the memberships module's events). */
const ORG_MEMBER_SUBJECT = "org.member";

export type OwnershipAudit = Pick<AuditService, "record" | "recordSystem">;
export type OwnershipOutbox = Pick<OutboxService, "enqueue">;
export type OwnershipDenials = Pick<DenialRecorder, "record">;
type Members = Pick<
  MembershipsRepository,
  "lockOrg" | "findOrgOfUser" | "transferOwnership"
>;
type Roles = Pick<RolesRepository, "findOpen">;

/** What the controller calls. */
export type OwnershipTransfersPort = Pick<
  OwnershipTransfersService,
  "start" | "pending" | "accept" | "decline" | "cancel"
>;

/** A name folded for the comparison: NFKC, then trimmed (S15). */
export const foldName = (name: string): string => name.normalize("NFKC").trim();

/** A refusal found in the transaction, answered after its rollback with one denial. */
class Denied extends Error {
  constructor(
    readonly reason: DeniedReason,
    readonly entityId: string,
  ) {
    super("denied");
  }
}

/** Whether `transfer` has reached expires_at at `now` (the Clock). */
const isDue = (transfer: OwnershipTransferData, now: string): boolean =>
  Date.parse(transfer.expiresAt) <= Date.parse(now);

const invalidField = (field: string): ValidationError =>
  new ValidationError({
    ...errorEnvelope("validation_failed"),
    issues: [
      { path: [field], code: "invalid_value", key: "validation:invalid_value" },
    ],
  });

interface Member {
  readonly id: string;
  readonly roleId: string;
  readonly systemKey: string | null;
  readonly suspendedAt: string | null;
  readonly expiresAt: string | null;
  readonly external: boolean;
}

/** Open, not suspended, permanent and internal (an owner is never temporary or external). */
const isActivePermanent = (m: Member): boolean =>
  m.suspendedAt === null && m.expiresAt === null && !m.external;

const isActiveOwner = (m: Member | undefined): m is Member =>
  m !== undefined && m.systemKey === "owner" && isActivePermanent(m);

@Injectable()
export class OwnershipTransfersService {
  private readonly ids: UuidV7Generator;

  constructor(
    @Inject(TxRunner) private readonly runner: TransactionRunner,
    @Inject(OwnershipTransfersRepository)
    private readonly repository: OwnershipTransfersRepository,
    @Inject(MembershipsRepository) private readonly members: Members,
    @Inject(RolesRepository) private readonly roles: Roles,
    @Inject(AuditService) private readonly audit: OwnershipAudit,
    @Inject(OutboxService) private readonly outbox: OwnershipOutbox,
    @Inject(DenialRecorder) private readonly denials: OwnershipDenials,
    @Inject(CLOCK) private readonly clock: Clock,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.ids = createUuidV7Generator({ clock });
    this.logger.setContext("ownership-transfers");
  }

  private now(): string {
    return new Date(this.clock.now()).toISOString();
  }

  /** Runs `work`; a Denied it throws becomes 403 and one denial, after the rollback. */
  private async guarded<T>(
    identity: Identity,
    work: () => Promise<T>,
  ): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof Denied)) throw error;
      this.logger.warn(
        {
          userId: identity.userId,
          orgId: identity.orgId,
          reason: error.reason,
        },
        "ownership.denied",
      );
      await this.denials.record({
        orgId: identity.orgId,
        actorId: identity.userId,
        reason: error.reason,
        entityId: error.entityId,
        entityType: OWNERSHIP_TRANSFER_SUBJECT,
      });
      throw new ApiError("forbidden");
    }
  }

  /** The typed name against the org's legal name, both folded. */
  private async checkName(tx: Tx, orgId: string, typed: string): Promise<void> {
    const legal = await this.repository.legalName(tx, orgId);
    if (legal === undefined || foldName(typed) !== foldName(legal)) {
      throw invalidField("organisationName");
    }
  }

  private async mfaCheck(tx: Tx, userId: string): Promise<void> {
    const check: UsersMfaCheck = { userId };
    await this.outbox.enqueue(tx, USERS_MFA_CHECK, check);
  }

  /**
   * Expires `transfer` when it is due at the Clock (lazy expiry, S14): one
   * org.ownership_transfer.expire as system and the recipient's mfa check.
   * True when it is (now) expired.
   */
  private async expireIfDue(
    tx: Tx,
    transfer: OwnershipTransferData,
    now: string,
  ): Promise<boolean> {
    if (!isDue(transfer, now)) return false;
    const outcome = await expireOwnershipTransfer(tx, transfer.id, now);
    if (outcome?.changed === true) {
      await this.audit.recordSystem(tx, {
        action: `${OWNERSHIP_TRANSFER_SUBJECT}.expire`,
        entityType: OWNERSHIP_TRANSFER_SUBJECT,
        entityId: transfer.id,
        before: { status: "pending" },
        after: {
          status: "expired",
          initiatedBy: transfer.initiatedBy,
          toUserId: transfer.toUserId,
        },
      });
      await this.mfaCheck(tx, transfer.toUserId);
    }
    return true;
  }

  async start(input: StartTransferInput): Promise<OwnershipTransferData> {
    const identity = requireIdentity();
    const { orgId, userId } = identity;
    return this.guarded(identity, () =>
      this.runner.run(async (tx) => {
        const now = this.now();
        await this.members.lockOrg(tx, orgId);
        const caller = await this.members.findOrgOfUser(tx, orgId, userId);
        if (!isActiveOwner(caller)) {
          throw new Denied("ownership_not_owner", orgId);
        }
        await this.checkName(tx, orgId, input.organisationName);
        if (input.toUserId === userId) throw invalidField("toUserId");
        const recipient = await this.members.findOrgOfUser(
          tx,
          orgId,
          input.toUserId,
        );
        if (recipient === undefined) throw new ApiError("not_found");
        if (!isActivePermanent(recipient)) {
          throw new ApiError("request.conflict");
        }
        const role = await this.roles.findOpen(
          tx,
          orgId,
          input.previousOwnerRoleId,
        );
        if (role === undefined) throw new ApiError("not_found");
        if (role.systemKey === "owner") {
          throw invalidField("previousOwnerRoleId");
        }
        const pending = await this.repository.pending(tx, orgId);
        if (
          pending !== undefined &&
          !(await this.expireIfDue(tx, pending, now))
        ) {
          throw new ApiError("ownership.transfer_pending");
        }
        const expiresAt = new Date(
          Date.parse(now) + TRANSFER_TTL_MS,
        ).toISOString();
        const transfer = await this.repository.insert(tx, {
          id: this.ids.next(),
          orgId,
          initiatedBy: userId,
          toUserId: input.toUserId,
          previousOwnerRoleId: role.id,
          expiresAt,
          now,
        });
        await this.mfaCheck(tx, transfer.toUserId);
        const expire: OwnershipExpire = {
          transferId: transfer.id,
          toUserId: transfer.toUserId,
          expiresAt: transfer.expiresAt,
        };
        await this.outbox.enqueue(tx, OWNERSHIP_EXPIRE, expire, {
          notBefore: transfer.expiresAt,
        });
        await this.audit.record(tx, {
          action: `${OWNERSHIP_TRANSFER_SUBJECT}.start`,
          entityType: OWNERSHIP_TRANSFER_SUBJECT,
          entityId: transfer.id,
          after: {
            status: "pending",
            toUserId: transfer.toUserId,
            previousOwnerRoleId: transfer.previousOwnerRoleId,
            expiresAt: transfer.expiresAt,
          },
        });
        return transfer;
      }),
    );
  }

  /** The org's pending transfer, for an active owner or its recipient (else 404). */
  async pending(): Promise<OwnershipTransferData> {
    const identity = requireIdentity();
    const { orgId, userId } = identity;
    return this.runner.run(async (tx) => {
      const transfer = await this.repository.pending(tx, orgId);
      if (
        transfer === undefined ||
        Date.parse(transfer.expiresAt) <= this.clock.now()
      ) {
        throw new ApiError("not_found");
      }
      if (transfer.toUserId === userId) return transfer;
      const caller = await this.members.findOrgOfUser(tx, orgId, userId);
      if (!isActiveOwner(caller)) throw new ApiError("not_found");
      return transfer;
    });
  }

  async accept(
    id: string,
    input: TransferNameInput,
  ): Promise<OwnershipTransferData> {
    const identity = requireIdentity();
    const { orgId, userId } = identity;
    return this.guarded(identity, () =>
      this.runner.run(async (tx) => {
        const now = this.now();
        await this.members.lockOrg(tx, orgId);
        const transfer = await this.repository.findForUpdate(tx, orgId, id);
        if (transfer === undefined) throw new ApiError("not_found");
        if (transfer.initiatedBy === userId) {
          throw new Denied("ownership_self_accept", transfer.id);
        }
        if (transfer.toUserId !== userId) throw new ApiError("not_found");
        if (transfer.status !== "pending") {
          throw new ApiError("request.conflict");
        }
        // Due at the Clock: refused, nothing written (an @Idempotent
        // route runs one transaction and stores only a success). The
        // ownership.expire job (not_before = expires_at) and the sweep
        // record the expiry; a start in the org records it lazily.
        if (isDue(transfer, now)) throw new ApiError("request.conflict");
        await this.checkName(tx, orgId, input.organisationName);
        const recipient = await this.members.findOrgOfUser(tx, orgId, userId);
        const initiator = await this.members.findOrgOfUser(
          tx,
          orgId,
          transfer.initiatedBy,
        );
        const role = await this.roles.findOpen(
          tx,
          orgId,
          transfer.previousOwnerRoleId,
        );
        if (
          recipient === undefined ||
          !isActivePermanent(recipient) ||
          !isActiveOwner(initiator) ||
          role === undefined ||
          role.systemKey === "owner"
        ) {
          throw new ApiError("request.conflict");
        }
        const accepted = await this.repository.settle(
          tx,
          orgId,
          transfer.id,
          { status: "accepted", by: userId },
          now,
        );
        await this.members.transferOwnership(tx, orgId, {
          recipientMembershipId: recipient.id,
          ownerRoleId: initiator.roleId,
          initiatorMembershipId: initiator.id,
          previousRoleId: role.id,
        });
        await this.mfaCheck(tx, userId);
        await this.mfaCheck(tx, transfer.initiatedBy);
        await this.audit.record(tx, {
          action: `${ORG_MEMBER_SUBJECT}.update`,
          entityType: ORG_MEMBER_SUBJECT,
          entityId: recipient.id,
          before: { userId, roleId: recipient.roleId },
          after: { userId, roleId: initiator.roleId, transferId: transfer.id },
        });
        await this.audit.record(tx, {
          action: `${ORG_MEMBER_SUBJECT}.update`,
          entityType: ORG_MEMBER_SUBJECT,
          entityId: initiator.id,
          before: { userId: transfer.initiatedBy, roleId: initiator.roleId },
          after: {
            userId: transfer.initiatedBy,
            roleId: role.id,
            transferId: transfer.id,
          },
        });
        await this.audit.record(tx, {
          action: `${OWNERSHIP_TRANSFER_SUBJECT}.accept`,
          entityType: OWNERSHIP_TRANSFER_SUBJECT,
          entityId: transfer.id,
          before: { status: "pending" },
          after: {
            status: "accepted",
            initiatedBy: transfer.initiatedBy,
            toUserId: transfer.toUserId,
          },
        });
        return accepted;
      }),
    );
  }

  async decline(id: string): Promise<OwnershipTransferData> {
    const identity = requireIdentity();
    const { orgId, userId } = identity;
    return this.runner.run(async (tx) => {
      const now = this.now();
      await this.members.lockOrg(tx, orgId);
      const transfer = await this.repository.findForUpdate(tx, orgId, id);
      if (transfer === undefined || transfer.toUserId !== userId) {
        throw new ApiError("not_found");
      }
      if (transfer.status !== "pending") {
        throw new ApiError("request.conflict");
      }
      if (isDue(transfer, now)) throw new ApiError("request.conflict");
      const declined = await this.repository.settle(
        tx,
        orgId,
        transfer.id,
        { status: "declined", by: userId },
        now,
      );
      await this.mfaCheck(tx, transfer.toUserId);
      await this.audit.record(tx, {
        action: `${OWNERSHIP_TRANSFER_SUBJECT}.decline`,
        entityType: OWNERSHIP_TRANSFER_SUBJECT,
        entityId: transfer.id,
        before: { status: "pending" },
        after: {
          status: "declined",
          initiatedBy: transfer.initiatedBy,
          toUserId: transfer.toUserId,
        },
      });
      return declined;
    });
  }

  async cancel(id: string): Promise<OwnershipTransferData> {
    const identity = requireIdentity();
    const { orgId, userId } = identity;
    return this.runner.run(async (tx) => {
      const now = this.now();
      await this.members.lockOrg(tx, orgId);
      const transfer = await this.repository.findForUpdate(tx, orgId, id);
      if (transfer === undefined) throw new ApiError("not_found");
      // Settled first: a cancel that lost the race to an accept answers
      // 409 even though its caller is no longer an owner.
      if (transfer.status !== "pending" || isDue(transfer, now)) {
        throw new ApiError("request.conflict");
      }
      const caller = await this.members.findOrgOfUser(tx, orgId, userId);
      if (!isActiveOwner(caller)) throw new ApiError("forbidden");
      // An owner action: step up at acr other than mfa (not fresh).
      if (identity.acr !== MFA_ACR) {
        throw new ApiError("permission.step_up_required");
      }
      const cancelled = await this.repository.settle(
        tx,
        orgId,
        transfer.id,
        { status: "cancelled", by: userId },
        now,
      );
      await this.mfaCheck(tx, transfer.toUserId);
      await this.audit.record(tx, {
        action: `${OWNERSHIP_TRANSFER_SUBJECT}.cancel`,
        entityType: OWNERSHIP_TRANSFER_SUBJECT,
        entityId: transfer.id,
        before: { status: "pending" },
        after: {
          status: "cancelled",
          cause: "manual",
          initiatedBy: transfer.initiatedBy,
          toUserId: transfer.toUserId,
        },
      });
      return cancelled;
    });
  }
}
