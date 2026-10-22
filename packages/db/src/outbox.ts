// The transactional outbox (P4-06, ADR 0056; CLAUDE.md rule 5). Side
// effects are written here, in the transaction of the change they belong
// to, and published to BullMQ by the worker's relay after COMMIT.
// - insertOutbox(tx, topic, payload, id): bricx_app, inside withTx(). The
//   org comes from the transaction (app.current_org()), never the caller.
//   bricx_app may only INSERT (id, org_id, topic, payload): no RETURNING,
//   no ON CONFLICT (condition 7).
// - claimOutboxBatch / markOutboxPublished / markOutboxFailed: the relay's
//   statements, run as bricx_relay inside withRelayTx().
// Every refusal is an OutboxError with a code; no message ever carries a
// topic, a key or a value. Payloads carry ids, never personal data.
import { sql } from "drizzle-orm";
import type { Tx } from "./tx.js";

/**
 * A topic's delivery options (P5-04, ADR 0065; an amendment to ADR 0056):
 * how often BullMQ retries the consumer's failure and how long it waits,
 * doubling from backoffMs and capped at maxBackoffMs (deliveryBackoffMs()).
 * The relay passes them to the add; the consumer's Worker applies the
 * capped strategy. A topic without them is delivered once (BullMQ's
 * default): a consumer failure stays failed for the job's retention.
 */
export interface OutboxDelivery {
  /** Attempts in all (1-100). */
  readonly attempts: number;
  /** The first retry's delay in ms (at least 1 s). */
  readonly backoffMs: number;
  /** The longest delay in ms (at least backoffMs, at most 1 h). */
  readonly maxBackoffMs: number;
}

/** One registered topic: its BullMQ queue and its payload limits. */
export interface OutboxTopic {
  /** The BullMQ queue the relay adds the job to. */
  readonly queue: string;
  /** The only top-level payload keys allowed. */
  readonly keys: readonly string[];
  /** Most UTF-8 bytes of the payload's JSON (at most MAX_PAYLOAD_BYTES). */
  readonly maxBytes: number;
  /** Retries at the consumer; absent: one attempt. */
  readonly delivery?: OutboxDelivery;
}

/** Most UTF-8 bytes of any payload's JSON. */
export const MAX_PAYLOAD_BYTES = 64 * 1024;
/** Most nested objects and arrays, the payload itself included. */
export const MAX_PAYLOAD_DEPTH = 32;

const topic = (entry: OutboxTopic): OutboxTopic =>
  Object.freeze({
    ...entry,
    keys: Object.freeze([...entry.keys]),
    ...(entry.delivery === undefined
      ? {}
      : { delivery: Object.freeze({ ...entry.delivery }) }),
  });

/**
 * The delay before attempt `attemptsMade + 1` of a topic with `delivery`:
 * backoffMs, doubling per attempt made, capped at maxBackoffMs. The
 * consumer's Worker registers it as BullMQ's "outbox" backoff strategy.
 */
export function deliveryBackoffMs(
  delivery: OutboxDelivery,
  attemptsMade: number,
): number {
  const exponent = Math.min(Math.max(attemptsMade, 1) - 1, 30);
  return Math.min(delivery.backoffMs * 2 ** exponent, delivery.maxBackoffMs);
}

/**
 * Every topic, frozen. A topic is added with its consumer (ADR 0056).
 * system.ping proves the pipeline end to end; its payload is {}.
 */
export const OUTBOX_TOPICS: Readonly<Record<string, OutboxTopic>> =
  Object.freeze({
    "system.ping": topic({ queue: "system", keys: [], maxBytes: 2 }),
    // The module template's (P4-09, ADR 0059): never written, because the
    // template is not registered in AppModule. A copy made by pnpm
    // new-module registers <module>.created the same way, with ids only.
    "template_items.created": topic({
      queue: "template_items",
      keys: ["id", "projectId"],
      maxBytes: 128,
    }),
    // P5-03 (ADR 0063): written by every session revoke, in the revoking
    // transaction; ids only. P5-04 (ADR 0065) consumes it in the worker
    // (the revocation keys in Valkey, then the Keycloak session ended) and
    // adds `cause` (self | device | admin) and the delivery options: 40
    // attempts, 1 s doubling to 60 s, about 40 min while Keycloak is down.
    "sessions.revoked": topic({
      queue: "sessions",
      keys: ["sessionId", "userId", "orgId", "keycloakSid", "cause"],
      maxBytes: 512,
      delivery: { attempts: 40, backoffMs: 1_000, maxBackoffMs: 60_000 },
    }),
    // P5-04 (ADR 0065): one per closed session, for the sync service to
    // drop the session's sync connection (consumed at P8-02; until then the
    // job waits in queue `sync`). Ids only, no Keycloak session id.
    "sync.revoke": topic({
      queue: "sync",
      keys: ["sessionId", "userId", "orgId"],
      maxBytes: 256,
    }),
    // P5-05 (phase ruling D5, ADR 0066): one per user whose effective keys
    // may have changed (a membership written, a role's keys edited: one
    // row per open member), in the writing transaction; the worker's MFA
    // consumer reads the truth back through app.mfa_state() and maps the
    // Keycloak realm role bricx-mfa. Same delivery as sessions.revoked.
    "users.mfa_check": topic({
      queue: "users",
      keys: ["userId"],
      maxBytes: 128,
      delivery: { attempts: 40, backoffMs: 1_000, maxBackoffMs: 60_000 },
    }),
    // new-module: OUTBOX_TOPICS (pnpm new-module adds an entry above, P4-09)
  });

