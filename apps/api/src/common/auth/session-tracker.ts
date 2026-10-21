// Session and device tracking (P5-03, ADR 0063; phase ruling D6, owner
// conditions 4 and 7). After the token is verified and the user
// provisioned, the guard calls track(): in one withTx() as the request's
// user and org,
// 1. the X-Device-Id, when present and the route does not register it,
//    must name a device of this user that is not revoked (the devices
//    own-row policy hides every other user's): device_unknown or
//    device_revoked otherwise, and no session row is written;
// 2. the session row for (org, keycloak sid) is inserted on first sight
//    (id: a UUIDv7 from the Clock; device: the one from step 1), or
//    reused: a revoked row is session_revoked; a row whose last_seen_at is
//    older than the org's idle limit (OrgSessionPolicy, clamped to the
//    realm's 12 h) is closed (revoked_at = now) and session_idle; a row of
//    another user is session_user_mismatch; a row bound to another device
//    than the header's is device_mismatch; a row without a device is bound
//    to the header's; last_seen_at moves at most once per throttle
//    (USERS_LAST_SEEN_THROTTLE_SECONDS), on the Clock.
// The reasons are logged by the guard as auth.failed and never sent.
// Neither the sid nor the token is logged. The unit suites bind a tracker
// without a database (test/support).
import type { Database } from "@bricx/db/database";
import {
  type UuidV7Generator,
  createUuidV7Generator,
} from "@bricx/ids/uuid-v7";
import { sql } from "drizzle-orm";
import type { Clock } from "../clock.js";
import { type OrgSessionPolicy, clampIdleSeconds } from "./session-policy.js";

export const SESSION_FAILURE_REASONS = Object.freeze([
  "device_unknown",
  "device_revoked",
  "device_mismatch",
  "session_revoked",
  "session_idle",
  "session_user_mismatch",
] as const);
export type SessionFailureReason = (typeof SESSION_FAILURE_REASONS)[number];

export class SessionFailure extends Error {
  constructor(readonly reason: SessionFailureReason) {
    super(`session failure: ${reason}`);
  }
}
Object.defineProperty(SessionFailure.prototype, "name", {
  value: "SessionFailure",
});

export interface SessionTrackInput {
  readonly userId: string;
  readonly orgId: string;
  /** The access token's sid claim (1-255 printable characters). */
  readonly keycloakSid: string;
  /** X-Device-Id, already one canonical UUID, or absent. */
  readonly deviceId: string | undefined;
  /** The route is @RegistersDevice(): the header names a device to create. */
  readonly registersDevice: boolean;
}

export interface TrackedSession {
  readonly sessionId: string;
  /** The verified device of this request (undefined without a header or on registration). */
  readonly deviceId: string | undefined;
  /** True when this call inserted the row. */
  readonly created: boolean;
}

export interface SessionTracker {
  track(input: SessionTrackInput): Promise<TrackedSession>;
}

export const SESSION_TRACKER = Symbol("SESSION_TRACKER");

type SessionRow = {
  readonly id: string;
  readonly user_id: string;
  readonly device_id: string | null;
  readonly revoked: boolean;
  /** last_seen_at as an ISO 8601 UTC string. */
  readonly last_seen_at: string;
};

export class DatabaseSessionTracker implements SessionTracker {
  private readonly ids: UuidV7Generator;

  constructor(
    private readonly database: Database,
    private readonly clock: Clock,
    private readonly policy: OrgSessionPolicy,
    private readonly throttleSeconds: number,
  ) {
    this.ids = createUuidV7Generator({ clock });
  }

  async track(input: SessionTrackInput): Promise<TrackedSession> {
    const { userId, orgId, keycloakSid } = input;
    const header = input.registersDevice ? undefined : input.deviceId;
    const nowMs = this.clock.now();
    const now = new Date(nowMs).toISOString();
    const idleSeconds = clampIdleSeconds(await this.policy.idleSeconds(orgId));
    const candidate = this.ids.next();
    // An idle session is closed (revoked_at set) and then refused: the
    // close must commit, so the failure is returned out of the transaction
    // and thrown after it, not from inside it.
    const outcome = await this.database.withTx(
      { orgId, userId, projectIds: [] },
      async (tx): Promise<TrackedSession | SessionFailure> => {
        if (header !== undefined) {
          const device = await tx.execute<{ revoked: boolean }>(
            sql`SELECT revoked_at IS NOT NULL AS revoked FROM bricx.devices WHERE id = ${header}::uuid`,
          );
          const found = device.rows[0];
          if (found === undefined) throw new SessionFailure("device_unknown");
          if (found.revoked) throw new SessionFailure("device_revoked");
        }
        const select = () =>
          tx.execute<SessionRow>(
            sql`SELECT id::text AS id, user_id::text AS user_id, device_id::text AS device_id,
                       revoked_at IS NOT NULL AS revoked,
                       to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS last_seen_at
                FROM bricx.sessions
                WHERE org_id = ${orgId}::uuid AND keycloak_sid = ${keycloakSid}`,
          );
        let row = (await select()).rows[0];
        if (row === undefined) {
          // First sight. Parallel first requests race on (org_id,
          // keycloak_sid): the loser inserts nothing and reads the
          // winner's row (the unique index is the arbiter, no 23505).
          const inserted = await tx.execute(
            sql`INSERT INTO bricx.sessions (id, org_id, user_id, device_id, keycloak_sid, created_at, last_seen_at)
                VALUES (${candidate}::uuid, ${orgId}::uuid, ${userId}::uuid, ${header ?? null}::uuid, ${keycloakSid}, ${now}::timestamptz, ${now}::timestamptz)
                ON CONFLICT (org_id, keycloak_sid) DO NOTHING`,
          );
          if (inserted.rowCount === 1) {
            return { sessionId: candidate, deviceId: header, created: true };
          }
          row = (await select()).rows[0];
          if (row === undefined)
            throw new Error("sessions: lost insert race and no row");
        }
        if (row.user_id !== userId) {
          throw new SessionFailure("session_user_mismatch");
        }
        if (row.revoked) throw new SessionFailure("session_revoked");
        const lastSeenMs = Date.parse(row.last_seen_at);
        if (nowMs - lastSeenMs > idleSeconds * 1000) {
          await tx.execute(
            sql`UPDATE bricx.sessions SET revoked_at = ${now}::timestamptz WHERE id = ${row.id}::uuid`,
          );
          return new SessionFailure("session_idle");
        }
        if (
          header !== undefined &&
          row.device_id !== null &&
          row.device_id !== header
        ) {
          throw new SessionFailure("device_mismatch");
        }
        const bind = header !== undefined && row.device_id === null;
        const touch = nowMs - lastSeenMs >= this.throttleSeconds * 1000;
        if (bind && touch) {
          await tx.execute(
            sql`UPDATE bricx.sessions SET device_id = ${header}::uuid, last_seen_at = ${now}::timestamptz WHERE id = ${row.id}::uuid`,
          );
        } else if (bind) {
          await tx.execute(
            sql`UPDATE bricx.sessions SET device_id = ${header}::uuid WHERE id = ${row.id}::uuid`,
          );
        } else if (touch) {
          await tx.execute(
            sql`UPDATE bricx.sessions SET last_seen_at = ${now}::timestamptz WHERE id = ${row.id}::uuid`,
          );
        }
        return { sessionId: row.id, deviceId: header, created: false };
      },
    );
    if (outcome instanceof SessionFailure) throw outcome;
    return outcome;
  }
}
