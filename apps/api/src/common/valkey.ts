// The API's one Valkey client (P6-05d, ADR 0080; owner condition C5):
// createApp opens it and AppModule closes it on shutdown; the revocation
// store (P5-04, ADR 0065) and the rate limiter share it. Its options are
// the revocation store's since P5-04, unchanged: lazy (connects on the
// first command), no offline queue and no retries per request (a command
// while Valkey is unreachable fails at once), 500 ms to connect and per
// command. Nothing here logs: driver messages can carry the host.
import { Redis } from "ioredis";

/** Bound on connecting and on each command, in ms (ADR 0065). */
export const VALKEY_TIMEOUT_MS = 500;

/** A secret connection string (@bricx/config's Secret satisfies it). */
export interface SecretUrl {
  reveal(): string;
}

export const VALKEY_CLIENT = Symbol("VALKEY_CLIENT");

/** A new lazy client on `url`, with the bounded options above. */
export function openValkey(url: SecretUrl): Redis {
  const client = new Redis(url.reveal(), {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    commandTimeout: VALKEY_TIMEOUT_MS,
    connectTimeout: VALKEY_TIMEOUT_MS,
    retryStrategy: (times: number) => Math.min(times * 100, 1_000),
  });
  // Connection errors surface on the commands that fail; an "error" event
  // without a listener would crash the process.
  client.on("error", () => undefined);
  return client;
}

const connecting = new WeakMap<Redis, Promise<void>>();

/**
 * Connects a lazy client on first use. Two callers sharing the client
 * during that first connect wait for the same attempt (a second
 * connect() call would reject); after it, ioredis reconnects by itself.
 */
export async function ensureConnected(client: Redis): Promise<void> {
  const pending = connecting.get(client);
  if (pending !== undefined) return pending;
  if (client.status !== "wait") return;
  const attempt = client.connect().finally(() => {
    connecting.delete(client);
  });
  connecting.set(client, attempt);
  return attempt;
}

/** Closes the shared client when the app shuts down. */
export class ValkeyConnection {
  constructor(readonly client: Redis) {}

  onApplicationShutdown(): void {
    this.client.disconnect();
  }
}
