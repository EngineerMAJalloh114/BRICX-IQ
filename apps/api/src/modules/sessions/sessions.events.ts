// Sessions' outbox events (P5-03, ADR 0063; P5-04, ADR 0065; CLAUDE.md
// rule 5), written in the revoking transaction under the request's org and
// published by the worker's relay after COMMIT. Ids and the Keycloak
// session id only, never names.
// - sessions.revoked, one per closed session: the worker's revocation
//   consumer writes the Valkey keys and ends the Keycloak session. `cause`
//   decides the keys (an admin revoke also bars the user, ADR 0065).
// - sync.revoke, one per closed session: for the sync service (P8-02).
export const SESSIONS_REVOKED = "sessions.revoked";
export const SYNC_REVOKE = "sync.revoke";

/** Why sessions were closed: by the user, with a device, or by an administrator. */
export type SessionRevokeCause = "self" | "device" | "admin";

export interface SessionRevoked {
  readonly sessionId: string;
  readonly userId: string;
  /** The org the session was signed into (not always the request's). */
  readonly orgId: string;
  readonly keycloakSid: string;
  readonly cause: SessionRevokeCause;
}

export interface SyncRevoke {
  readonly sessionId: string;
  readonly userId: string;
  /** The org the session was signed into. */
  readonly orgId: string;
}
