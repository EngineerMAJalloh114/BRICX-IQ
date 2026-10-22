// The access_grants.expire consumer and the sweep (P5-06, D-G, owner
// conditions 3, 4 and 6, ADR 0067). A BullMQ Worker on queue `access`
// takes two kinds of job:
// - access_grants.expire, published by the relay from bricx.outbox as a
//   delayed job (not_before = expires_at). Per job: check the payload
//   (the two registered keys and the row's org, UUIDs; a bad one is
//   unrecoverable: rejected, never retried), then expire the grant
//   through expiry.ts (one bricx_app transaction: the row, the audit
//   event as `system`, the users.mfa_check row). An open or pending grant
//   (an early job: clock skew, or a replay of a row a new grant reused)
//   THROWS AccessNotDueError, so BullMQ retries with the topic's delivery
//   options (40 attempts, 1 s doubling, capped at 60 s); it never
//   completes as a no-op (condition 3). A revoked or already expired
//   grant (a replay) completes with access.expire_noop; a row the
//   transaction cannot see with access.grant_missing.
// - access_grants.sweep, the worker's own job every 5 minutes
//   (scheduleSweep(): one BullMQ job scheduler, upserted by every worker,
//   so N workers share one schedule). It reads the due grants of every
//   org through due.ts and expires each the same way, going on past a
//   failing one; the job fails when any did (the next run retries). A
//   lost delayed job is recorded within 5 minutes.
// Logs carry ids, counts, states and SQLSTATEs only: access.expired,
// access.expire_noop, access.grant_missing, access.sweep, access.retry,
// access.rejected, access.expire_failed (P13-05 alerts on it),
// access.sweep_failed. Never a reason, a value or a message.
import type { DueAccessGrant } from "@bricx/db/access-grants";
import { sqlstateOf } from "@bricx/db/database";
import { UnrecoverableError, Worker } from "bullmq";
import type { Redis } from "ioredis";
import {
  type OutboxJob,
  field,
  outboxBackoff,
  outboxIdOf,
  payloadField,
} from "../outbox-job.js";
import type { Publisher } from "../relay/publisher.js";
import type { RelayLogger } from "../relay/relay.js";
import type { DueReader } from "./due.js";
import type { AccessExpirer } from "./expiry.js";

export const ACCESS_QUEUE = "access";
export const ACCESS_GRANTS_EXPIRE = "access_grants.expire";
/** The sweep job's name and its scheduler's id (not an outbox topic). */
export const ACCESS_SWEEP = "access_grants.sweep";
export const SWEEP_SCHEDULER_ID = ACCESS_SWEEP;
export const SWEEP_EVERY_MS = 300_000;
/** Due grants one sweep reads (the next run takes the rest). */
export const SWEEP_LIMIT = 100;

/** The registered access_grants.expire payload (packages/db/outbox.ts), with the row's org. */
export interface AccessExpirePayload {
  readonly grantId: string;
  readonly userId: string;
  readonly orgId: string;
}

/** What the consumer reads of a BullMQ job (outbox-job.ts; a Job satisfies it). */
export type AccessJob = OutboxJob;

export interface AccessDeps {
  readonly expirer: AccessExpirer;
  readonly due: DueReader;
  readonly logger: RelayLogger;
}

/** An expire job that ran before its grant was due: retried, never completed (condition 3). */
export class AccessNotDueError extends Error {
  readonly code = "access.expire_not_due";
  readonly state: "open" | "pending";

