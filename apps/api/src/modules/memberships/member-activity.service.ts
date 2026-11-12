// A member's activity history (P6-06b, ADR 0084; owner answer Q7,
// additions A3 and A4): GET /v1/members/:id/activity, org.audit.read at
// org scope (checked here before any database work; the route carries
// @Can too). The membership names the user: any membership of the org,
// removed or not (404 otherwise, also for another org's id, which RLS
// hides). The events are the ones the audit module's reader matches for
// that user inside this org; the answer is its fixed projection plus
// byMember (the member was the actor), paginated by seq, newest first.
import { can } from "@bricx/permissions/ability";
import { Inject, Injectable } from "@nestjs/common";
import { abilityFor } from "../../common/auth/ability.js";
import { TxRunner } from "../../common/db/tx-runner.js";
import { ApiError } from "../../common/errors/api-error.js";
import { AuditActivityReader } from "../audit/public-api.js";
import {
  type TransactionRunner,
  requireIdentity,
} from "../sessions/public-api.js";
import {
  ACTIVITY_DEFAULT_LIMIT,
  type ActivityItem,
} from "./memberships.dto.js";
import { MembershipsRepository } from "./memberships.repository.js";

/** The audit subject the read is checked against. */
const AUDIT_SUBJECT = "org.audit";
/** Most membership ids of one user matched per kind (newest first). */
export const ACTIVITY_MEMBERSHIPS_MAX = 50;

export interface ActivityAnswer {
  readonly items: ActivityItem[];
  readonly nextCursor: string | null;
}

export type MemberActivityPort = Pick<MemberActivityService, "list">;
export type ActivityReader = Pick<AuditActivityReader, "list">;
export type ActivityMemberships = Pick<
  MembershipsRepository,
  "findOrgAny" | "membershipIdsOf"
>;

@Injectable()
export class MemberActivityService {
  constructor(
    @Inject(TxRunner) private readonly runner: TransactionRunner,
    @Inject(MembershipsRepository)
    private readonly repository: ActivityMemberships,
    @Inject(AuditActivityReader) private readonly reader: ActivityReader,
  ) {}

  list(
    id: string,
    query: {
      readonly cursor?: string | undefined;
      readonly limit?: number | undefined;
    },
  ): Promise<ActivityAnswer> {
    const identity = requireIdentity();
    if (
      !can(abilityFor(identity), "read", AUDIT_SUBJECT, {
        orgId: identity.orgId,
      })
    ) {
      throw new ApiError("forbidden");
    }
    const limit = query.limit ?? ACTIVITY_DEFAULT_LIMIT;
    return this.runner.run(async (tx) => {
      const member = await this.repository.findOrgAny(tx, identity.orgId, id);
      if (member === undefined) throw new ApiError("not_found");
      const ids = await this.repository.membershipIdsOf(
        tx,
        identity.orgId,
        member.userId,
        ACTIVITY_MEMBERSHIPS_MAX,
      );
      // One more than asked: whether a next page exists.
      const rows = await this.reader.list(
        tx,
        {
          orgId: identity.orgId,
          userId: member.userId,
          orgMembershipIds: ids.org,
          projectMembershipIds: ids.project,
        },
        {
          before: query.cursor === undefined ? undefined : BigInt(query.cursor),
          limit: limit + 1,
        },
      );
      const page = rows.slice(0, limit);
      const last = page.at(-1);
      return {
        items: page.map((row) => ({
          seq: row.seq.toString(),
          occurredAt: row.occurredAt,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          actorType: row.actorType === "user" ? "user" : "system",
          byMember: row.actorId === member.userId,
          correlationId: row.correlationId,
        })),
        nextCursor:
          rows.length > limit && last !== undefined
            ? last.seq.toString()
            : null,
      };
    });
  }
}
