// Sessions' outbox event (P5-03, ADR 0063; CLAUDE.md rule 5): one
// sessions.revoked row per closed session, written in the revoking
// transaction under the request's org, published by the worker's relay
// after COMMIT; P5-04 consumes it for immediate revocation. Ids and the
// Keycloak session id only, never names.
export const SESSIONS_REVOKED = "sessions.revoked";

export interface SessionRevoked {
  readonly sessionId: string;
  readonly userId: string;
  /** The org the session was signed into (not always the request's). */
  readonly orgId: string;
  readonly keycloakSid: string;
}
