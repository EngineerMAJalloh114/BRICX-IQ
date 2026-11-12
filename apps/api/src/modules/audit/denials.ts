// Refused authorisations around invitations, audited without flooding the
// chain (P6-06, ADR 0077, D17; owner condition C8). One
// org.invitation.denied event, in a transaction of its own (the refused
// request's transaction rolls back), for the FIRST refusal per (org,
// actor, reason) in each 15-minute bucket:
// - the reason is a closed enum (DENIED_REASONS); anything else is a
//   programming error, refused before any I/O;
// - the bucket is a Valkey key bricx:denied:<org>:<actor>:<reason>, set
//   with SET NX EX 900: the first caller in the window writes the event,
//   later refusals are one invitation.denied_repeat debug line;
// - Valkey down (or a timeout): no event, one invitation.denied_unrecorded
//   warn line (never a 500: the refusal stands either way);
// - the event's actor is the refused user, its subject the invitation (or
//   the membership) the refusal was about, `after` the reason only. Never
//   an address, a token or a key the caller asked for.
// Public bad-token attempts are never audited: logs and the rate limit.
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { PinoLogger } from "nestjs-pino";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ensureConnected } from "../../common/valkey.js";
import { AuditService } from "./audit.service.js";

export const DENIED_ACTION = "org.invitation.denied";
export const DENIED_SUBJECT = "org.invitation";

/** Why an authorisation was refused (C8: closed). */
export const DENIED_REASONS = Object.freeze([
  /** The invitation would grant a key the inviter does not hold. */
  "escalation",
  /** A member tried to change or assign their own role (C5). */
  "self_role_change",
  /** The inviter no longer holds what the invitation grants (at accept). */
  "inviter_lacks_rights",
  /** The inviter tried to accept their own invitation. */
  "self_invite",
  /** A member tried to suspend or reactivate their own membership (P6-06b). */
  "self_suspend",
  /** A member tried to renew their own temporary membership (P6-06b). */
  "self_renew",
] as const);
export type DeniedReason = (typeof DENIED_REASONS)[number];

/** The bucket's length in seconds (15 minutes). */
export const DENIED_BUCKET_SECONDS = 900;

export const DENIALS_VALKEY = Symbol("DENIALS_VALKEY");

export interface Denial {
  readonly orgId: string;
  readonly actorId: string;
  readonly reason: DeniedReason;
  /** The invitation, or the membership, the refusal was about. */
  readonly entityId: string;
  readonly entityType?: string;
}

const KNOWN: ReadonlySet<string> = new Set(DENIED_REASONS);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The Valkey key of a bucket (C8: org + actor + reason). */
export function deniedKey(
  orgId: string,
  actorId: string,
  reason: DeniedReason,
): string {
  return `bricx:denied:${orgId}:${actorId}:${reason}`;
}

@Injectable()
export class DenialRecorder {
  constructor(
    @Inject(DENIALS_VALKEY) private readonly valkey: Redis,
    @Inject(TxRunner) private readonly runner: Pick<TxRunner, "runAs">,
    @Inject(AuditService) private readonly audit: Pick<AuditService, "record">,
    @Inject(PinoLogger) private readonly logger: PinoLogger,
  ) {
    this.logger.setContext("invitations");
  }

  /** Records `denial` when it opens its bucket; never throws. */
  async record(denial: Denial): Promise<"recorded" | "repeat" | "unrecorded"> {
    const { orgId, actorId, reason } = denial;
    if (
      !KNOWN.has(reason) ||
      !UUID.test(orgId) ||
      !UUID.test(actorId) ||
      !UUID.test(denial.entityId)
    ) {
      throw new TypeError("denial: invalid input");
    }
    let first: boolean;
    try {
      await ensureConnected(this.valkey);
      const answer = await this.valkey.set(
        deniedKey(orgId, actorId, reason),
        "1",
        "EX",
        DENIED_BUCKET_SECONDS,
        "NX",
      );
      first = answer === "OK";
    } catch {
      this.logger.warn({ orgId, reason }, "invitation.denied_unrecorded");
      return "unrecorded";
    }
    if (!first) {
      this.logger.debug({ orgId, reason }, "invitation.denied_repeat");
      return "repeat";
    }
    try {
      await this.runner.runAs({ orgId, userId: actorId }, (tx) =>
        this.audit.record(tx, {
          action: DENIED_ACTION,
          entityType: denial.entityType ?? DENIED_SUBJECT,
          entityId: denial.entityId,
          after: { reason },
        }),
      );
    } catch {
      this.logger.warn({ orgId, reason }, "invitation.denied_unrecorded");
      return "unrecorded";
    }
    return "recorded";
  }
}
