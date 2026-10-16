// The worker's Valkey connection (P4-06, ADR 0056). Commands are bounded
// (commandTimeoutMs, default 5 s) and never queued while disconnected, so a
// Valkey outage fails fast and the relay backs off (condition 1).
import { Redis } from "ioredis";

/** A secret connection string (@bricx/config's Secret satisfies it). */
export interface SecretUrl {
  reveal(): string;
}

export interface ValkeyOptions {
  /** Bound on connecting and on each command, in ms (default 5 s). */
  readonly commandTimeoutMs?: number;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 5_000;

/** A lazy client: it connects on connect() or on its first command. */
export function openValkey(url: SecretUrl, options: ValkeyOptions = {}): Redis {
  const timeout = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const client = new Redis(url.reveal(), {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    commandTimeout: timeout,
    connectTimeout: timeout,
    retryStrategy: (times: number) => Math.min(times * 200, 2_000),
  });
  // Connection errors surface on the commands that fail; an "error" event
  // without a listener would crash the process. Nothing is logged here:
  // driver messages can carry the host.
  client.on("error", () => undefined);
  return client;
}

/** Valkey's maxmemory-policy (CONFIG GET), or undefined if not reported. */
export async function evictionPolicy(
  client: Redis,
): Promise<string | undefined> {
  const reply: unknown = await client.config("GET", "maxmemory-policy");
  if (!Array.isArray(reply)) return undefined;
  const value: unknown = reply[1];
  return typeof value === "string" ? value : undefined;
}
