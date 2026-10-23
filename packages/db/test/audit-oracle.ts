// An independent oracle for the audit hash (P4-05, ADR 0055): a small
// RFC 8785 serialiser for the values an audit row may hold (null, booleans,
// safe integers, strings, arrays, plain objects), written here without the
// canonicalize package, and node:crypto's SHA-256. The tests compare
// AuditService's hashes, and the rows Postgres stores, against it.
import { createHash } from "node:crypto";

/** RFC 8785 for the JSON subset an audit row holds; throws on anything else. */
export function oracleJcs(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("oracle: not a safe integer");
    return String(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(oracleJcs).join(",")}]`;
  if (typeof value === "object") {
    // Default sort compares UTF-16 code units, the order RFC 8785 requires.
    const keys = Object.keys(value).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${oracleJcs(Reflect.get(value, k))}`,
    );
    return `{${parts.join(",")}}`;
  }
  throw new Error("oracle: unsupported value");
}

/** sha256(prev ‖ utf8(JCS(row))), as ADR 0055 defines it. */
export function oracleHash(prev: Uint8Array, row: object): Buffer {
  return createHash("sha256")
    .update(prev)
    .update(Buffer.from(oracleJcs(row), "utf8"))
    .digest();
}

/** The hashed object for a row read back from Postgres (ADR 0055). */
export function oracleRow(db: {
  id: string;
  org_id: string;
  seq: string;
  hash_version: number;
  occurred_at: string;
  actor_type: string;
  actor_id: string | null;
  device_id: string | null;
  ip: string | null;
  geo: unknown;
  correlation_id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  before: unknown;
  after: unknown;
}): object {
  return {
    id: db.id,
    org_id: db.org_id,
    seq: db.seq,
    hash_version: db.hash_version,
    occurred_at: db.occurred_at,
    actor_type: db.actor_type,
    actor_id: db.actor_id,
    device_id: db.device_id,
    ip: db.ip,
    geo: db.geo,
    correlation_id: db.correlation_id,
    action: db.action,
    entity_type: db.entity_type,
    entity_id: db.entity_id,
    before: db.before,
    after: db.after,
  };
}

/** The 32 zero bytes the first row of every org's chain links to. */
export const ORACLE_GENESIS = new Uint8Array(32);
