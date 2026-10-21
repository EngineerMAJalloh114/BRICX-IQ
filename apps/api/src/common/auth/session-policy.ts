// The idle limit of a session (P5-03, ADR 0063; phase ruling D6, owner
// condition 7). The realm's ssoSessionIdleTimeout (12 h, realm-bricx.json,
// pinned by test/session-policy.test.ts) is the maximum: an organisation's
// value, stored by P6-03, can only shorten it. OrgSessionPolicy hands the
// org's raw value back; clampIdleSeconds() decides: a positive integer at
// or below the realm's is kept, anything above is clamped to the realm's,
// and anything that is not a positive integer falls back to the realm's.
// Production binds realmSessionPolicy until P6-03 stores org values.

/** Keycloak's ssoSessionIdleTimeout for realm bricx, in seconds (12 h). */
export const REALM_IDLE_SECONDS = 43_200;

export interface OrgSessionPolicy {
  /** The org's idle limit in seconds, raw (unchecked); the tracker clamps it. */
  idleSeconds(orgId: string): Promise<unknown>;
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

/** Every org gets the realm's limit (production until P6-03). */
export const realmSessionPolicy: OrgSessionPolicy = {
  idleSeconds: () => Promise.resolve(REALM_IDLE_SECONDS),
};
