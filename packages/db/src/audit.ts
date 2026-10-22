// The audit recorder (P4-05, ADR 0055; moved here from apps/api's audit
// module in P5-06, ADR 0067, owner condition 4: the chain logic lives in
// one place and nothing else computes it). recordAuditEvent() appends one
// event to the current org's hash chain, inside the caller's transaction
// (the API's TxRunner or withTx()), so the event commits or rolls back
// with the change it records:
//   1. Validate the event and its origin (no database work before this).
//   2. Read app.current_org() and app.current_user_id(): the tenant and the
//      actor come from the transaction, never from the caller.
//   3. pg_advisory_xact_lock(AUDIT_LOCK_NAMESPACE, hashtext(org)): one
//      writer per org chain until the transaction ends.
//   4. Refuse unless READ COMMITTED (P4-05 condition 4), read the chain
//      head and the ip in Postgres's inet::text form, insert seq + 1 with
//      hash = sha256(head hash ‖ JCS(row)).
// The lock is held until COMMIT, so the recorder is the last statement of
// the transaction (ADR 0055). Two callers: AuditService.record() in the
// API (actor `user`: app.current_user_id()) and the worker's expiry
// consumer (P5-06; actor `system`: actor_type 'system', actor_id NULL,
// the transaction's user being the grant's subject for RLS only). Both
// run as bricx_app, the role the table's INSERT policy covers; bricx_relay
// never writes the chain.
//
// What a caller records: action and entity_type are dotted lower-case
// names (project.task.update); before and after are JSON with no floats
// (money travels as strings), no NUL (jsonb refuses it), well-formed
// strings, plain objects only, depth <= 32 and <= 64 KiB of canonical
// JSON each, carrying the change and nothing more (no secrets, no PII
// beyond it); the origin is the request's correlation id, a host ip (no
// mask, no zone), a canonical device uuid, geo as integer micro-degrees.
// An error names the field only: it never echoes the input (ADR 0045).
//
// The hash: hash = sha256(prev_hash ‖ utf8(JCS(row))), JCS being RFC 8785
// (the canonicalize package, ADR 0017). `row` holds every hashed column
// under its column name, serialised as ADR 0055 pins it: uuids
// lower-case, seq a decimal string, hash_version a number, occurred_at
// RFC 3339 UTC with milliseconds and Z, ip in Postgres's inet::text form,
// geo {lat_e6, lon_e6} integers, absent values null. The first row of
// each org's chain links to 32 zero bytes.
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import canonicalize from "canonicalize";
import { sql } from "drizzle-orm";
import type { Tx } from "./database.js";
import { auditEvents } from "./schema/index.js";

// ---- Refusals: codes, never values.
/** record() or verify ran without app.org_id and app.user_id (withTx sets them). */
export class AuditContextError extends Error {
  readonly code = "audit.no_tenant_context";
  constructor() {
    super("audit refused: no tenant context");
  }
}
Object.defineProperty(AuditContextError.prototype, "name", {
  value: "AuditContextError",
});

/**
 * record() ran in a REPEATABLE READ or SERIALIZABLE transaction (condition
 * 4). Its snapshot can predate the lock, so it would read a stale chain
 * head; only READ COMMITTED sees the head the lock's previous holder wrote.
 */
export class AuditIsolationError extends Error {
  readonly code = "audit.isolation_not_read_committed";
  constructor() {
    super("audit refused: the transaction is not READ COMMITTED");
  }
}
Object.defineProperty(AuditIsolationError.prototype, "name", {
  value: "AuditIsolationError",
});

// ---- The event and its origin.
export const MAX_JSON_BYTES = 65_536;
export const MAX_JSON_DEPTH = 32;
const MAX_ACTION_LENGTH = 128;
const MAX_ENTITY_TYPE_LENGTH = 64;
const MAX_IP_LENGTH = 64;
const MAX_LAT_E6 = 90_000_000;
const MAX_LON_E6 = 180_000_000;

