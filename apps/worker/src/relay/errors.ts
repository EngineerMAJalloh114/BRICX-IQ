// Publish failures the relay counts as the infrastructure's (P4-06,
// condition 1): Valkey unreachable, timing out, out of memory, loading or
// refusing writes. These leave the row untouched (attempts unchanged) and
// back the whole relay off. Anything else is the row's only if Valkey still
// answers a PING (relay.ts), so an outage never burns attempts.

/** The relay's own bound on one publish (commandTimeoutMs). */
export class PublishTimeoutError extends Error {
  constructor() {
    super("publish timed out");
  }
}
Object.defineProperty(PublishTimeoutError.prototype, "name", {
  value: "PublishTimeoutError",
});

const NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EPIPE",
]);

// ioredis' own messages for a connection that is down or slow.
const CONNECTION_MESSAGES = [
  "Connection is closed",
  "Command timed out",
  "Stream isn't writeable",
];

// Valkey replies that describe the server, not the command.
const SERVER_STATES =
  /^(OOM|LOADING|BUSY|MASTERDOWN|READONLY|NOAUTH|WRONGPASS|MISCONF|CLUSTERDOWN|TRYAGAIN)\b/;

/** True when `error` says Valkey is unreachable, slow or unwritable. */
export function isInfrastructureError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error instanceof PublishTimeoutError) return true;
  const code: unknown = Reflect.get(error, "code");
  if (typeof code === "string" && NETWORK_CODES.has(code)) return true;
  if (error.name === "MaxRetriesPerRequestError") return true;
  if (CONNECTION_MESSAGES.some((m) => error.message.startsWith(m))) {
    return true;
  }
  return error.name === "ReplyError" && SERVER_STATES.test(error.message);
}
