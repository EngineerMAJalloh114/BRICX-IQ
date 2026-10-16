// The outbox relay (P4-06, ADR 0056; CLAUDE.md rule 5). One batch is one
// withRelayTx() as bricx_relay:
// 1. claim up to batchSize pending, due rows (FOR UPDATE SKIP LOCKED);
// 2. publish each to its topic's queue with jobId = the outbox id;
// 3. mark the published rows published and the failed rows failed, in the
//    same transaction, then COMMIT. A crash between an add and the COMMIT
//    leaves the row pending: the next add is the same job (jobId dedupe).
// Failures (condition 1):
// - row failures (unknown topic, invalid payload, an add Valkey rejects
//   while still answering PING) count an attempt; dead at deadLetterAfter;
// - infrastructure failures (Valkey or Postgres unreachable or timing out)
//   stop the batch, leave the rest of the batch untouched and back the
//   whole relay off (1 s doubling, capped at maxBackoffMs).
// The batch deadline (condition 6): past batchDeadlineMs, commit what was
// published and stop. Logs carry ids, topics and codes only, never a
// payload or a driver message.
import type { Tx } from "@bricx/db/database";
import {
  MAX_CLAIM,
  OutboxError,
  type OutboxRow,
  outboxTopic,
  validateOutboxPayload,
} from "@bricx/db/outbox";
import { PublishTimeoutError, isInfrastructureError } from "./errors.js";
import type { Publisher } from "./publisher.js";

/** The approved defaults (ADR 0056). */
export const RELAY_DEFAULTS = Object.freeze({
  batchSize: 100,
  deadLetterAfter: 10,
  batchDeadlineMs: 15_000,
  idlePollMs: 1_000,
  maxBackoffMs: 30_000,
  commandTimeoutMs: 5_000,
  unavailableLogEveryMs: 60_000,
  jobRetentionSeconds: 86_400,
});

/**
 * The global backoff after `consecutiveFailures` unavailable batches:
 * 1 s, doubling, capped at `maxBackoffMs`.
 */
export function globalBackoffMs(
  consecutiveFailures: number,
  maxBackoffMs: number,
): number {
  const exponent = Math.min(Math.max(consecutiveFailures, 1) - 1, 30);
  return Math.min(1_000 * 2 ** exponent, maxBackoffMs);
}

/** A job's data: the outbox row's ids, topic and (id-only) payload. */
export interface OutboxJobData {
  readonly outboxId: string;
  readonly orgId: string;
  readonly topic: string;
  readonly payload: unknown;
}

export interface RelayLogger {
  debug(fields: Record<string, unknown>, msg: string): void;
  info(fields: Record<string, unknown>, msg: string): void;
  warn(fields: Record<string, unknown>, msg: string): void;
  error(fields: Record<string, unknown>, msg: string): void;
}

/** The relay's statements (outboxStore in production). */
export interface RelayStore<TTx> {
  claim(tx: TTx, limit: number): Promise<OutboxRow[]>;
  markPublished(tx: TTx, ids: readonly string[]): Promise<void>;
  markFailed(
    tx: TTx,
    id: string,
    code: string,
    deadLetterAfter: number,
  ): Promise<{ attempts: number; dead: boolean }>;
}

export interface RelayOptions<TTx = Tx> {
  readonly database: {
    withRelayTx<T>(fn: (tx: TTx) => Promise<T>): Promise<T>;
  };
  readonly store: RelayStore<TTx>;
  readonly publisher: Publisher;
  readonly logger: RelayLogger;
  readonly batchSize?: number;
  readonly deadLetterAfter?: number;
  readonly batchDeadlineMs?: number;
  readonly idlePollMs?: number;
  readonly maxBackoffMs?: number;
  readonly commandTimeoutMs?: number;
  readonly unavailableLogEveryMs?: number;
  /** A monotonic clock in ms (default performance.now). */
  readonly now?: () => number;
}

export interface BatchResult {
  readonly claimed: number;
  readonly published: number;
  readonly failed: number;
  readonly dead: number;
  /** Valkey or Postgres failed: nothing counted against the rows. */
  readonly unavailable: boolean;
  readonly deadlineHit: boolean;
}

export interface Relay {
  /** Runs one batch. Never throws: a failure is `unavailable: true`. */
  runOnce(): Promise<BatchResult>;
  /** Starts the loop (idempotent). */
  start(): void;
  /** Stops the loop after the batch in flight (idempotent). */
  stop(): Promise<void>;
}

type Dependency = "valkey" | "database";

interface DeadLetter {
  readonly outboxId: string;
  readonly orgId: string;
  readonly topic: string;
  readonly attempts: number;
  readonly lastError: string;
}

/** publishRow()'s answer when Valkey is unavailable. */
const VALKEY_DOWN = Symbol("valkey_down");

const positive = (name: string, value: number, max: number): number => {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new RangeError(`relay: invalid option ${name}`);
  }
  return value;
};

/** Bounds `work` by `ms`: PublishTimeoutError when it does not settle. */
async function bounded<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new PublishTimeoutError());
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