const ACTION = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,5}$/;
const ENTITY_TYPE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){1,3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// The x-request-id rule (request-id.ts).
const CORRELATION_ID = /^[A-Za-z0-9._-]{1,128}$/;
const NUL = String.fromCharCode(0);

export type AuditEventField =
  | "event"
  | "action"
  | "entityType"
  | "entityId"
  | "before"
  | "after"
  | "origin"
  | "correlationId"
  | "ip"
  | "deviceId"
  | "geo";

/** A refused event or origin. The message names the field, never a value. */
export class AuditEventError extends Error {
  readonly code = "audit.invalid_event";
  readonly field: AuditEventField;
  // A plain field, not a parameter property: the packages ship erasable
  // syntax only (Node strips their types natively; see apps/api's register.ts).
  constructor(field: AuditEventField) {
    super(`audit event refused: invalid ${field}`);
    this.field = field;
  }
}
Object.defineProperty(AuditEventError.prototype, "name", {
  value: "AuditEventError",
});

/** What a caller records: the change, never who or where (record() adds those). */
export interface AuditEventInput {
  readonly action: string;
  readonly entityType: string;
  readonly entityId?: string | undefined;
  readonly before?: unknown;
  readonly after?: unknown;
}

export interface ValidAuditEvent {
  readonly action: string;
  readonly entityType: string;
  readonly entityId: string | null;
  /** JSON, or null when absent. */
  readonly before: unknown;
  readonly after: unknown;
}

/** A location as the request context carries it: integer micro-degrees. */
export interface AuditGeoInput {
  readonly latE6: number;
  readonly lonE6: number;
}

/** Where an event came from: the request context, or a caller's own. */
export interface AuditOriginInput {
  readonly correlationId: string;
  readonly ip?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly geo?: AuditGeoInput | undefined;
}

export interface AuditGeo {
  readonly lat_e6: number;
  readonly lon_e6: number;
}

export interface ValidAuditOrigin {
  readonly correlationId: string;
  readonly ip: string | null;
  readonly deviceId: string | null;
  readonly geo: AuditGeo | null;
}

const EVENT_KEYS = new Set([
  "action",
  "entityType",
  "entityId",
  "before",
  "after",
]);
const ORIGIN_KEYS = new Set(["correlationId", "ip", "deviceId", "geo"]);
const GEO_KEYS = ["latE6", "lonE6"];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPlainObject = (value: object): boolean => {
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const hasOnly = (value: object, allowed: ReadonlySet<string>): boolean =>
  Object.getOwnPropertySymbols(value).length === 0 &&
  Object.keys(value).every((key) => allowed.has(key));

const goodString = (value: string): boolean =>
  value.isWellFormed() && !value.includes(NUL);

/**
 * True when `root` is JSON an audit row may hold. Walks iteratively with a
 * byte budget (every value costs at least one canonical byte, every string
 * at least its length), so a huge or cyclic input stops early; then
 * measures the canonical form exactly.
 */
export function isAuditJson(root: unknown): boolean {
  let budget = MAX_JSON_BYTES;
  const stack: { value: unknown; depth: number }[] = [
    { value: root, depth: 1 },
  ];
  for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
    const { value, depth } = top;
    budget -= 1;
    if (budget < 0 || depth > MAX_JSON_DEPTH) return false;
    if (value === null || typeof value === "boolean") continue;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value)) return false;
      continue;
    }
    if (typeof value === "string") {
      budget -= value.length;
      if (budget < 0 || !goodString(value)) return false;
      continue;
    }
    if (typeof value !== "object") return false;
    if (Array.isArray(value)) {
      if (value.length > budget) return false;
      for (let i = 0; i < value.length; i += 1) {
        // A hole or undefined has no JSON form.
        if (!(i in value)) return false;
        stack.push({ value: value[i], depth: depth + 1 });
      }
      continue;
    }
    if (
      !isPlainObject(value) ||
      Object.getOwnPropertySymbols(value).length > 0
    ) {
      return false;
    }
    const keys = Object.keys(value);
    if (keys.length > budget) return false;
    for (const key of keys) {
      budget -= key.length;
      if (budget < 0 || !goodString(key)) return false;
      stack.push({ value: Reflect.get(value, key), depth: depth + 1 });
    }
  }
  // The walk proved it is plain JSON; JSON.stringify sizes the same bytes
  // as the canonical form (only key order differs).
  return Buffer.byteLength(JSON.stringify(root), "utf8") <= MAX_JSON_BYTES;
}

const optionalJson = (value: unknown, field: "before" | "after"): unknown => {
  if (value === undefined || value === null) return null;
  if (!isAuditJson(value)) throw new AuditEventError(field);
  return value;
};

