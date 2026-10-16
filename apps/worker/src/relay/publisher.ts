// Publishes outbox rows to BullMQ (P4-06, ADR 0056). The one place that
// adds jobs (Semgrep bricx-bullmq-outside-outbox); the API never imports
// BullMQ (bricx-bullmq-outside-worker). jobId = the outbox id, so a row
// published twice (a crash between the add and the COMMIT) is one job
// while BullMQ keeps it: completed and failed jobs are kept 24 h, the
// dedupe window (at-least-once delivery; consumers stay idempotent).
import { Queue } from "bullmq";
import type { Redis } from "ioredis";
import { isInfrastructureError } from "./errors.js";
import type { OutboxJobData } from "./relay.js";

export interface Publisher {
  /** Adds one job; resolves once Valkey holds it (or already held it). */
  publish(
    queue: string,
    name: string,
    data: OutboxJobData,
    jobId: string,
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
    async publish(queue, name, data, jobId) {
      const target = queueFor(queue);
      try {
        await target.add(name, data, {
          jobId,
          removeOnComplete: { age },
          removeOnFail: { age },
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
