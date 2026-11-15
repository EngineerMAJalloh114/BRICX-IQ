// The invitations consumer (P6-06, ADR 0077, D4-D6, D10). A BullMQ Worker
// on queue `invitations` takes three kinds of job:
// - invitations.send {invitationId, sendSeq, invitedBy} with the row's
//   org: send.ts mints the token and sends the e-mail. A stale send
//   completes with invitation.send_stale; a failed one throws and is
//   retried with the topic's delivery options (40 attempts, 1 s doubling,
//   capped at 60 s), minting a new token each time.
// - invitations.activate {invitationId, invitedBy}: activate.ts reads the
//   pending address and makes sure a Keycloak account can be activated.
// - invitations.sweep, the worker's own job every minute (one BullMQ job
//   scheduler, upserted by every worker): every due invitation in every
//   org through due.ts, each expired and audited by expiry.ts, going on
//   past a failing one; the job fails when any did (the next run retries).
// A payload that is not exactly the registered keys (UUIDs; sendSeq a
// positive integer) is unrecoverable: rejected, never retried.
// Logs carry ids, counts, outcomes and status codes only: never the
// address, a token or a message (invitation.sent, invitation.send_stale,
// invitation.activated, invitation.expired, invitation.sweep,
// invitation.retry, invitation.rejected, invitation.failed,
// invitation.sweep_failed).
import { sqlstateOf } from "@bricx/db/database";
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
import type { Publisher } from "../relay/publisher.js";
import type { RelayLogger } from "../relay/relay.js";
import type { InvitationActivateJob, InvitationActivator } from "./activate.js";
import type { BatchRef, InvitationBatchProcessor } from "./bulk.js";
import type { DueInvitationReader, StaleBatchReader } from "./due.js";
import type { InvitationExpirer } from "./expiry.js";
import type { InvitationSendJob, InvitationSender } from "./send.js";

export const INVITATIONS_QUEUE = "invitations";
export const INVITATIONS_SEND = "invitations.send";
export const INVITATIONS_ACTIVATE = "invitations.activate";
/** P6-06c (ADR 0085): a bulk batch {batchId, createdBy}. */
export const INVITATIONS_BULK = "invitations.bulk";
/** The sweep job's name and its scheduler's id (not an outbox topic). */
export const INVITATIONS_SWEEP = "invitations.sweep";
export const INVITATIONS_SWEEP_EVERY_MS = 60_000;
/** Due invitations one sweep reads (the next run takes the rest). */
export const INVITATIONS_SWEEP_LIMIT = 100;

