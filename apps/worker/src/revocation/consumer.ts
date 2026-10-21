// The sessions.revoked consumer (P5-04, ADR 0065; plan decisions 4, 5, 8
// and 10; owner conditions 1 and 3). A BullMQ Worker on queue `sessions`
// takes the jobs the relay published from bricx.outbox and, per job:
// 1. checks the payload (registered keys only; a bad one is unrecoverable:
//    rejected, never retried);
// 2. SETs the org-scoped keys with the TTL, from the PAYLOAD's org (the
//    org the session was signed into; the row's org is the request's):
//      revoked:sid:<orgId>:<keycloakSid>   every cause
//      revoked:user:<orgId>:<userId>       an administrator's revoke
//    so the API's guard refuses the token from the next request on;
// 3. ends the Keycloak session (a 404 is already ended: idempotent);
// 4. logs revocation.applied, ids only.
// A failure throws: BullMQ retries with the topic's delivery options
// (40 attempts, 1 s doubling, capped at 60 s: the "outbox" backoff the
// relay set), and every retry re-sets the keys first. The last failure
// logs revocation.keycloak_failed (session id, attempts, HTTP status;
// P13-05 alerts on it). Nothing here logs a sid, a value or a message.
import {
  type OutboxDelivery,
  deliveryBackoffMs,
  outboxTopic,
} from "@bricx/db/outbox";
import { UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import type { RelayLogger } from "../relay/relay.js";
import type { SessionEnder } from "./keycloak.js";

export const SESSIONS_QUEUE = "sessions";
export const SESSIONS_REVOKED = "sessions.revoked";

/** The registered sessions.revoked payload (packages/db/outbox.ts). */
export interface RevocationPayload {
  readonly sessionId: string;
  readonly userId: string;
  readonly orgId: string;
  readonly keycloakSid: string;
  readonly cause: "self" | "device" | "admin";
}

const PAYLOAD_KEYS = [
  "sessionId",
  "userId",
  "orgId",
  "keycloakSid",
  "cause",
] as const;

/** What the consumer reads of a BullMQ job (a Job satisfies it). */
export interface RevocationJob {
  readonly name: string;
  /** The relay's OutboxJobData, as far as this consumer trusts it. */
  readonly data?: unknown;
  /** Attempts so far: 0 on the first run; BullMQ counts the failed one. */
  readonly attemptsMade: number;
  readonly opts: {
    readonly attempts?: number;
    readonly backoff?:
      number | { readonly type?: string; readonly delay?: number } | undefined;
  };
}

export interface RevocationKeys {
  /** SET `key` with a TTL of `ttlSeconds`; rejects when Valkey does. */
  set(key: string, ttlSeconds: number): Promise<void>;
}

export interface RevocationDeps {
  readonly keys: RevocationKeys;
  readonly keycloak: Pick<SessionEnder, "endSession">;
  readonly logger: RelayLogger;
  readonly ttlSeconds: number;
}

const field = (data: unknown, name: string): string | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  const value: unknown = Reflect.get(data, name);
  return typeof value === "string" ? value : undefined;
};

/** The job's outbox id (undefined when the data is not the relay's). */
const outboxIdOf = (job: RevocationJob | undefined): string | undefined =>
  field(job?.data, "outboxId");

/** The job's session id, read without trusting the rest of the payload. */
const sessionIdOf = (job: RevocationJob | undefined): string | undefined =>
  typeof job?.data === "object" && job.data !== null
    ? field(Reflect.get(job.data, "payload"), "sessionId")
    : undefined;

/** The org-scoped keys a revoke sets: the sid key, plus the user key for admin. */
export function revocationKeyNames(payload: RevocationPayload): string[] {
  const names = [`revoked:sid:${payload.orgId}:${payload.keycloakSid}`];
  if (payload.cause === "admin") {
    names.push(`revoked:user:${payload.orgId}:${payload.userId}`);
  }
  return names;
}

/**
 * The job's payload, checked: exactly the registered keys, all strings,
 * a known cause. Anything else is an UnrecoverableError (no retry, no
 * value in the message).
 */
export function parseRevocation(job: RevocationJob): RevocationPayload {
  const reject = () =>
    new UnrecoverableError(`invalid ${SESSIONS_REVOKED} job`);
  if (job.name !== SESSIONS_REVOKED) throw reject();
  if (typeof job.data !== "object" || job.data === null) throw reject();
  const payload: unknown = Reflect.get(job.data, "payload");
  if (typeof payload !== "object" || payload === null) throw reject();
  if (Object.keys(payload).length !== PAYLOAD_KEYS.length) throw reject();
  const [sessionId, userId, orgId, keycloakSid, cause] = PAYLOAD_KEYS.map(
    (key) => field(payload, key),
  );
  if (
    sessionId === undefined ||
    userId === undefined ||
    orgId === undefined ||
    keycloakSid === undefined
  ) {
    throw reject();
  }
  // Why a session was closed (apps/api sessions.events.ts, ADR 0063).
  if (cause !== "self" && cause !== "device" && cause !== "admin") {
    throw reject();
  }
  return { sessionId, userId, orgId, keycloakSid, cause };
}

