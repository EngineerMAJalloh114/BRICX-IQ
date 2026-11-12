// The member activity read (P6-06b, ADR 0084; owner answer Q7, addition
// A4): the audit events of ONE user inside ONE organisation, newest
// first, as a fixed projection. Every statement runs in the caller's
// transaction as bricx_app under RLS (org_id = app.current_org()) and
// adds the org id itself, so a user who is a member of two organisations
// never crosses: the match is
//   org_id = <org> AND (actor_id = <user>
//     OR (entity_type = 'org.member' AND entity_id IN <the user's org membership ids there>)
//     OR (entity_type = 'project.member' AND entity_id IN <their project membership ids there>))
// read as three index scans (audit_events_by_actor, audit_events_by_entity;
// 0014) and merged here by seq. The columns read are the projection's
// only: never before/after, the address, the device or the location.
import type { Tx } from "@bricx/db/database";
import { auditEvents } from "@bricx/db/schema";
import { Injectable } from "@nestjs/common";
import { type SQL, and, eq, inArray, lt, sql } from "drizzle-orm";

/** The subjects whose events are "done to" a member. */
export const ACTIVITY_ORG_MEMBER = "org.member";
export const ACTIVITY_PROJECT_MEMBER = "project.member";
/** Most rows one read may ask for (a page of 100 and one more). */
export const ACTIVITY_READ_MAX = 101;

export interface ActivitySubject {
  readonly orgId: string;
  readonly userId: string;
  /** The user's membership ids in that org (open or not). */
  readonly orgMembershipIds: readonly string[];
  readonly projectMembershipIds: readonly string[];
}

export interface ActivityPage {
  /** Only events with a smaller seq. */
  readonly before?: bigint | undefined;
  /** 1..ACTIVITY_READ_MAX. */
  readonly limit: number;
}

/** The projection: what an activity reader may learn of an event. */
export interface ActivityRow {
  readonly seq: bigint;
  readonly occurredAt: string;
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly correlationId: string;
}

const projection = {
  seq: auditEvents.seq,
  occurredAt: sql<string>`to_char(${auditEvents.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`,
  action: auditEvents.action,
  entityType: auditEvents.entityType,
  entityId: auditEvents.entityId,
  actorType: auditEvents.actorType,
  actorId: auditEvents.actorId,
  correlationId: auditEvents.correlationId,
};

@Injectable()
export class AuditActivityReader {
  /**
   * Up to `limit` events of `subject`, newest first (seq descending),
   * each once.
   */
  async list(
    tx: Tx,
    subject: ActivitySubject,
    page: ActivityPage,
  ): Promise<ActivityRow[]> {
    if (
      !Number.isSafeInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > ACTIVITY_READ_MAX
    ) {
      throw new RangeError("activity limit: out of range");
    }
    const branch = (match: SQL | undefined): Promise<ActivityRow[]> =>
      tx
        .select(projection)
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.orgId, subject.orgId),
            match,
            page.before === undefined
              ? undefined
              : lt(auditEvents.seq, page.before),
          ),
        )
        .orderBy(sql`${auditEvents.seq} DESC NULLS LAST`)
        .limit(page.limit);
    const found = await branch(eq(auditEvents.actorId, subject.userId));
    if (subject.orgMembershipIds.length > 0) {
      found.push(
        ...(await branch(
          and(
            eq(auditEvents.entityType, ACTIVITY_ORG_MEMBER),
            inArray(auditEvents.entityId, [...subject.orgMembershipIds]),
          ),
        )),
      );
    }
    if (subject.projectMembershipIds.length > 0) {
      found.push(
        ...(await branch(
          and(
            eq(auditEvents.entityType, ACTIVITY_PROJECT_MEMBER),
            inArray(auditEvents.entityId, [...subject.projectMembershipIds]),
          ),
        )),
      );
    }
    const bySeq = new Map<bigint, ActivityRow>();
    for (const row of found) bySeq.set(row.seq, row);
    return [...bySeq.values()]
      .sort((a, b) => (a.seq < b.seq ? 1 : a.seq > b.seq ? -1 : 0))
      .slice(0, page.limit);
  }
}