/** A frozen copy of a valid event, or AuditEventError naming the field. */
export function validateAuditEvent(input: unknown): ValidAuditEvent {
  if (!isRecord(input) || !hasOnly(input, EVENT_KEYS)) {
    throw new AuditEventError("event");
  }
  const { action, entityType, entityId } = input;
  if (
    typeof action !== "string" ||
    action.length > MAX_ACTION_LENGTH ||
    !ACTION.test(action)
  ) {
    throw new AuditEventError("action");
  }
  if (
    typeof entityType !== "string" ||
    entityType.length > MAX_ENTITY_TYPE_LENGTH ||
    !ENTITY_TYPE.test(entityType)
  ) {
    throw new AuditEventError("entityType");
  }
  if (
    entityId !== undefined &&
    (typeof entityId !== "string" || !UUID.test(entityId))
  ) {
    throw new AuditEventError("entityId");
  }
  return Object.freeze({
    action,
    entityType,
    entityId: entityId ?? null,
    before: optionalJson(input.before, "before"),
    after: optionalJson(input.after, "after"),
  });
}

function validGeo(geo: unknown): AuditGeo | null {
  if (geo === undefined) return null;
  if (
    !isRecord(geo) ||
    Object.keys(geo).length !== GEO_KEYS.length ||
    !hasOnly(geo, new Set(GEO_KEYS))
  ) {
    throw new AuditEventError("geo");
  }
  const { latE6, lonE6 } = geo;
  if (
    typeof latE6 !== "number" ||
    typeof lonE6 !== "number" ||
    !Number.isSafeInteger(latE6) ||
    !Number.isSafeInteger(lonE6) ||
    Math.abs(latE6) > MAX_LAT_E6 ||
    Math.abs(lonE6) > MAX_LON_E6
  ) {
    throw new AuditEventError("geo");
  }
  return Object.freeze({ lat_e6: latE6, lon_e6: lonE6 });
}

/** A frozen copy of a valid origin, or AuditEventError naming the field. */
export function validateOrigin(input: unknown): ValidAuditOrigin {
  if (!isRecord(input) || !hasOnly(input, ORIGIN_KEYS)) {
    throw new AuditEventError("origin");
  }
  const { correlationId, ip, deviceId } = input;
  if (
    typeof correlationId !== "string" ||
    !CORRELATION_ID.test(correlationId)
  ) {
    throw new AuditEventError("correlationId");
  }
  if (
    ip !== undefined &&
    (typeof ip !== "string" ||
      ip.length > MAX_IP_LENGTH ||
      ip.includes("%") ||
      isIP(ip) === 0)
  ) {
    throw new AuditEventError("ip");
  }
  if (
    deviceId !== undefined &&
    (typeof deviceId !== "string" || !UUID.test(deviceId))
  ) {
    throw new AuditEventError("deviceId");
  }
  return Object.freeze({
    correlationId,
    ip: ip ?? null,
    deviceId: deviceId ?? null,
    geo: validGeo(input.geo),
  });
}

// ---- The hash.
/** Every hashed column (all but prev_hash and hash), in table order. */
export const HASHED_COLUMNS = Object.freeze([
  "id",
  "org_id",
  "seq",
  "hash_version",
  "occurred_at",
  "actor_type",
  "actor_id",
  "device_id",
  "ip",
  "geo",
  "correlation_id",
  "action",
  "entity_type",
  "entity_id",
  "before",
  "after",
] as const);

export type HashedColumn = (typeof HASHED_COLUMNS)[number];

/** A row's hashed columns, as written or as read back from Postgres. */
export type HashedRow = Readonly<Record<HashedColumn, unknown>>;

/** The version record() writes. A new canonical form gets a new number. */
export const HASH_VERSION = 1;

/** Versions audit:verify can check; any other is unknown_hash_version. */
export const KNOWN_HASH_VERSIONS: readonly number[] = Object.freeze([1]);

/** The link of each org's first row: 32 zero bytes (a fresh copy). */
export function genesisHash(): Buffer {
  return Buffer.alloc(32);
}

/** Exactly the hashed columns of `row`, nothing else. */
export function hashedObject(row: HashedRow): Record<string, unknown> {
  return Object.fromEntries(
    HASHED_COLUMNS.map((column) => [column, row[column]]),
  );
}

/** sha256(prev ‖ utf8(JCS(hashed columns of row))), 32 bytes. */
export function auditHash(prev: Uint8Array, row: HashedRow): Buffer {
  const text = canonicalize(hashedObject(row));
  if (text === undefined) throw new Error("audit hash: row has no JSON form");
  return createHash("sha256").update(prev).update(text, "utf8").digest();
}