// Untrusted names are looked up in a Map, never as object properties.
const topics: ReadonlyMap<string, OutboxTopic> = new Map(
  Object.entries(OUTBOX_TOPICS),
);

export type OutboxErrorCode =
  | "unknown_topic"
  | "invalid_payload"
  | "payload_too_large"
  | "invalid_id"
  | "invalid_error_code"
  | "no_tenant_context";

export class OutboxError extends Error {
  readonly code: OutboxErrorCode;

  constructor(code: OutboxErrorCode) {
    super(`outbox: ${code}`);
    this.code = code;
  }
}
Object.defineProperty(OutboxError.prototype, "name", { value: "OutboxError" });

/** The registry entry of `name`, or OutboxError unknown_topic. */
export function outboxTopic(name: unknown): OutboxTopic {
  const entry = typeof name === "string" ? topics.get(name) : undefined;
  if (entry === undefined) throw new OutboxError("unknown_topic");
  return entry;
}

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ANY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/** `id` if it is a canonical lower-case UUIDv7, else OutboxError invalid_id. */
export function validateOutboxId(id: unknown): string {
  if (typeof id !== "string" || !UUID_V7.test(id)) {
    throw new OutboxError("invalid_id");
  }
  return id;
}

const isText = (value: string): boolean =>
  !value.includes("\u0000") && value.isWellFormed();

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/**
 * The payload's JSON text, after checking it against `entry`: a plain
 * object whose top-level keys are registered; inside it only plain objects,
 * dense arrays, safe integers (no floats, no -0), booleans, null and
 * well-formed strings without NUL (jsonb refuses NUL and lone surrogates);
 * at most MAX_PAYLOAD_DEPTH containers deep and entry.maxBytes UTF-8 bytes.
 * The walk is iterative and bounded by the byte budget before anything is
 * serialised.
 */
export function validateOutboxPayload(
  entry: OutboxTopic,
  payload: unknown,
): string {
  const maxBytes = Math.min(entry.maxBytes, MAX_PAYLOAD_BYTES);
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    !isPlainObject(payload)
  ) {
    throw new OutboxError("invalid_payload");
  }
  const allowed = new Set(entry.keys);
  for (const key of Reflect.ownKeys(payload)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new OutboxError("invalid_payload");
    }
  }
  // Every node and every string unit costs at least one byte of JSON, so
  // a payload over the budget is refused before it is serialised.
  let budget = maxBytes;
  const spend = (units: number) => {
    budget -= units;
    if (budget < 0) throw new OutboxError("payload_too_large");
  };
  const stack: { value: unknown; depth: number }[] = [
    { value: payload, depth: 1 },
  ];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const { value, depth } = next;
    spend(1);
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) {
        throw new OutboxError("invalid_payload");
      }
      continue;
    }
    if (typeof value === "string") {
      spend(value.length);
      if (!isText(value)) throw new OutboxError("invalid_payload");
      continue;
    }
    if (typeof value !== "object" || depth > MAX_PAYLOAD_DEPTH) {
      throw new OutboxError("invalid_payload");
    }
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        throw new OutboxError("invalid_payload");
      }
      // Only the indexes and "length": no holes, no extra properties.
      if (Reflect.ownKeys(value).length !== value.length + 1) {
        throw new OutboxError("invalid_payload");
      }
      spend(value.length);
      for (let i = 0; i < value.length; i += 1) {
        if (!Object.hasOwn(value, i)) throw new OutboxError("invalid_payload");
        stack.push({ value: value[i], depth: depth + 1 });
      }
      continue;
    }
    if (!isPlainObject(value)) throw new OutboxError("invalid_payload");
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || !isText(key)) {
        throw new OutboxError("invalid_payload");
      }
      spend(key.length);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !descriptor.enumerable ||
        !("value" in descriptor)
      ) {
        throw new OutboxError("invalid_payload");
      }
      stack.push({ value: descriptor.value, depth: depth + 1 });
    }
  }
  const text = JSON.stringify(payload);
  if (new TextEncoder().encode(text).length > maxBytes) {
    throw new OutboxError("payload_too_large");
  }
  return text;
}

