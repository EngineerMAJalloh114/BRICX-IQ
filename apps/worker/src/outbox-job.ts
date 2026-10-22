// What every queue consumer shares about a BullMQ job the relay published
// (P5-04 sessions.revoked, P5-05 users.mfa_check; ADR 0056, 0065, 0066):
// the shape it trusts of a Job, the reads of the relay's OutboxJobData
// that never throw, the HTTP status an admin-client NetworkError carries,
// and the "outbox" backoff strategy that resolves the job's topic's
// delivery options (the relay sets the type; the consumer's Worker runs
// the strategy).
import {
  type OutboxDelivery,
  deliveryBackoffMs,
  outboxTopic,
} from "@bricx/db/outbox";

/** What a consumer reads of a BullMQ job (a Job satisfies it). */
export interface OutboxJob {
  readonly name: string;
  /** The relay's OutboxJobData, as far as the consumer trusts it. */
  readonly data?: unknown;
  /** Attempts so far: 0 on the first run; BullMQ counts the failed one. */
  readonly attemptsMade: number;
  readonly opts: {
    readonly attempts?: number;
    readonly backoff?:
      number | { readonly type?: string; readonly delay?: number } | undefined;
  };
}

/** The string field `name` of `data`, when `data` is an object holding one. */
export const field = (data: unknown, name: string): string | undefined => {
  if (typeof data !== "object" || data === null) return undefined;
  const value: unknown = Reflect.get(data, name);
  return typeof value === "string" ? value : undefined;
};

/** The job's outbox id (undefined when the data is not the relay's). */
export const outboxIdOf = (job: OutboxJob | undefined): string | undefined =>
  field(job?.data, "outboxId");

/** The payload's string field `name`, read without trusting the rest of it. */
export const payloadField = (
  job: OutboxJob | undefined,
  name: string,
): string | undefined =>
  typeof job?.data === "object" && job.data !== null
    ? field(Reflect.get(job.data, "payload"), name)
    : undefined;

/** The HTTP status an admin-client NetworkError carries, if any. */
export function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const response: unknown = Reflect.get(error, "response");
  if (typeof response !== "object" || response === null) return undefined;
  const status: unknown = Reflect.get(response, "status");
  return typeof status === "number" ? status : undefined;
}

/** A job's backoff delay from its option, when it is a plain delay. */
const optionDelay = (job: OutboxJob | undefined): number => {
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
  job?: OutboxJob,
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
