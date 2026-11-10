// Bounds checked before any loop, lookup or regex runs (P3-06 design
// constraint 5). Oversized input is rejected without reading it.
export const LIMITS = Object.freeze({
  /** States in one machine definition (final states are a subset). */
  machineStates: 64,
  /** Events in one machine definition. */
  machineEvents: 64,
  /** Transitions in one machine definition. */
  machineTransitions: 256,
  /** Named guards in one machine definition. */
  machineGuards: 32,
  /** Characters in a machine id, state, event or guard name, and in any name coming in. */
  nameLength: 64,
  /** Characters in a quantity decimal string. */
  quantityString: 40,
  /** Characters in a unit code coming in. */
  unitCode: 16,
  /** Integer digits of a quantity (999 999 999 999 is the largest magnitude). */
  integerDigits: 12,
  /** The largest scale (fraction digits) of a quantity. */
  maxScale: 9,
  /** Characters in a country code (ISO 3166-1 alpha-2). */
  countryCode: 2,
});

/**
 * An organisation's session idle limit, in seconds (P6-03, ADR 0073; P5
 * phase ruling D6). `max` is the Keycloak realm's ssoSessionIdleTimeout
 * (12 h, realm-bricx.json; apps/api's session-policy test pins the two
 * together): an org may only shorten it. `min` is one minute: below that a
 * session would expire between two ordinary requests of an active user.
 */
export const SESSION_IDLE_SECONDS = Object.freeze({
  min: 60,
  max: 43_200,
});

/**
 * An invitation's lifetime, in hours (P6-06, ADR 0077 D10; owner scope
 * 2026-11-10: "default expiry 72 h, configurable per org within a bounded
 * range"). An org may set 1 hour to 7 days on its org row.
 */
export const INVITATION_TTL_HOURS = Object.freeze({
  min: 1,
  default: 72,
  max: 168,
});