/**
 * Writes one outbox row in `tx` (a withTx() transaction as bricx_app): the
 * topic, payload and id are checked before any SQL; the org is the
 * transaction's (no tenant context: no_tenant_context). Commits or rolls
 * back with `tx`.
 */
export async function insertOutbox(
  tx: Tx,
  topicName: string,
  payload: unknown,
  id: string,
): Promise<void> {
  const entry = outboxTopic(topicName);
  const text = validateOutboxPayload(entry, payload);
  const outboxId = validateOutboxId(id);
  const who = await tx.execute<{ org: string | null }>(
    sql`SELECT app.current_org()::text AS org`,
  );
  const org = who.rows[0]?.org ?? null;
  if (org === null) throw new OutboxError("no_tenant_context");
  await tx.execute(
    sql`INSERT INTO bricx.outbox (id, org_id, topic, payload)
        VALUES (${outboxId}::uuid, ${org}::uuid, ${topicName}, ${text}::jsonb)`,
  );
}

/** A row the relay claimed. */
export interface OutboxRow {
  readonly id: string;
  readonly orgId: string;
  readonly topic: string;
  readonly payload: unknown;
  readonly attempts: number;
}

/** Most rows one claim may lock. */
export const MAX_CLAIM = 1000;

const checkCount = (what: string, n: number, max: number) => {
  if (!Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new RangeError(`${what}: out of range`);
  }
};

/**
 * Locks and returns up to `limit` pending, due rows, oldest first, skipping
 * rows another relay holds (FOR UPDATE SKIP LOCKED), so two relays never
 * publish the same batch. Times are the database's now().
 */
export async function claimOutboxBatch(
  tx: Tx,
  limit: number,
): Promise<OutboxRow[]> {
  checkCount("claimOutboxBatch limit", limit, MAX_CLAIM);
  const result = await tx.execute<{
    id: string;
    org_id: string;
    topic: string;
    payload: unknown;
    attempts: number;
  }>(
    sql`SELECT id::text, org_id::text, topic, payload, attempts
        FROM bricx.outbox
        WHERE published_at IS NULL AND dead_at IS NULL
          AND next_attempt_at <= now()
        ORDER BY created_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED`,
  );
  return result.rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    topic: r.topic,
    payload: r.payload,
    attempts: r.attempts,
  }));
}

/** Marks the given claimed rows published (now()). */
export async function markOutboxPublished(
  tx: Tx,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  checkCount("markOutboxPublished ids", ids.length, MAX_CLAIM);
  for (const id of ids) {
    if (!ANY_UUID.test(id)) throw new OutboxError("invalid_id");
  }
  // One bind parameter, a Postgres array literal of checked UUIDs (Drizzle
  // would expand a JavaScript array into one parameter per element).
  const literal = `{${ids.join(",")}}`;
  await tx.execute(
    sql`UPDATE bricx.outbox SET published_at = now()
        WHERE id = ANY(${literal}::uuid[])`,
  );
}

/**
 * A row-level failure of a claimed row: attempts + 1, last_error = `code`
 * (a code, never a message), next attempt after min(2^attempts s, 300 s);
 * dead (dead_at = now()) once attempts reaches `deadLetterAfter`.
 */
export async function markOutboxFailed(
  tx: Tx,
  id: string,
  code: string,
  deadLetterAfter: number,
): Promise<{ attempts: number; dead: boolean }> {
  if (!ANY_UUID.test(id)) throw new OutboxError("invalid_id");
  if (!ERROR_CODE.test(code)) throw new OutboxError("invalid_error_code");
  checkCount("markOutboxFailed deadLetterAfter", deadLetterAfter, MAX_CLAIM);
  const result = await tx.execute<{ attempts: number; dead: boolean }>(
    sql`UPDATE bricx.outbox
        SET attempts = attempts + 1,
            last_error = ${code},
            next_attempt_at = now()
              + make_interval(secs => least(power(2, attempts + 1), 300)),
            dead_at = CASE WHEN attempts + 1 >= ${deadLetterAfter}::integer
                           THEN now() END
        WHERE id = ${id}::uuid AND published_at IS NULL AND dead_at IS NULL
        RETURNING attempts, dead_at IS NOT NULL AS dead`,
  );
  const row = result.rows[0];
  if (row === undefined) throw new Error("markOutboxFailed: no pending row");
  return { attempts: row.attempts, dead: row.dead };
}