/** One job: keys first (every attempt), then Keycloak, then one log line. */
export async function processRevocation(
  job: RevocationJob,
  deps: RevocationDeps,
): Promise<void> {
  const payload = parseRevocation(job);
  for (const key of revocationKeyNames(payload)) {
    await deps.keys.set(key, deps.ttlSeconds);
  }
  await deps.keycloak.endSession(payload.keycloakSid);
  deps.logger.info(
    {
      outboxId: outboxIdOf(job),
      sessionId: payload.sessionId,
      userId: payload.userId,
      orgId: payload.orgId,
      cause: payload.cause,
      attempt: job.attemptsMade + 1,
    },
    "revocation.applied",
  );
}

/** The HTTP status an admin-client NetworkError carries, if any. */
function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const response: unknown = Reflect.get(error, "response");
  if (typeof response !== "object" || response === null) return undefined;
  const status: unknown = Reflect.get(response, "status");
  return typeof status === "number" ? status : undefined;
}

/**
 * BullMQ's `failed` event: a retry is a debug line, the last failure one
 * revocation.keycloak_failed at error, a rejected payload one
 * revocation.rejected. Ids, counts and the HTTP status only.
 */
export function onRevocationFailed(
  job: RevocationJob | undefined,
  error: unknown,
  logger: RelayLogger,
): void {
  const outboxId = outboxIdOf(job);
  if (error instanceof UnrecoverableError) {
    logger.error({ outboxId }, "revocation.rejected");
    return;
  }
  const sessionId = sessionIdOf(job);
  const status = statusOf(error);
  const attemptsMade = job?.attemptsMade;
  const allowed = job?.opts.attempts ?? 1;
  if (attemptsMade !== undefined && attemptsMade < allowed) {
    logger.debug(
      { outboxId, sessionId, attempt: attemptsMade, status },
      "revocation.retry",
    );
    return;
  }
  logger.error(
    { outboxId, sessionId, attempts: attemptsMade, status },
    "revocation.keycloak_failed",
  );
}

/** A job's backoff delay from its option, when it is a plain delay. */
const optionDelay = (job: RevocationJob | undefined): number => {
  const backoff = job?.opts.backoff;
  if (typeof backoff === "number") return backoff;
  return backoff?.delay ?? 1_000;
};

/**
 * BullMQ's custom backoff strategy: the "outbox" type (set by the relay)
 * resolves the job's topic's delivery options; any other type keeps the
 * job's own delay.
 */
export function outboxBackoff(
  attemptsMade: number,
  type?: string,
  _error?: unknown,
  job?: RevocationJob,
): number {
  if (type !== "outbox" || job === undefined) return optionDelay(job);
  let delivery: OutboxDelivery | undefined;
  try {
    delivery = outboxTopic(field(job.data, "topic") ?? "").delivery;
  } catch {
    delivery = undefined;
  }
  return delivery === undefined
    ? optionDelay(job)
    : deliveryBackoffMs(delivery, attemptsMade);
}

export interface RevocationConsumerOptions {
  /** A dedicated connection (BullMQ blocks on it): maxRetriesPerRequest null. */
  readonly connection: Redis;
  readonly deps: RevocationDeps;
}

export interface RevocationConsumer {
  /** Stops taking jobs, waits for the one in flight, closes the Worker. */
  close(): Promise<void>;
}

/** A running BullMQ Worker on queue `sessions`, processing sessions.revoked. */
export function createRevocationConsumer(
  options: RevocationConsumerOptions,
): RevocationConsumer {
  const { connection, deps } = options;
  const worker = new Worker(
    SESSIONS_QUEUE,
    (job) => processRevocation(job, deps),
    {
      connection,
      concurrency: 1,
      settings: {
        backoffStrategy: (attemptsMade, type, error, job) =>
          outboxBackoff(attemptsMade, type, error, job),
      },
    },
  );
  worker.on("failed", (job, error) => {
    onRevocationFailed(job, error, deps.logger);
  });
  // A connection error surfaces as failed or stalled jobs; the message can
  // carry the host, so only the event is logged.
  worker.on("error", () => {
    deps.logger.warn({}, "revocation.consumer_error");
  });
  return {
    close: () => worker.close(),
  };
}
