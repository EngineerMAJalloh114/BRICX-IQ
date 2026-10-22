// Access grants' repository (P5-06, ADR 0067): every statement runs in the
// `tx` TxRunner hands over, as bricx_app under RLS (org_id =
// app.current_org() on access_grants, plus the own-row SELECT policy for
// the caller's rows in any org); the statements add the org id too, so
// the policy check in the service is the only thing deciding whose rows
// are touched. A list is the open rows (not revoked, not ended at the
// instant given), newest first (by id: UUIDv7), at most
// GRANT_LIST_LIMIT. The cap (D-C): countOpen() takes a transaction-scoped
// advisory lock on the org and user, so a concurrent grant waits and sees
// this one's row. A foreign key violation on insert (the user) is
// ApiError("not_found"), here and only here. Instants are ISO 8601 UTC
// with milliseconds, in and out.
import { type Tx, sqlstateOf } from "@bricx/db/database";
import { accessGrants } from "@bricx/db/schema";
import { Injectable } from "@nestjs/common";
import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors/api-error.js";
import { GRANT_LIST_LIMIT } from "./access-grants.dto.js";

const FOREIGN_KEY_VIOLATION = "23503";
/** The advisory lock namespace the per-user cap is counted under ("ACCG"). */
export const ACCESS_GRANTS_LOCK_NAMESPACE = 0x41_43_43_47;

type Timestamp =
  | typeof accessGrants.startsAt
  | typeof accessGrants.expiresAt
  | typeof accessGrants.createdAt;
type NullableTimestamp =
  typeof accessGrants.revokedAt | typeof accessGrants.expiredAt;

const iso = (column: Timestamp) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const isoOrNull = (column: NullableTimestamp) =>
  sql<
    string | null
  >`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** An access_grants row. */
export interface AccessGrantRow {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly permission: string;
  readonly scopeId: string | null;
  readonly reason: string;
  readonly grantedBy: string;
  readonly startsAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly expiredAt: string | null;
  readonly createdAt: string;
}

export interface NewAccessGrant {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly permission: string;
  readonly scopeId: string | null;
  readonly reason: string;
  readonly grantedBy: string;
  readonly startsAt: string;
  readonly expiresAt: string;
  readonly now: string;
}

const columns = {
  id: accessGrants.id,
  orgId: accessGrants.orgId,
  userId: accessGrants.userId,
  permission: accessGrants.permission,
  scopeId: accessGrants.scopeId,
  reason: accessGrants.reason,
  grantedBy: accessGrants.grantedBy,
  startsAt: iso(accessGrants.startsAt),
  expiresAt: iso(accessGrants.expiresAt),
  revokedAt: isoOrNull(accessGrants.revokedAt),
  revokedBy: accessGrants.revokedBy,
  expiredAt: isoOrNull(accessGrants.expiredAt),
  createdAt: iso(accessGrants.createdAt),
};

/** Not revoked and not ended at `at` (the worker's expired_at is a record, not the rule). */
const openAt = (at: string) =>
  and(isNull(accessGrants.revokedAt), gt(accessGrants.expiresAt, at));

function refuse(error: unknown): never {
  if (sqlstateOf(error) === FOREIGN_KEY_VIOLATION) {
    throw new ApiError("not_found");
  }
  throw error;
}

@Injectable()
export class AccessGrantsRepository {
  /** Inserts one row; a foreign key violation (the user) is ApiError("not_found"). */
  async insert(tx: Tx, input: NewAccessGrant): Promise<AccessGrantRow> {
    let rows: AccessGrantRow[];
    try {
      rows = await tx
        .insert(accessGrants)
        .values({
          id: input.id,
          orgId: input.orgId,
          userId: input.userId,
          permission: input.permission,
          scopeId: input.scopeId,
          reason: input.reason,
          grantedBy: input.grantedBy,
          startsAt: input.startsAt,
          expiresAt: input.expiresAt,
          createdAt: input.now,
        })
        .returning(columns);
    } catch (error) {
      refuse(error);
    }
    const [row] = rows;
    if (row === undefined) throw new Error("insert returned no row");
    return row;
  }

  /** The org's row `id`, whatever its state; undefined when none (or hidden). */
  async find(
    tx: Tx,
    orgId: string,
    id: string,
  ): Promise<AccessGrantRow | undefined> {
    const rows = await tx
      .select(columns)
      .from(accessGrants)
      .where(and(eq(accessGrants.orgId, orgId), eq(accessGrants.id, id)));
    return rows[0];
  }

  /** The org's open rows at `at`, newest first, at most the limit; one user's when given. */
  async list(
    tx: Tx,
    orgId: string,
    at: string,
    userId?: string,
  ): Promise<AccessGrantRow[]> {
    return tx
      .select(columns)
      .from(accessGrants)
      .where(
        and(
          eq(accessGrants.orgId, orgId),
          userId === undefined ? undefined : eq(accessGrants.userId, userId),
          openAt(at),
        ),
      )
      .orderBy(desc(accessGrants.id))
      .limit(GRANT_LIST_LIMIT);
  }

  /** The caller's own rows active at `at` (started, open) in the org, newest first. */
  async listMine(
    tx: Tx,
    orgId: string,
    userId: string,
    at: string,
  ): Promise<AccessGrantRow[]> {
    return tx
      .select(columns)
      .from(accessGrants)
      .where(
        and(
          eq(accessGrants.orgId, orgId),
          eq(accessGrants.userId, userId),
          lte(accessGrants.startsAt, at),
          openAt(at),
        ),
      )
      .orderBy(desc(accessGrants.id))
      .limit(GRANT_LIST_LIMIT);
  }

  /**
   * How many open grants (at `at`) `userId` holds in the org, after taking
   * the org's and user's advisory lock for the rest of the transaction.
   */
  async countOpen(
    tx: Tx,
    orgId: string,
    userId: string,
    at: string,
  ): Promise<number> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ACCESS_GRANTS_LOCK_NAMESPACE}::integer, hashtext(${`${orgId}:${userId}`}))`,
    );
    const [row] = await tx
      .select({ open: sql<number>`count(*)::int` })
      .from(accessGrants)
      .where(
        and(
          eq(accessGrants.orgId, orgId),
          eq(accessGrants.userId, userId),
          openAt(at),
        ),
      );
    return row?.open ?? 0;
  }

  /** Sets revoked_at/revoked_by on the org's open row `id`; undefined when it is not open. */
  async revoke(
    tx: Tx,
    orgId: string,
    id: string,
    by: string,
    now: string,
  ): Promise<AccessGrantRow | undefined> {
    const rows = await tx
      .update(accessGrants)
      .set({ revokedAt: now, revokedBy: by })
      .where(
        and(
          eq(accessGrants.orgId, orgId),
          eq(accessGrants.id, id),
          isNull(accessGrants.revokedAt),
          isNull(accessGrants.expiredAt),
        ),
      )
      .returning(columns);
    return rows[0];
  }
}
