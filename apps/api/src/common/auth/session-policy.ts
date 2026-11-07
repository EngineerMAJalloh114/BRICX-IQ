// The idle limit of a session (P5-03, ADR 0063; phase ruling D6, owner
// condition 7; P6-03, ADR 0073). The realm's ssoSessionIdleTimeout (12 h,
// realm-bricx.json, pinned by test/session-policy.test.ts) is the maximum:
// an organisation's value, stored by P6-03 in its region_configs org row
// (session_idle_seconds, 60..43 200 by CHECK and DTO), can only shorten
// it. OrgSessionPolicy hands the org's raw value back; clampIdleSeconds()
// decides: a positive integer at or below the realm's is kept, anything
// above is clamped to the realm's, and anything that is not a positive
// integer (no row, NULL) falls back to the realm's.
// Production binds DbOrgSessionPolicy: the value is read fresh on every
// tracked request, in its own withTx() as the request's user in the org
// (RLS), with no cache, so a change applies on the next request (D13,
// owner condition C2). realmSessionPolicy (every org the realm's) stays
// for tests.
import type { Database } from "@bricx/db/database";
import { readSessionIdleSeconds } from "@bricx/db/region-configs";
import { SESSION_IDLE_SECONDS } from "@bricx/domain/limits";

/** Keycloak's ssoSessionIdleTimeout for realm bricx, in seconds (12 h). */
export const REALM_IDLE_SECONDS = SESSION_IDLE_SECONDS.max;

export interface OrgSessionPolicy {
  /**
   * The org's idle limit in seconds, raw (unchecked); the tracker clamps
   * it. `userId` is the session's user: the read runs as them in the org.
   */
  idleSeconds(orgId: string, userId: string): Promise<unknown>;
}

export const ORG_SESSION_POLICY = Symbol("ORG_SESSION_POLICY");

/** The idle limit to enforce for an org value: never above the realm's. */
export function clampIdleSeconds(orgValue: unknown): number {
  if (
    typeof orgValue !== "number" ||
    !Number.isInteger(orgValue) ||
    orgValue <= 0
  ) {
    return REALM_IDLE_SECONDS;
  }
  return Math.min(orgValue, REALM_IDLE_SECONDS);
}

/** Every org gets the realm's limit (tests). */
export const realmSessionPolicy: OrgSessionPolicy = {
  idleSeconds: () => Promise.resolve(REALM_IDLE_SECONDS),
};

/** The org row's session_idle_seconds, read per request (production). */
export class DbOrgSessionPolicy implements OrgSessionPolicy {
  constructor(private readonly database: Database) {}

  idleSeconds(orgId: string, userId: string): Promise<unknown> {
    return this.database.withTx({ orgId, userId, projectIds: [] }, (tx) =>
      readSessionIdleSeconds(tx, orgId),
    );
  }
}

/**
 * Seconds between two last_seen_at writes of a session whose idle limit is
 * `idleSeconds` (P6-03, ADR 0073): the throttle
 * (USERS_LAST_SEEN_THROTTLE_SECONDS, default 300 s), but never more than a
 * tenth of the limit. last_seen_at lags the last request by less than
 * this, so an active user is never idled out by an org limit shorter than
 * the throttle; a session idles after between 90% and 100% of the limit
 * without requests. (for architect review)
 */
export function touchSeconds(
  throttleSeconds: number,
  idleSeconds: number,
): number {
  return Math.min(throttleSeconds, Math.floor(idleSeconds / 10));
}
