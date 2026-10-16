// What AuditService.record() accepts (P4-05, ADR 0055). Everything is
// checked before any database work, and an error names the field only:
// it never echoes the input (ADR 0045's rule for errors).
// - action and entity_type: dotted lower-case names (project.task.update).
// - before and after: JSON with no floats (money travels as strings), no
//   NUL (jsonb refuses it), well-formed strings, plain objects only, depth
//   <= 32 and <= 64 KiB of canonical JSON each. They carry the change and
//   nothing more: no secrets and no PII beyond it (ADR 0055).
// - origin: the request's correlation id, a host ip (no mask, no zone),
//   a canonical device uuid, geo as integer micro-degrees.
import { isIP } from "node:net";
import type { Geo } from "../../common/db/request-context.js";

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
  constructor(readonly field: AuditEventField) {
    super(`audit event refused: invalid ${field}`);
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

/** Where an event came from: the request context, or a caller's own. */
export interface AuditOriginInput {
  readonly correlationId: string;
  readonly ip?: string | undefined;
  readonly deviceId?: string | undefined;
  readonly geo?: Geo | undefined;
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