export function createRelay<TTx = Tx>(options: RelayOptions<TTx>): Relay {
  const { database, store, publisher, logger } = options;
  const day = 86_400_000;
  const batchSize = positive(
    "batchSize",
    options.batchSize ?? RELAY_DEFAULTS.batchSize,
    MAX_CLAIM,
  );
  const deadLetterAfter = positive(
    "deadLetterAfter",
    options.deadLetterAfter ?? RELAY_DEFAULTS.deadLetterAfter,
    MAX_CLAIM,
  );
  const batchDeadlineMs = positive(
    "batchDeadlineMs",
    options.batchDeadlineMs ?? RELAY_DEFAULTS.batchDeadlineMs,
    day,
  );
  const idlePollMs = positive(
    "idlePollMs",
    options.idlePollMs ?? RELAY_DEFAULTS.idlePollMs,
    day,
  );
  const maxBackoffMs = positive(
    "maxBackoffMs",
    options.maxBackoffMs ?? RELAY_DEFAULTS.maxBackoffMs,
    day,
  );
  const commandTimeoutMs = positive(
    "commandTimeoutMs",
    options.commandTimeoutMs ?? RELAY_DEFAULTS.commandTimeoutMs,
    day,
  );
  const unavailableLogEveryMs = positive(
    "unavailableLogEveryMs",
    options.unavailableLogEveryMs ?? RELAY_DEFAULTS.unavailableLogEveryMs,
    day,
  );
  const now = options.now ?? (() => performance.now());

  // Outage state: one warn when an outage starts, then at most one per
  // unavailableLogEveryMs; one info when it ends.
  let outageLoggedAt: number | undefined;

  const unavailable = (dependency: Dependency) => {
    const at = now();
    if (
      outageLoggedAt === undefined ||
      at - outageLoggedAt >= unavailableLogEveryMs
    ) {
      outageLoggedAt = at;
      logger.warn({ dependency }, "outbox.relay_unavailable");
    }
  };

  const recovered = () => {
    if (outageLoggedAt === undefined) return;
    outageLoggedAt = undefined;
    logger.info({}, "outbox.relay_recovered");
  };

  /** undefined when published, the row's failure code, or VALKEY_DOWN. */
  const publishRow = async (
    row: OutboxRow,
  ): Promise<string | typeof VALKEY_DOWN | undefined> => {
    let queue: string;
    try {
      const entry = outboxTopic(row.topic);
      validateOutboxPayload(entry, row.payload);
      queue = entry.queue;
    } catch (error) {
      if (error instanceof OutboxError) return error.code;
      throw error;
    }
    const data: OutboxJobData = {
      outboxId: row.id,
      orgId: row.orgId,
      topic: row.topic,
      payload: row.payload,
    };
    try {
      await bounded(
        publisher.publish(queue, row.topic, data, row.id),
        commandTimeoutMs,
      );
      return undefined;
    } catch (error) {
      if (isInfrastructureError(error)) return VALKEY_DOWN;
      // Not recognised: the row's only if Valkey still answers.
      try {
        await bounded(publisher.ping(), commandTimeoutMs);
      } catch {
        return VALKEY_DOWN;
      }
      return "publish_rejected";
    }
  };

  const runOnce = async (): Promise<BatchResult> => {
    const started = now();
    const deadLetters: DeadLetter[] = [];
    let result: BatchResult;
    try {
      result = await database.withRelayTx(async (tx) => {
        deadLetters.length = 0;
        const rows = await store.claim(tx, batchSize);
        const published: string[] = [];
        const failures: { row: OutboxRow; code: string }[] = [];
        let valkeyDown = false;
        let deadlineHit = false;
        for (const row of rows) {
          if (now() - started >= batchDeadlineMs) {
            deadlineHit = true;
            break;
          }
          const outcome = await publishRow(row);
          if (outcome === VALKEY_DOWN) {
            valkeyDown = true;
            break;
          }
          if (outcome === undefined) published.push(row.id);
          else failures.push({ row, code: outcome });
        }
        if (published.length > 0) await store.markPublished(tx, published);
        let dead = 0;
        for (const { row, code } of failures) {
          const marked = await store.markFailed(
            tx,
            row.id,
            code,
            deadLetterAfter,
          );
          if (marked.dead) {
            dead += 1;
            deadLetters.push({
              outboxId: row.id,
              orgId: row.orgId,
              topic: row.topic,
              attempts: marked.attempts,
              lastError: code,
            });
          }
        }
        return {
          claimed: rows.length,
          published: published.length,
          failed: failures.length,
          dead,
          unavailable: valkeyDown,
          deadlineHit,
        };
      });
    } catch {
      // The transaction rolled back: nothing it did counts.
      unavailable("database");
      return {
        claimed: 0,
        published: 0,
        failed: 0,
        dead: 0,
        unavailable: true,
        deadlineHit: false,
      };
    }
    // Committed: only now are dead letters real.
    for (const fields of deadLetters) {
      logger.error({ ...fields }, "outbox.dead_letter");
    }
    if (result.unavailable) unavailable("valkey");
    else recovered();
    return result;
  };

  // The loop.
  let running: Promise<void> | undefined;
  let stopping = false;
  let wake: (() => void) | undefined;
  // stop() sets `stopping` while a batch is in flight.
  const isStopping = () => stopping;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        wake = undefined;
        resolve();
      }
      wake = done;
    });

  const loop = async () => {
    let failures = 0;
    while (!stopping) {
      // runOnce() never throws: every failure is unavailable: true.
      const result = await runOnce();
      if (isStopping()) break;
      if (result.unavailable) {
        failures += 1;
        logger.debug({ failures }, "outbox.batch_unavailable");
        await sleep(globalBackoffMs(failures, maxBackoffMs));
        continue;
      }
      failures = 0;
      if (result.claimed > 0) {
        logger.debug(
          {
            claimed: result.claimed,
            published: result.published,
            failed: result.failed,
            dead: result.dead,
          },
          "outbox.batch",
        );
      }
      // A full batch or a deadline means more may be due: go on at once.
      if (result.claimed < batchSize && !result.deadlineHit) {
        await sleep(idlePollMs);
      }
    }
  };

  return {
    runOnce,
    start() {
      if (running !== undefined) return;
      stopping = false;
      running = loop();
    },
    async stop() {
      stopping = true;
      wake?.();
      const current = running;
      running = undefined;
      await current;
    },
  };
}
