// Sessions' repository (P5-03, ADR 0063): every statement runs in the `tx`
// TxRunner hands over, as bricx_app. RLS on bricx.sessions is the org
// policy (org_id = app.current_org()) OR the own-row policy (user_id =
// app.current_user_id(), any org); the statements here always add the
// user_id (and, for an administrator, the org_id) so the ability check in
// the service is the only thing deciding whose rows are touched. A list
// (owner review fix 1) is the open rows only (revoked_at IS NULL), newest
// first (by id: UUIDv7, so creation order), at most SESSION_LIST_LIMIT.
import { type Tx } from "@bricx/db/database";
import { sessions } from "@bricx/db/schema";
import { Injectable } from "@nestjs/common";
import { and, desc, eq, isNull, sql } from "drizzle-orm";

/** Most rows a session list returns (owner review fix 1). */
export const SESSION_LIST_LIMIT = 100;

const iso = (column: typeof sessions.createdAt) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const isoOrNull = (column: typeof sessions.revokedAt) =>
  sql<
    string | null
  >`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const columns = {
  id: sessions.id,
  orgId: sessions.orgId,
  userId: sessions.userId,
  deviceId: sessions.deviceId,
  createdAt: iso(sessions.createdAt),
  lastSeenAt: iso(sessions.lastSeenAt),
  revokedAt: isoOrNull(sessions.revokedAt),
};
export type SessionRow = {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly deviceId: string | null;
  readonly createdAt: string;
  readonly lastSeenAt: string;
  readonly revokedAt: string | null;
};

/** What a revoke needs for its audit event and outbox rows. */
export type ClosedSession = {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly keycloakSid: string;
};
const closed = {
  id: sessions.id,
  orgId: sessions.orgId,
  userId: sessions.userId,
  keycloakSid: sessions.keycloakSid,
};

@Injectable()
export class SessionsRepository {
  /** `userId`'s open sessions in every org, newest first, at most the limit. */
  listOfUser(tx: Tx, userId: string): Promise<SessionRow[]> {
    return tx
      .select(columns)
      .from(sessions)
      .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
      .orderBy(desc(sessions.id))
      .limit(SESSION_LIST_LIMIT);
  }

  /** `userId`'s open sessions in `orgId` (the administrator's view), the same way. */
  listOfUserInOrg(
    tx: Tx,
    userId: string,
    orgId: string,
  ): Promise<SessionRow[]> {
    return tx
      .select(columns)
      .from(sessions)
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.orgId, orgId),
          isNull(sessions.revokedAt),
        ),
      )
      .orderBy(desc(sessions.id))
      .limit(SESSION_LIST_LIMIT);
  }

  /** Whether `userId` has a session `id` (any org, open or closed). */
  async exists(tx: Tx, userId: string, id: string): Promise<boolean> {
    const rows = await tx
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(eq(sessions.id, id), eq(sessions.userId, userId)));
    return rows.length > 0;
  }

  /** Closes `userId`'s open session `id` (any org). */
  closeOne(
    tx: Tx,
    userId: string,
    id: string,
    now: string,
  ): Promise<ClosedSession[]> {
    return tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(sessions.id, id),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning(closed);
  }

  /** Closes `userId`'s open sessions on `deviceId` (any org). */
  closeOnDevice(
    tx: Tx,
    userId: string,
    deviceId: string,
    now: string,
  ): Promise<ClosedSession[]> {
    return tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(sessions.deviceId, deviceId),
          eq(sessions.userId, userId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning(closed);
  }

  /** Closes `userId`'s open sessions in `orgId` (the administrator's revoke). */
  closeInOrg(
    tx: Tx,
    userId: string,
    orgId: string,
    now: string,
  ): Promise<ClosedSession[]> {
    return tx
      .update(sessions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(sessions.userId, userId),
          eq(sessions.orgId, orgId),
          isNull(sessions.revokedAt),
        ),
      )
      .returning(closed);
  }

  /** Binds the caller's open session `id` to `deviceId` when it has none. */
  async bindDevice(tx: Tx, id: string, deviceId: string): Promise<boolean> {
    const rows = await tx
      .update(sessions)
      .set({ deviceId })
      .where(and(eq(sessions.id, id), isNull(sessions.deviceId)))
      .returning({ id: sessions.id });
    return rows.length > 0;
  }
}