/**
 * The first key of the two-key advisory lock ("AUDT"): its key space never
 * overlaps the migrator's one-key lock, and P9's journal chain takes its
 * own namespace.
 */
export const AUDIT_LOCK_NAMESPACE = 0x41_55_44_54;

/** The latest instant toISOString() writes as YYYY-MM-DDTHH:MM:SS.sssZ. */
const MAX_ISO_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

export interface RecordedAuditEvent {
  readonly id: string;
  readonly seq: string;
  /** The row's hash, lower-case hex. */
  readonly hash: string;
}

/**
 * Who the event is attributed to: `user` is the transaction's
 * app.current_user_id() (the API); `system` is a job with no acting
 * person (actor_id NULL; the worker's expiry consumer, P5-06).
 */
export type AuditActor = "user" | "system";

export interface AuditRecorderOptions {
  /** The instant written as occurred_at (the injected Clock, CLAUDE.md rule 7). */
  readonly clock: { now(): number };
  /** The event's id (a UUIDv7 generator on the same clock). */
  readonly ids: { next(): string };
  /** `user` unless said. */
  readonly actor?: AuditActor | undefined;
}

/**
 * Appends `event` to the org's chain in `tx`, where app.org_id and
 * app.user_id are set (withTx()); AuditContextError otherwise.
 */
export async function recordAuditEvent(
  tx: Tx,
  options: AuditRecorderOptions,
  event: AuditEventInput,
  origin: AuditOriginInput,
): Promise<RecordedAuditEvent> {
  const valid = validateAuditEvent(event);
  const from = validateOrigin(origin);
  const actorType: AuditActor = options.actor ?? "user";
  const ms = options.clock.now();
  if (!Number.isSafeInteger(ms) || ms < 0 || ms > MAX_ISO_MS) {
    throw new Error("audit: the clock is out of range");
  }

  const who = await tx.execute<{ org: string | null; actor: string | null }>(
    sql`SELECT app.current_org()::text AS org, app.current_user_id()::text AS actor`,
  );
  const org = who.rows[0]?.org ?? null;
  const actor = who.rows[0]?.actor ?? null;
  if (org === null || actor === null) throw new AuditContextError();
  const actorId = actorType === "user" ? actor : null;

  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(${AUDIT_LOCK_NAMESPACE}::integer, hashtext(${org}))`,
  );
  const state = await tx.execute<{
    isolation: string;
    seq: string | null;
    hash: Buffer | null;
    ip: string | null;
  }>(
    sql`SELECT current_setting('transaction_isolation') AS isolation,
               head.seq::text AS seq, head.hash, ${from.ip}::inet::text AS ip
        FROM (SELECT 1) AS one
        LEFT JOIN LATERAL (
          SELECT seq, hash FROM bricx.audit_events
          WHERE org_id = ${org}::uuid ORDER BY seq DESC LIMIT 1
        ) AS head ON true`,
  );
  const now = state.rows[0];
  if (now?.isolation !== "read committed") throw new AuditIsolationError();
  const prev = now.hash ?? genesisHash();
  const seq = now.seq === null ? "1" : String(BigInt(now.seq) + 1n);

  const id = options.ids.next();
  const occurredAt = new Date(ms).toISOString();
  const row: HashedRow = {
    id,
    org_id: org,
    seq,
    hash_version: HASH_VERSION,
    occurred_at: occurredAt,
    actor_type: actorType,
    actor_id: actorId,
    device_id: from.deviceId,
    ip: now.ip,
    geo: from.geo,
    correlation_id: from.correlationId,
    action: valid.action,
    entity_type: valid.entityType,
    entity_id: valid.entityId,
    before: valid.before,
    after: valid.after,
  };
  const hash = auditHash(prev, row);
  await tx.insert(auditEvents).values({
    id,
    orgId: org,
    seq: BigInt(seq),
    hashVersion: HASH_VERSION,
    occurredAt,
    actorType,
    actorId,
    deviceId: from.deviceId,
    ip: now.ip,
    geo: from.geo,
    correlationId: from.correlationId,
    action: valid.action,
    entityType: valid.entityType,
    entityId: valid.entityId,
    before: valid.before,
    after: valid.after,
    prevHash: prev,
    hash,
  });
  return { id, seq, hash: hash.toString("hex") };
}