export interface InvitationDeps {
  readonly sender: InvitationSender;
  readonly activator: InvitationActivator;
  readonly expirer: InvitationExpirer;
  readonly due: DueInvitationReader;
  readonly logger: RelayLogger;
  /** P6-06c (ADR 0085): invitations.bulk and the sweep's stale batches. */
  readonly batches?: InvitationBatchProcessor | undefined;
  readonly staleBatches?: StaleBatchReader | undefined;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** The largest send_seq a row can reach (1 + MAX_INVITATION_MAX_RESENDS). */
const MAX_SEND_SEQ = 21;

const reject = (name: string) => new UnrecoverableError(`invalid ${name} job`);

/** The payload object of a relay job, with exactly `keys`, and the org. */
function payloadOf(
  job: OutboxJob,
  name: string,
  keys: readonly string[],
): { payload: object; orgId: string } {
  if (job.name !== name) throw reject(name);
  if (typeof job.data !== "object" || job.data === null) throw reject(name);
  const orgId = field(job.data, "orgId");
  const payload: unknown = Reflect.get(job.data, "payload");
  if (typeof payload !== "object" || payload === null) throw reject(name);
  const given = Object.keys(payload).sort();
  if (given.join(",") !== [...keys].sort().join(",")) throw reject(name);
  if (orgId === undefined || !UUID.test(orgId)) throw reject(name);
  return { payload, orgId };
}

const uuidField = (payload: object, key: string, name: string): string => {
  const value = field(payload, key);
  if (value === undefined || !UUID.test(value)) throw reject(name);
  return value;
};

/** An invitations.send job, checked. */
export function parseInvitationSend(job: OutboxJob): InvitationSendJob {
  const { payload, orgId } = payloadOf(job, INVITATIONS_SEND, [
    "invitationId",
    "sendSeq",
    "invitedBy",
  ]);
  const sendSeq: unknown = Reflect.get(payload, "sendSeq");
  if (
    typeof sendSeq !== "number" ||
    !Number.isSafeInteger(sendSeq) ||
    sendSeq < 1 ||
    sendSeq > MAX_SEND_SEQ
  ) {
    throw reject(INVITATIONS_SEND);
  }
  return {
    invitationId: uuidField(payload, "invitationId", INVITATIONS_SEND),
    invitedBy: uuidField(payload, "invitedBy", INVITATIONS_SEND),
    orgId,
    sendSeq,
  };
}

/** An invitations.activate job, checked. */
export function parseInvitationActivate(job: OutboxJob): InvitationActivateJob {
  const { payload, orgId } = payloadOf(job, INVITATIONS_ACTIVATE, [
    "invitationId",
    "invitedBy",
  ]);
  return {
    invitationId: uuidField(payload, "invitationId", INVITATIONS_ACTIVATE),
    invitedBy: uuidField(payload, "invitedBy", INVITATIONS_ACTIVATE),
    orgId,
  };
}

/** An invitations.bulk job, checked. */
export function parseInvitationsBulk(job: OutboxJob): BatchRef {
  const { payload, orgId } = payloadOf(job, INVITATIONS_BULK, [
    "batchId",
    "createdBy",
  ]);
  return {
    batchId: uuidField(payload, "batchId", INVITATIONS_BULK),
    createdBy: uuidField(payload, "createdBy", INVITATIONS_BULK),
    orgId,
  };
}

/** The sweep's stale batches (K3): each purged in its own transaction; the failures. */
async function sweepBatches(deps: InvitationDeps): Promise<number> {
  if (deps.batches === undefined || deps.staleBatches === undefined) return 0;
  const stale = await deps.staleBatches.read(INVITATIONS_SWEEP_LIMIT);
  let failed = 0;
  for (const batch of stale) {
    try {
      const counts = await deps.batches.purge(
        { batchId: batch.id, orgId: batch.orgId, createdBy: batch.createdBy },
        `sweep.${batch.id}`,
      );
      if (counts !== undefined) {
        deps.logger.info(
          { batchId: batch.id, orgId: batch.orgId, source: "sweep" },
          "invitation_batch.purged",
        );
      }
    } catch {
      failed += 1;
    }
  }
  return failed;
}

async function processSweep(deps: InvitationDeps): Promise<void> {
  const due = await deps.due.read(INVITATIONS_SWEEP_LIMIT);
  let expired = 0;
  let skipped = 0;
  let failed = 0;
  for (const ref of due) {
    try {
      const settled = await deps.expirer.expire(ref, `sweep.${ref.id}`);
      if (settled === undefined) {
        skipped += 1;
      } else {
        expired += 1;
        deps.logger.info(
          { invitationId: ref.id, orgId: ref.orgId, source: "sweep" },
          "invitation.expired",
        );
      }
    } catch {
      failed += 1;
    }
  }
  failed += await sweepBatches(deps);
  const counts = { due: due.length, expired, skipped, failed };
  if (due.length === 0) deps.logger.debug(counts, "invitation.sweep");
  else deps.logger.info(counts, "invitation.sweep");
  if (failed > 0) throw new Error(`invitation sweep: ${String(failed)} failed`);
}

/** One job of queue `invitations`. */
export async function processInvitationJob(
  job: OutboxJob,
  deps: InvitationDeps,
): Promise<void> {
  if (job.name === INVITATIONS_SWEEP) return processSweep(deps);
  const outboxId = outboxIdOf(job);
  if (job.name === INVITATIONS_BULK) {
    const ref = parseInvitationsBulk(job);
    if (deps.batches === undefined) {
      throw new Error("bulk processor not configured");
    }
    const outcome = await deps.batches.processRows(
      ref,
      outboxId ?? ref.batchId,
    );
    deps.logger.info(
      { outboxId, batchId: ref.batchId, state: outcome.state },
      "invitation_batch.processed",
    );
    return;
  }
  if (job.name === INVITATIONS_ACTIVATE) {
    const parsed = parseInvitationActivate(job);
    const outcome = await deps.activator.activate(parsed);
    deps.logger.info(
      { outboxId, invitationId: parsed.invitationId, outcome },
      "invitation.activated",
    );
    return;
  }
  const parsed = parseInvitationSend(job);
  const outcome = await deps.sender.send(parsed);
  deps.logger.info(
    {
      outboxId,
      invitationId: parsed.invitationId,
      sendSeq: parsed.sendSeq,
      attempt: job.attemptsMade + 1,
    },
    outcome === "sent" ? "invitation.sent" : "invitation.send_stale",
  );
}

/**
 * BullMQ's `failed` event: a retry is a debug line, the last failure one
 * invitation.failed at error, a rejected payload one invitation.rejected,
 * a failed sweep one invitation.sweep_failed. Ids, the HTTP status, the
 * SQLSTATE and an error code only.
 */
export function onInvitationFailed(
  job: OutboxJob | undefined,
  error: unknown,
  logger: RelayLogger,
): void {
  if (job?.name === INVITATIONS_SWEEP) {
    logger.error({ attempts: job.attemptsMade }, "invitation.sweep_failed");
    return;
  }
  const outboxId = outboxIdOf(job);
  if (error instanceof UnrecoverableError) {
    logger.error({ outboxId, topic: job?.name }, "invitation.rejected");
    return;
  }
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  const detail = {
    outboxId,
    topic: job?.name,
    invitationId: payloadField(job, "invitationId"),
    status: statusOf(error),
    sqlstate: sqlstateOf(error),
    code:
      typeof code === "string" && /^[A-Za-z0-9_.]{1,64}$/.test(code)
        ? code
        : undefined,
  };
  const attemptsMade = job?.attemptsMade;
  const allowed = job?.opts.attempts ?? 1;
  if (attemptsMade !== undefined && attemptsMade < allowed) {
    logger.debug({ ...detail, attempt: attemptsMade }, "invitation.retry");
    return;
  }
  logger.error({ ...detail, attempts: attemptsMade }, "invitation.failed");
}

/** Registers the sweep: one job scheduler on queue `invitations`, every minute. */
export function scheduleInvitationSweep(
  publisher: Pick<Publisher, "schedule">,
): Promise<void> {
  return publisher.schedule(
    INVITATIONS_QUEUE,
    INVITATIONS_SWEEP,
    INVITATIONS_SWEEP_EVERY_MS,
    INVITATIONS_SWEEP,
  );
}

export interface InvitationConsumerOptions {
  /** A dedicated connection (BullMQ blocks on it): maxRetriesPerRequest null. */
  readonly connection: Redis;
  readonly deps: InvitationDeps;
}

export interface InvitationConsumer {
  close(): Promise<void>;
}

export function createInvitationConsumer(
  options: InvitationConsumerOptions,
): InvitationConsumer {
  const { connection, deps } = options;
  const worker = new Worker(
    INVITATIONS_QUEUE,
    (job) => processInvitationJob(job, deps),
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
    onInvitationFailed(job, error, deps.logger);
  });
  worker.on("error", () => {
    deps.logger.warn({}, "invitation.consumer_error");
  });
  return { close: () => worker.close() };
}
