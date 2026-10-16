// The audit hash (P4-05, ADR 0055):
//   hash = sha256(prev_hash ‖ utf8(JCS(row)))
// JCS is RFC 8785 (the canonicalize package, ADR 0017). `row` holds every
// hashed column under its column name, serialised as ADR 0055 pins it:
// uuids lower-case, seq a decimal string, hash_version a number,
// occurred_at RFC 3339 UTC with milliseconds and Z, ip in Postgres's
// inet::text form, geo {lat_e6, lon_e6} integers, absent values null.
// The first row of each org's chain links to 32 zero bytes.
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";

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
