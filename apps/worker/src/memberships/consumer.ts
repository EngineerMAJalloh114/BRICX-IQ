// The memberships consumer and its sweep (P6-06b, ADR 0084; the P5-06
// pattern of apps/worker/src/access/consumer.ts). A BullMQ Worker on
// queue `memberships` takes three kinds of job:
// - memberships.expire, published by the relay from bricx.outbox as a
//   delayed job (not_before = expires_at). Per job: check the payload
//   (the four registered keys and the row's org; a bad one is
//   unrecoverable: rejected, never retried), then record the expiry
//   through expiry.ts (one bricx_app transaction: the row and the audit
//   event as `system`). An `open` membership (an early job: clock skew)
//   THROWS MembershipNotDueError, so BullMQ retries with the topic's
//   delivery options; it never completes as a no-op. A renewed, removed,
//   permanent or already expired membership (a stale job or a replay)
//   completes with membership.expire_noop; a row the transaction cannot
//   see with membership.missing.
// - memberships.expiring, the notice (owner condition C8). Delivery to a
//   person is P12: until then one membership.expiring line with the ids.
// - memberships.sweep, the worker's own job every 5 minutes (one BullMQ
//   job scheduler shared by every worker). It records every due expiry
//   of every org (a lost or never-scheduled delayed job is recorded
//   within 5 minutes) and writes the 7-day notice of every membership
//   that has none, going on past a failing one; the job fails when any
//   did (the next run retries).
// Logs carry ids, kinds, counts, states and SQLSTATEs only: never a
// reason, a value or a message.
import { sqlstateOf } from "@bricx/db/database";
import type { DueMembership, MembershipKind } from "@bricx/db/memberships";
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
import type { DueMembershipReader } from "./due.js";
import type { MembershipExpirer } from "./expiry.js";

export const MEMBERSHIPS_QUEUE = "memberships";
export const MEMBERSHIPS_EXPIRE = "memberships.expire";
export const MEMBERSHIPS_EXPIRING = "memberships.expiring";
/** The sweep job's name and its scheduler's id (not an outbox topic). */
export const MEMBERSHIPS_SWEEP = "memberships.sweep";
export const MEMBERSHIPS_SWEEP_SCHEDULER_ID = MEMBERSHIPS_SWEEP;
export const MEMBERSHIPS_SWEEP_EVERY_MS = 300_000;
/** Rows one sweep reads of each kind (the next run takes the rest). */
export const MEMBERSHIPS_SWEEP_LIMIT = 100;

/** The registered memberships.expire payload, with the row's org. */
export interface MembershipExpirePayload extends DueMembership {
  /** The end the job was made for (toISOString() form). */
  readonly expiresAt: string;
}

export type MembershipJob = OutboxJob;

export interface MembershipDeps {
  readonly expirer: MembershipExpirer;
  readonly due: DueMembershipReader;
  readonly logger: RelayLogger;
}

/** An expire job that ran before its membership was due: retried, never completed. */
export class MembershipNotDueError extends Error {
  readonly code = "membership.expire_not_due";

