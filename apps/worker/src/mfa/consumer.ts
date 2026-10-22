// The users.mfa_check consumer (P5-05, phase ruling D5, ADR 0066; plan
// 4.2 and 4.4, decision D-G). A BullMQ Worker on queue `users` takes the
// jobs the relay published from bricx.outbox and, per job:
// 1. checks the payload (the one registered key, a UUID; a bad one is
//    unrecoverable: rejected, never retried);
// 2. reads the TRUTH, not the payload: app.mfa_state(userId) through the
//    relay's transaction (mfa/truth.ts), so a retry of an old job after a
//    newer one applies the current state (convergent, order-free);
// 3. maps the realm role bricx-mfa with the admin client as bricx-worker
//    (revocation/keycloak.ts ensureRealmRole: set or clear, nothing when
//    already right);
// 4. logs mfa.applied, ids only (userId, required, changed, attempt).
// A user the database or Keycloak no longer knows logs mfa.user_missing
// and completes. A failure throws: BullMQ retries with the topic's
// delivery options (40 attempts, 1 s doubling, capped at 60 s: the
// "outbox" backoff the relay set). The last failure logs
// mfa.keycloak_failed (user id, attempts, HTTP status; P13-05 alerts on
// it; a database failure exhausts into the same line, status undefined).
// Nothing here logs a Keycloak subject, a value or a message.
import type { MfaState } from "@bricx/db/mfa";
import { UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  type OutboxJob,
  field,
  outboxBackoff,
  outboxIdOf,
  payloadField,
  statusOf,
} from "../outbox-job.js";
import type { RelayLogger } from "../relay/relay.js";
import type { RoleMapper } from "../revocation/keycloak.js";
import type { MfaTruth } from "./truth.js";

export const USERS_QUEUE = "users";
export const USERS_MFA_CHECK = "users.mfa_check";

/** The registered users.mfa_check payload (packages/db/outbox.ts): the user, nothing else. */
export interface MfaCheckPayload {
  readonly userId: string;
}

/** What the consumer reads of a BullMQ job (outbox-job.ts; a Job satisfies it). */
export type MfaJob = OutboxJob;

export interface MfaDeps {
  readonly truth: MfaTruth;
  readonly keycloak: RoleMapper;
  readonly logger: RelayLogger;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The job's user id, read without trusting the rest of the payload. */
const userIdOf = (job: MfaJob | undefined): string | undefined =>
  payloadField(job, "userId");

/**
 * The job's payload, checked: exactly the registered key, a UUID.
 * Anything else, a flag included, is an UnrecoverableError (no retry, no
 * value in the message).
 */
export function parseMfaCheck(job: MfaJob): MfaCheckPayload {
  const reject = () => new UnrecoverableError(`invalid ${USERS_MFA_CHECK} job`);
  if (job.name !== USERS_MFA_CHECK) throw reject();
  if (typeof job.data !== "object" || job.data === null) throw reject();
  const payload: unknown = Reflect.get(job.data, "payload");
  if (typeof payload !== "object" || payload === null) throw reject();
  if (Object.keys(payload).length !== 1) throw reject();
  const userId = field(payload, "userId");
  if (userId === undefined || !UUID.test(userId)) throw reject();
  return { userId };
}

/** One job: the truth, then the realm role from it, then one log line. */
export async function processMfaCheck(
  job: MfaJob,
  deps: MfaDeps,
): Promise<void> {
  const { userId } = parseMfaCheck(job);
  const outboxId = outboxIdOf(job);
  const state: MfaState | undefined = await deps.truth.read(userId);
  if (state === undefined) {
    deps.logger.warn(
      { outboxId, userId, where: "database" },
      "mfa.user_missing",
    );
    return;
  }
  const outcome = await deps.keycloak.ensureRealmRole(
    state.keycloakSub,
    state.required,
  );
  if (outcome === "user_missing") {
    deps.logger.warn(
      { outboxId, userId, where: "keycloak" },
      "mfa.user_missing",
    );
    return;
  }
  deps.logger.info(
    {
      outboxId,
      userId,
      required: state.required,
      changed: outcome !== "unchanged",
      attempt: job.attemptsMade + 1,
    },
    "mfa.applied",
  );
}

/**
 * BullMQ's `failed` event: a retry is a debug line, the last failure one
 * mfa.keycloak_failed at error, a rejected payload one mfa.rejected. Ids,
 * counts and the HTTP status only.
 */
export function onMfaFailed(
  job: MfaJob | undefined,
  error: unknown,
  logger: RelayLogger,
): void {
  const outboxId = outboxIdOf(job);
  if (error instanceof UnrecoverableError) {
    logger.error({ outboxId }, "mfa.rejected");
    return;
  }
  const userId = userIdOf(job);
  const status = statusOf(error);
  const attemptsMade = job?.attemptsMade;
  const allowed = job?.opts.attempts ?? 1;
  if (attemptsMade !== undefined && attemptsMade < allowed) {
    logger.debug(
      { outboxId, userId, attempt: attemptsMade, status },
      "mfa.retry",
    );
    return;
  }
  logger.error(
    { outboxId, userId, attempts: attemptsMade, status },
    "mfa.keycloak_failed",
  );
}

export interface MfaConsumerOptions {
  /** A dedicated connection (BullMQ blocks on it): maxRetriesPerRequest null. */
  readonly connection: Redis;
  readonly deps: MfaDeps;
}

export interface MfaConsumer {
  /** Stops taking jobs, waits for the one in flight, closes the Worker. */
  close(): Promise<void>;
}

/** A running BullMQ Worker on queue `users`, processing users.mfa_check. */
export function createMfaConsumer(options: MfaConsumerOptions): MfaConsumer {
  const { connection, deps } = options;
  const worker = new Worker(USERS_QUEUE, (job) => processMfaCheck(job, deps), {
    connection,
    concurrency: 1,
    settings: {
      backoffStrategy: (attemptsMade, type, error, job) =>
        outboxBackoff(attemptsMade, type, error, job),
    },
  });
  worker.on("failed", (job, error) => {
    onMfaFailed(job, error, deps.logger);
  });
  // A connection error surfaces as failed or stalled jobs; the message can
  // carry the host, so only the event is logged.
  worker.on("error", () => {
    deps.logger.warn({}, "mfa.consumer_error");
  });
  return {
    close: () => worker.close(),
  };
}
