// Publishes outbox rows to BullMQ (P4-06, ADR 0056). The one place that
// adds jobs (Semgrep bricx-bullmq-outside-outbox); the API never imports
// BullMQ (bricx-bullmq-outside-worker). jobId = the outbox id, so a row
// published twice (a crash between the add and the COMMIT) is one job
// while BullMQ keeps it: completed and failed jobs are kept 24 h, the
// dedupe window (at-least-once delivery; consumers stay idempotent). A
// topic's delivery options (P5-04, ADR 0065) become the job's attempts
// and its "outbox" backoff, which the consumer's Worker resolves with
// deliveryBackoffMs(); without them BullMQ makes one attempt. P5-06 (D-G,
// ADR 0067): a row with not_before is added delayed by the claim's
// delayMs, so the outbox never holds a long-lived row; schedule() upserts
// a repeating job (the expiry sweep), the one other way a job enters a
// queue, kept here with the Queues.
import type { OutboxDelivery } from "@bricx/db/outbox";
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { isInfrastructureError } from "./errors.js";
import type { OutboxJobData } from "./relay.js";

/** The backoff type the relay sets and the consumer resolves. */
export const OUTBOX_BACKOFF = "outbox";

export interface Publisher {
  /** Adds one job; resolves once Valkey holds it (or already held it). */
  publish(
    queue: string,
    name: string,
    data: OutboxJobData,
    jobId: string,
    delivery?: OutboxDelivery,
    /** Milliseconds before the job may run (0 or undefined: at once). */
    delayMs?: number,
  ): Promise<void>;
  /**
   * Upserts the repeating job `name` on `queue` under `schedulerId`,
   * every `everyMs`: idempotent, so N workers share one schedule.
   */
  schedule(
    queue: string,
    schedulerId: string,
    everyMs: number,
    name: string,
  ): Promise<void>;
  /** Resolves when Valkey answers PING. */
  ping(): Promise<void>;
  /** Closes the queues (not the shared connection). */
  close(): Promise<void>;
}

export interface BullPublisherOptions {
  /** How long completed and failed jobs are kept, in s (default 24 h). */
  readonly retentionSeconds?: number;
}

const DEFAULT_RETENTION_SECONDS = 86_400;

/** A Publisher on `connection`, shared by one BullMQ Queue per queue name. */
export function createBullPublisher(
  connection: Redis,
  options: BullPublisherOptions = {},
): Publisher {
  const age = options.retentionSeconds ?? DEFAULT_RETENTION_SECONDS;
  const queues = new Map<string, Queue>();
  const queueFor = (name: string): Queue => {
    const existing = queues.get(name);
    if (existing !== undefined) return existing;
    // skipWaitingForReady: an add fails at once while Valkey is down
    // instead of waiting for a connection (condition 1).
    const queue = new Queue(name, { connection, skipWaitingForReady: true });
    queue.on("error", () => undefined);
    queues.set(name, queue);
    return queue;
  };
  return {
    async publish(queue, name, data, jobId, delivery, delayMs) {
      const target = queueFor(queue);
      try {
        await target.add(name, data, {
          jobId,
          removeOnComplete: { age },
          removeOnFail: { age },
          ...(delayMs !== undefined && delayMs > 0 ? { delay: delayMs } : {}),
          ...(delivery === undefined
            ? {}
            : {
                attempts: delivery.attempts,
                backoff: { type: OUTBOX_BACKOFF, delay: delivery.backoffMs },
              }),
        });
      } catch (error) {
        // A Queue first used while Valkey is down keeps its failed
        // initialisation and rejects every later add with it: drop it on an
        // infrastructure failure so the next add starts a fresh one.
        if (isInfrastructureError(error) && queues.get(queue) === target) {
          queues.delete(queue);
          target.close().catch(() => undefined);
        }
        throw error;
      }
    },
    async schedule(queue, schedulerId, everyMs, name) {
      await queueFor(queue).upsertJobScheduler(
        schedulerId,
        { every: everyMs },
        {
          name,
          opts: { removeOnComplete: { age }, removeOnFail: { age } },
        },
      );
    },
    async ping() {
      await connection.ping();
    },
    async close() {
      const open = [...queues.values()];
      queues.clear();
      await Promise.all(open.map((q) => q.close()));
    },
  };
}