  constructor() {
    super("membership not due");
  }
}
Object.defineProperty(MembershipNotDueError.prototype, "name", {
  value: "MembershipNotDueError",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const kindOf = (value: string | undefined): MembershipKind | undefined =>
  value === "org" || value === "project" ? value : undefined;

/** The ids of a job of `name`, checked: exactly `keys` keys, UUIDs, a kind. */
function parseIds(
  job: MembershipJob,
  name: string,
  keys: number,
): { readonly membership: DueMembership; readonly payload: object } {
  const reject = () => new UnrecoverableError(`invalid ${name} job`);
  if (job.name !== name) throw reject();
  if (typeof job.data !== "object" || job.data === null) throw reject();
  const orgId = field(job.data, "orgId");
  const payload: unknown = Reflect.get(job.data, "payload");
  if (typeof payload !== "object" || payload === null) throw reject();
  if (Object.keys(payload).length !== keys) throw reject();
  const kind = kindOf(field(payload, "kind"));
  const id = field(payload, "membershipId");
  const userId = field(payload, "userId");
  if (
    orgId === undefined ||
    kind === undefined ||
    id === undefined ||
    userId === undefined ||
    !UUID.test(orgId) ||
    !UUID.test(id) ||
    !UUID.test(userId)
  ) {
    throw reject();
  }
  return { membership: { kind, id, orgId, userId }, payload };
}

/**
 * The expire job's payload and org, checked. Anything else is an
 * UnrecoverableError (no retry, no value in the message).
 */
export function parseMembershipExpire(
  job: MembershipJob,
): MembershipExpirePayload {
  const { membership, payload } = parseIds(job, MEMBERSHIPS_EXPIRE, 4);
  const expiresAt = field(payload, "expiresAt");
  if (expiresAt === undefined || !INSTANT.test(expiresAt)) {
    throw new UnrecoverableError(`invalid ${MEMBERSHIPS_EXPIRE} job`);
  }
  return { ...membership, expiresAt };
}

/** The notice job's payload and org, checked. */
export function parseMembershipExpiring(job: MembershipJob): DueMembership {
  return parseIds(job, MEMBERSHIPS_EXPIRING, 3).membership;
}

async function processExpire(
  job: MembershipJob,
  deps: MembershipDeps,
): Promise<void> {
  const { expiresAt, ...membership } = parseMembershipExpire(job);
  const outboxId = outboxIdOf(job);
  const ids = {
    outboxId,
    membershipId: membership.id,
    kind: membership.kind,
  };
  const outcome = await deps.expirer.expire(
    membership,
    outboxId ?? membership.id,
    expiresAt,
  );
  if (outcome === undefined) {
    deps.logger.warn(ids, "membership.missing");
    return;
  }
  if (outcome.changed) {
    deps.logger.info(
      {
        ...ids,
        userId: outcome.membership.userId,
        orgId: outcome.membership.orgId,
        source: "job",
        attempt: job.attemptsMade + 1,
      },
      "membership.expired",
    );
    return;
  }
  if (outcome.state === "open") throw new MembershipNotDueError();
  deps.logger.info({ ...ids, state: outcome.state }, "membership.expire_noop");
}

/** The notice: delivery is P12; the ids are logged. */
function processExpiring(job: MembershipJob, deps: MembershipDeps): void {
  const membership = parseMembershipExpiring(job);
  deps.logger.info(
    {
      outboxId: outboxIdOf(job),
      membershipId: membership.id,
      kind: membership.kind,
      userId: membership.userId,
      orgId: membership.orgId,
    },
    "membership.expiring",
  );
}

/** One sweep: every due expiry and every missing notice, each in its own transaction. */
async function processSweep(deps: MembershipDeps): Promise<void> {
  const due = await deps.due.due(MEMBERSHIPS_SWEEP_LIMIT);
  let expired = 0;
  let skipped = 0;
  let failed = 0;
  for (const membership of due) {
    try {
      const outcome = await deps.expirer.expire(
        membership,
        `sweep.${membership.id}`,
      );
      if (outcome?.changed === true) {
        expired += 1;
        deps.logger.info(
          {
            membershipId: membership.id,
            kind: membership.kind,
            userId: outcome.membership.userId,
            orgId: outcome.membership.orgId,
            source: "sweep",
          },
          "membership.expired",
        );
      } else {
        skipped += 1;
      }
    } catch {
      failed += 1;
    }
  }
  const expiring = await deps.due.expiring(MEMBERSHIPS_SWEEP_LIMIT);
  let notified = 0;
  for (const membership of expiring) {
    try {
      if (await deps.expirer.notify(membership)) notified += 1;
      else skipped += 1;
    } catch {
      failed += 1;
    }
  }
  const counts = {
    due: due.length,
    expired,
    expiring: expiring.length,
    notified,
    skipped,
    failed,
  };
  if (due.length === 0 && expiring.length === 0) {
    deps.logger.debug(counts, "membership.sweep");
  } else {
    deps.logger.info(counts, "membership.sweep");
  }
  if (failed > 0) {
    throw new Error(`membership sweep: ${String(failed)} failed`);
  }
}

/** One job of queue `memberships`. */
export async function processMembershipJob(
  job: MembershipJob,
  deps: MembershipDeps,
): Promise<void> {
  if (job.name === MEMBERSHIPS_SWEEP) return processSweep(deps);
  if (job.name === MEMBERSHIPS_EXPIRING) {
    processExpiring(job, deps);
    return;
  }
  return processExpire(job, deps);
}

/**
 * BullMQ's `failed` event: a retry is a debug line, the last failure one
 * membership.expire_failed at error, a rejected payload one
 * membership.rejected, a failed sweep one membership.sweep_failed.
 */
export function onMembershipFailed(
  job: MembershipJob | undefined,
  error: unknown,
  logger: RelayLogger,
): void {
  if (job?.name === MEMBERSHIPS_SWEEP) {
    logger.error({ attempts: job.attemptsMade }, "membership.sweep_failed");
    return;
  }
  const outboxId = outboxIdOf(job);
  if (error instanceof UnrecoverableError) {
    logger.error({ outboxId }, "membership.rejected");
    return;
  }
  const membershipId = payloadField(job, "membershipId");
  const sqlstate = sqlstateOf(error);
  const attemptsMade = job?.attemptsMade;
  const allowed = job?.opts.attempts ?? 1;
  if (attemptsMade !== undefined && attemptsMade < allowed) {
    logger.debug(
      {
        outboxId,
        membershipId,
        attempt: attemptsMade,
        notDue: error instanceof MembershipNotDueError,
        sqlstate,
      },
      "membership.retry",
    );
    return;
  }
  logger.error(
    { outboxId, membershipId, attempts: attemptsMade, sqlstate },
    "membership.expire_failed",
  );
}

/** Registers the sweep: one job scheduler on queue `memberships`, every 5 minutes. */
export function scheduleMembershipSweep(
  publisher: Pick<Publisher, "schedule">,
): Promise<void> {
  return publisher.schedule(
    MEMBERSHIPS_QUEUE,
    MEMBERSHIPS_SWEEP_SCHEDULER_ID,
    MEMBERSHIPS_SWEEP_EVERY_MS,
    MEMBERSHIPS_SWEEP,
  );
}

export interface MembershipConsumerOptions {
  /** A dedicated connection (BullMQ blocks on it): maxRetriesPerRequest null. */
  readonly connection: Redis;
  readonly deps: MembershipDeps;
}

export interface MembershipConsumer {
  /** Stops taking jobs, waits for the one in flight, closes the Worker. */
  close(): Promise<void>;
}

/** A running BullMQ Worker on queue `memberships`. */
export function createMembershipConsumer(
  options: MembershipConsumerOptions,
): MembershipConsumer {
  const { connection, deps } = options;
  const worker = new Worker(
    MEMBERSHIPS_QUEUE,
    (job) => processMembershipJob(job, deps),
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
    onMembershipFailed(job, error, deps.logger);
  });
  // A connection error surfaces as failed or stalled jobs; the message can
  // carry the host, so only the event is logged.
  worker.on("error", () => {
    deps.logger.warn({}, "membership.consumer_error");
  });
  return {
    close: () => worker.close(),
  };
}
