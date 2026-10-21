// The Keycloak side of a revoke (P5-04, ADR 0065; plan decision 5, owner
// conditions 2 and 3): the worker ends the user's Keycloak session with
// the admin REST API as the realm's bricx-worker service account (ADR
// 0060: client credentials only, realm-management manage-users). The
// token is requested once at boot (the worker refuses to start without
// it) and again whenever it is about to expire; the service account has
// no refresh token, so the client's own refresh path is never used. A
// session Keycloak no longer holds (404) is already ended: the job is
// idempotent. Errors leave this module as they come from the client
// (a NetworkError carries the response) and are logged by the consumer as
// a status code only, never as a message: a message can carry the host.
import type { WorkerConfig } from "@bricx/config/worker";
import KcAdminClient from "@keycloak/keycloak-admin-client";

/** The admin client's base URL and realm name, from the realm's issuer. */
export function issuerParts(issuer: string): {
  readonly baseUrl: string;
  readonly realm: string;
} {
  const url = new URL(issuer);
  const found = /^(.*)\/realms\/([^/]+)\/?$/.exec(url.pathname);
  if (found?.[2] === undefined || found[1] === undefined) {
    throw new RangeError("the issuer does not name a realm");
  }
  return { baseUrl: `${url.origin}${found[1]}`, realm: found[2] };
}

export interface SessionEnder {
  /** Requests the service account's token unless the current one is valid. */
  ensureToken(): Promise<void>;
  /** Ends the Keycloak session `sid`; resolves when it is gone (or was). */
  endSession(sid: string): Promise<void>;
}

export function createKeycloakSessionEnder(
  keycloak: WorkerConfig["keycloak"],
): SessionEnder {
  const { baseUrl, realm } = issuerParts(keycloak.issuer);
  const client = new KcAdminClient({ baseUrl, realmName: realm });
  const ensureToken = async () => {
    if (client.accessToken !== undefined && !client.isTokenExpired()) return;
    await client.auth({
      grantType: "client_credentials",
      clientId: keycloak.workerClientId,
      clientSecret: keycloak.workerClientSecret.reveal(),
    });
  };
  return {
    ensureToken,
    async endSession(sid) {
      await ensureToken();
      await client.realms.deleteSession(
        { realm, session: sid, isOffline: false },
        { catchNotFound: true },
      );
    },
  };
}
