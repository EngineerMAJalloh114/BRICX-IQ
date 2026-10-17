// drizzle-kit's entry (drizzle.config.ts): every table, and nothing else.
// Never export a pgSchema() from here (see namespace.ts).
import { sql } from "drizzle-orm";
import {
  bigint,
  check,
  customType,
  index,
  inet,
  integer,
  jsonb,
  smallint,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";
import { createdAt, id, orgId } from "./columns.js";
import { bricx } from "./namespace.js";

/** bytea as a Buffer (drizzle-orm 0.45.4 has no built-in bytea column). */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => "bytea",
});

/**
 * The audit log (P4-05, ADR 0055): one hash chain per org, append-only.
 * AuditService.record() writes it; `audit:verify` walks it. Every column
 * except prev_hash and hash is hashed; ADR 0055 pins each one's
 * serialisation. The migration appends `pnpm db:rls bricx.audit_events
 * org.audit` (UPDATE and DELETE revoked from bricx_app) and the
 * statement-level append-only triggers by hand.
 */
export const auditEvents = bricx.table(
  "audit_events",
  {
    /** UUIDv7 from record() (CLAUDE.md rule 6): it is hashed, so the API
     * always supplies it; uuidv7() is only the column helper's default. */
    id: id(),
    orgId: orgId(),
    /** 1, 2, 3, ... per org: the chain's order. */
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    hashVersion: smallint("hash_version").notNull(),
    /** From the injected Clock, at millisecond precision. */
    occurredAt: timestamp("occurred_at", {
      withTimezone: true,
      mode: "string",
    }).notNull(),
    actorType: text("actor_type").notNull(),
    actorId: uuid("actor_id"),
    deviceId: uuid("device_id"),
    /** A host address only (/32 or /128). */
    ip: inet("ip"),
    /** {"lat_e6": int, "lon_e6": int}: integer micro-degrees, never floats. */
    geo: jsonb("geo"),
    correlationId: text("correlation_id").notNull(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: uuid("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    prevHash: bytea("prev_hash").notNull(),
    hash: bytea("hash").notNull(),
  },
  (t) => [
    unique("audit_events_org_seq").on(t.orgId, t.seq),
    check("audit_events_seq", sql`${t.seq} >= 1`),
    check("audit_events_hash_version", sql`${t.hashVersion} >= 1`),
    check(
      "audit_events_occurred_at_ms",
      sql`${t.occurredAt} = date_trunc('milliseconds', ${t.occurredAt})`,
    ),
    check(
      "audit_events_actor",
      sql`${t.actorType} IN ('user', 'system') AND (${t.actorType} <> 'user' OR ${t.actorId} IS NOT NULL)`,
    ),
    check(
      "audit_events_ip_host",
      sql`masklen(${t.ip}) = CASE family(${t.ip}) WHEN 4 THEN 32 ELSE 128 END`,
    ),
    check(
      "audit_events_hash_length",
      sql`octet_length(${t.prevHash}) = 32 AND octet_length(${t.hash}) = 32`,
    ),
  ],
);

const timestamptz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: "string" });

/**
 * The transactional outbox (P4-06, ADR 0056). insertOutbox() (bricx_app)
 * writes id, org_id, topic and payload in the caller's transaction; the
 * worker's relay (bricx_relay) publishes pending rows to BullMQ with
 * jobId = id and updates only the delivery columns. Payloads carry ids,
 * never personal data. The migration appends enableOutboxRls() by hand.
 */
export const outbox = bricx.table(
  "outbox",
  {
    /** UUIDv7 from the API (insertOutbox() always supplies it). */
    id: id(),
    orgId: orgId(),
    /** A registered topic (@bricx/db/outbox), e.g. system.ping. */
    topic: text("topic").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: createdAt(),
    // Delivery columns: the only ones bricx_relay may UPDATE.
    publishedAt: timestamptz("published_at"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamptz("next_attempt_at").notNull().defaultNow(),
    /** A failure code (e.g. unknown_topic), never an error message. */
    lastError: text("last_error"),
    deadAt: timestamptz("dead_at"),
  },
  (t) => [
    check("outbox_topic", sql`${t.topic} ~ '^[a-z][a-z0-9_.]{0,62}$'`),
    check("outbox_attempts", sql`${t.attempts} >= 0`),
    check(
      "outbox_published_or_dead",
      sql`NOT (${t.publishedAt} IS NOT NULL AND ${t.deadAt} IS NOT NULL)`,
    ),
    check(
      "outbox_last_error_code",
      sql`${t.lastError} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
    // The relay's claim: pending rows, oldest first.
    index("outbox_pending")
      .on(t.createdAt, t.id)
      .where(sql`${t.publishedAt} IS NULL AND ${t.deadAt} IS NULL`),
  ],
);

/**
 * Idempotency keys (P4-07, ADR 0057, decision 5b). One row per
 * (org, user, route, key): the request's fingerprint, the declared
 * status, and after COMMIT the serialised response text with its
 * replayable headers (content-type, location, etag), kept for 24 h.
 * Stored responses are plaintext: no secrets in idempotent responses, at
 * most 256 KiB. Expired rows are reused in place; the purge is P13's. The
 * migration appends enableIdempotencyRls() by hand.
 */
export const idempotencyKeys = bricx.table(
  "idempotency_keys",
  {
    id: id(),
    orgId: orgId(),
    userId: uuid("user_id").notNull(),
    /** "METHOD /path" without a query string, e.g. "POST /v1/expenses". */
    route: text("route").notNull(),
    /** The client's Idempotency-Key: 1-255 of [A-Za-z0-9._~-]. */
    key: text("key").notNull(),
    /** SHA-256 of RFC 8785 canonical JSON of { body, query }. */
    requestHash: bytea("request_hash").notNull(),
    status: smallint("status").notNull(),
    /** The exact serialised body, sent verbatim on replay. */
    response: text("response"),
    /** {"content-type": ..., "location"?: ..., "etag"?: ...}. */
    headers: jsonb("headers"),
    createdAt: createdAt(),
    expiresAt: timestamptz("expires_at")
      .notNull()
      .default(sql`now() + make_interval(secs => 86400)`),
  },
  (t) => [
    unique("idempotency_keys_scope").on(t.orgId, t.userId, t.route, t.key),
    check("idempotency_keys_key", sql`${t.key} ~ '^[A-Za-z0-9._~-]{1,255}$'`),
    // Postgres bounds a repeat at 255, so the path length is its own term:
    // method (10) + space + "/" + 2047.
    check(
      "idempotency_keys_route",
      sql`${t.route} ~ '^[A-Z]{3,10} /[!"$->@-~]*$' AND octet_length(${t.route}) <= 2059`,
    ),
    check(
      "idempotency_keys_hash_length",
      sql`octet_length(${t.requestHash}) = 32`,
    ),
    check("idempotency_keys_status", sql`${t.status} BETWEEN 100 AND 599`),
    check(
      "idempotency_keys_response_size",
      sql`octet_length(${t.response}) <= 262144`,
    ),
    check(
      "idempotency_keys_complete",
      sql`(${t.response} IS NULL) = (${t.headers} IS NULL)`,
    ),
    check(
      "idempotency_keys_headers_object",
      sql`jsonb_typeof(${t.headers}) = 'object'`,
    ),
    check("idempotency_keys_expiry", sql`${t.expiresAt} > ${t.createdAt}`),
  ],
);

// new-module: tables (pnpm new-module adds an export above, P4-09)
