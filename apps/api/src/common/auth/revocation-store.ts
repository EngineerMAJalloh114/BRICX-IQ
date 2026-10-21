// The revocation keys in Valkey (P5-04, ADR 0065; plan decision 6, owner
// condition 1), written by the worker's sessions.revoked consumer and read
// by the guard on every authenticated request, after the user is
// provisioned and before the sessions row is touched:
//   revoked:sid:<orgId>:<keycloakSid>   every closed session
//   revoked:user:<orgId>:<userId>       an administrator's revoke-by-user
// One MGET per check, bounded at 500 ms, on a lazy client with no offline
// queue and no retries: Valkey unreachable is RevocationUnavailable, which
// the guard answers with 503 (fail closed: a cache outage must not become
// a bypass for a still-valid token of a revoked user). Nothing here logs,
// and no error message carries a key, a host or a value. The API never
// writes these keys (CLAUDE.md rule 5: the revoke goes through the outbox).
import { Redis } from "ioredis";

export const REVOCATION_REASONS = Object.freeze([
  "revoked_sid",
  "revoked_user",
] as const);
export type RevocationReason = (typeof REVOCATION_REASONS)[number];

/** Bound on connecting and on the one command of a check, in ms. */
export const REVOCATION_TIMEOUT_MS = 500;

export interface RevocationCheck {
  readonly orgId: string;
  readonly userId: string;
  /** The access token's sid claim. */
  readonly keycloakSid: string;
}

export interface RevocationStore {
  /** The reason the session is revoked, or undefined when neither key exists. */
  check(input: RevocationCheck): Promise<RevocationReason | undefined>;
}

export const REVOCATION_STORE = Symbol("REVOCATION_STORE");

export class RevocationUnavailable extends Error {
  constructor() {
    super("revocation store unavailable");
  }
}
Object.defineProperty(RevocationUnavailable.prototype, "name", {
  value: "RevocationUnavailable",
});

/** The two org-scoped keys of a check (the worker writes the same names). */
export function revocationKeys(input: RevocationCheck): {
  readonly sid: string;
  readonly user: string;
} {
  return {
    sid: `revoked:sid:${input.orgId}:${input.keycloakSid}`,
    user: `revoked:user:${input.orgId}:${input.userId}`,
  };
}

/** A secret connection string (@bricx/config's Secret satisfies it). */
export interface SecretUrl {
  reveal(): string;
}

export class ValkeyRevocationStore implements RevocationStore {
  private readonly client: Redis;

  constructor(url: SecretUrl) {
    this.client = new Redis(url.reveal(), {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      commandTimeout: REVOCATION_TIMEOUT_MS,
      connectTimeout: REVOCATION_TIMEOUT_MS,
      retryStrategy: (times: number) => Math.min(times * 100, 1_000),
    });
    // Connection errors surface on the checks that fail; an "error" event
    // without a listener would crash the process. Nothing is logged here:
    // driver messages can carry the host.
    this.client.on("error", () => undefined);
  }

  async check(input: RevocationCheck): Promise<RevocationReason | undefined> {
    const keys = revocationKeys(input);
    let values: (string | null)[];
    try {
      if (this.client.status === "wait") await this.client.connect();
      values = await this.client.mget(keys.sid, keys.user);
    } catch {
      throw new RevocationUnavailable();
    }
    if (values[0] !== null && values[0] !== undefined) return "revoked_sid";
    if (values[1] !== null && values[1] !== undefined) return "revoked_user";
    return undefined;
  }

  /** Releases the connection (Nest's shutdown hook calls it). */
  close(): Promise<void> {
    this.client.disconnect();
    return Promise.resolve();
  }

  onModuleDestroy(): Promise<void> {
    return this.close();
  }
}