  constructor(state: "open" | "pending") {
    super(`access grant not due: ${state}`);
    this.state = state;
  }
}
Object.defineProperty(AccessNotDueError.prototype, "name", {
  value: "AccessNotDueError",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The job's payload and org, checked: exactly the registered keys, all
 * UUIDs. Anything else is an UnrecoverableError (no retry, no value in
 * the message).
 */
export function parseAccessExpire(job: AccessJob): AccessExpirePayload {
  const reject = () =>
    new UnrecoverableError(`invalid ${ACCESS_GRANTS_EXPIRE} job`);
  if (job.name !== ACCESS_GRANTS_EXPIRE) throw reject();
  if (typeof job.data !== "object" || job.data === null) throw reject();
  const orgId = field(job.data, "orgId");
  const payload: unknown = Reflect.get(job.data, "payload");
  if (typeof payload !== "object" || payload === null) throw reject();
  if (Object.keys(payload).length !== 2) throw reject();
  const grantId = field(payload, "grantId");
  const userId = field(payload, "userId");
  if (
    orgId === undefined ||
    grantId === undefined ||
    userId === undefined ||
    !UUID.test(orgId) ||
    !UUID.test(grantId) ||
    !UUID.test(userId)
  ) {
    throw reject();
  }
  return { grantId, userId, orgId };
}

/** One expire job: the grant's transaction, then one line (condition 3 throws). */
async function processExpire(job: AccessJob, deps: AccessDeps): Promise<void> {
  const { grantId, userId, orgId } = parseAccessExpire(job);
  const outboxId = outboxIdOf(job);
  const outcome = await deps.expirer.expire(
    { id: grantId, orgId, userId },
    outboxId ?? grantId,
  );
  if (outcome === undefined) {
    deps.logger.warn({ outboxId, grantId }, "access.grant_missing");
    return;
  }
  if (outcome.changed) {
    deps.logger.info(
      {
        outboxId,
        grantId,
        userId: outcome.grant.userId,
        orgId: outcome.grant.orgId,
        source: "job",
        attempt: job.attemptsMade + 1,
      },
      "access.expired",
    );
    return;
  }
  if (outcome.state === "open" || outcome.state === "pending") {
    throw new AccessNotDueError(outcome.state);
  }
  deps.logger.info(
    { outboxId, grantId, state: outcome.state },
    "access.expire_noop",
  );
}

/** One sweep: every due grant in every org, each in its own transaction. */
async function processSweep(deps: AccessDeps): Promise<void> {
  const due: DueAccessGrant[] = await deps.due.read(SWEEP_LIMIT);
  let expired = 0;
  let skipped = 0;
  let failed = 0;
  for (const grant of due) {
    try {
      const outcome = await deps.expirer.expire(grant, `sweep.${grant.id}`);
      if (outcome?.changed === true) {
        expired += 1;
        deps.logger.info(
          {
            grantId: grant.id,
            userId: outcome.grant.userId,
            orgId: outcome.grant.orgId,
            source: "sweep",
          },
          "access.expired",
        );
      } else {
        skipped += 1;
      }
    } catch {
      failed += 1;
    }
  }
  const counts = { due: due.length, expired, skipped, failed };
  if (due.length === 0) deps.logger.debug(counts, "access.sweep");
  else deps.logger.info(counts, "access.sweep");
  if (failed > 0) throw new Error(`access sweep: ${String(failed)} failed`);
}

/** One job of queue `access`: an expiry or the sweep. */
export function processAccessJob(
  job: AccessJob,
  deps: AccessDeps,
): Promise<void> {
  return job.name === ACCESS_SWEEP
    ? processSweep(deps)
    : processExpire(job, deps);
}

/**
 * BullMQ's `failed` event: a retry is a debug line, the last failure one
 * access.expire_failed at error, a rejected payload one access.rejected,
 * a failed sweep one access.sweep_failed. Ids, counts and the SQLSTATE only.
 */
export function onAccessFailed(
  job: AccessJob | undefined,
  error: unknown,
  logger: RelayLogger,
): void {
  if (job?.name === ACCESS_SWEEP) {
    logger.error({ attempts: job.attemptsMade }, "access.sweep_failed");
    return;
  }
  const outboxId = outboxIdOf(job);
  if (error instanceof UnrecoverableError) {
    logger.error({ outboxId }, "access.rejected");
    return;
  }
  const grantId = payloadField(job, "grantId");
  const sqlstate = sqlstateOf(error);
  const attemptsMade = job?.attemptsMade;
  const allowed = job?.opts.attempts ?? 1;
  if (attemptsMade !== undefined && attemptsMade < allowed) {
    logger.debug(
      {
        outboxId,
        grantId,
        attempt: attemptsMade,
        notDue: error instanceof AccessNotDueError,
        sqlstate,
      },
      "access.retry",
    );
    return;
  }
  logger.error(
    { outboxId, grantId, attempts: attemptsMade, sqlstate },
    "access.expire_failed",
  );
}

/**
 * Registers the sweep: one job scheduler on queue `access`, every 5
 * minutes. The publisher upserts it, so every worker may call this and
 * N workers share one schedule (condition 6).
 */
export function scheduleSweep(
  publisher: Pick<Publisher, "schedule">,
): Promise<void> {
  return publisher.schedule(
    ACCESS_QUEUE,
    SWEEP_SCHEDULER_ID,
    SWEEP_EVERY_MS,
    ACCESS_SWEEP,
  );
}

export interface AccessConsumerOptions {
  /** A dedicated connection (BullMQ blocks on it): maxRetriesPerRequest null. */
  readonly connection: Redis;
  readonly deps: AccessDeps;
}

export interface AccessConsumer {
  /** Stops taking jobs, waits for the one in flight, closes the Worker. */
  close(): Promise<void>;
}

/** A running BullMQ Worker on queue `access`: expiries and the sweep. */
export function createAccessConsumer(
  options: AccessConsumerOptions,
): AccessConsumer {
  const { connection, deps } = options;
  const worker = new Worker(
    ACCESS_QUEUE,
    (job) => processAccessJob(job, deps),
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
    onAccessFailed(job, error, deps.logger);
  });
  // A connection error surfaces as failed or stalled jobs; the message can
  // carry the host, so only the event is logged.
  worker.on("error", () => {
    deps.logger.warn({}, "access.consumer_error");
  });
  return {
    close: () => worker.close(),
  };
}
