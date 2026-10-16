// The idempotency-key store (P4-07, ADR 0057, decision 5b). A route marked
// @Idempotent() in the API claims (route, key) as the first statement of
// its transaction and stores the serialised response in the same
// transaction, so a key exists only with the write it answers for.
// - claimIdempotencyKey(tx, claim): INSERT ... ON CONFLICT DO UPDATE (an
//   expired row is reused in place) RETURNING id. A concurrent duplicate
//   waits on the unique index until the first transaction ends, then
//   reads the committed answer. The org and user come from the
//   transaction (app.current_org(), app.current_user_id()), never from
//   the caller; outside a tenant context nothing is written.
// - storeIdempotencyResponse(tx, id, body, headers): completes the row,
//   before COMMIT. A body over MAX_RESPONSE_BYTES is refused, so the
//   transaction rolls back and nothing is written.
// Every refusal is an IdempotencyError with a code; no message ever
// carries a key, a route or a body. The statements do not judge a reused
// key: the caller compares the stored fingerprint.
import { sql } from "drizzle-orm";
import type { Tx } from "./tx.js";

/** The client's Idempotency-Key: 1-255 characters of RFC 3986 unreserved. */
export const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._~-]{1,255}$/;
/**
 * "METHOD /path": an upper-case method, one space, a path of printable
 * ASCII without "?" or "#" (no query string, no fragment).
 */
export const IDEMPOTENCY_ROUTE_PATTERN = /^[A-Z]{3,10} \/[!"$->@-~]{0,2047}$/;
/** How long a stored answer is replayed: 24 h (owner condition 6). */
export const IDEMPOTENCY_TTL_SECONDS = 86_400;
/** SHA-256 of the canonical request. */
export const REQUEST_HASH_BYTES = 32;
/** Most UTF-8 bytes of a stored response body: 256 KiB. */
export const MAX_RESPONSE_BYTES = 262_144;
/** The only response headers stored and replayed (owner condition 1). */
export const REPLAY_HEADERS = Object.freeze([
  "content-type",
  "location",
  "etag",
] as const);
export type ReplayHeader = (typeof REPLAY_HEADERS)[number];

export type IdempotencyErrorCode =
  | "invalid_key"
  | "invalid_route"
  | "invalid_hash"
  | "invalid_status"
  | "invalid_id"
  | "invalid_headers"
  | "response_too_large"
  | "no_tenant_context"
  | "incomplete_row";

export class IdempotencyError extends Error {
  readonly code: IdempotencyErrorCode;

  constructor(code: IdempotencyErrorCode) {
    super(`idempotency: ${code}`);
    this.code = code;
  }
}
Object.defineProperty(IdempotencyError.prototype, "name", {
  value: "IdempotencyError",
});

/** `value` if it is a valid Idempotency-Key, else IdempotencyError invalid_key. */
export function validateIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(value)) {
    throw new IdempotencyError("invalid_key");
  }
  return value;
}

const ANY_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]{0,1024}$/;
const replayHeaders: ReadonlySet<string> = new Set(REPLAY_HEADERS);

export interface IdempotencyClaim {
  /** "METHOD /path" (IDEMPOTENCY_ROUTE_PATTERN). */
  readonly route: string;
  readonly key: string;
  /** SHA-256 of the canonical request (REQUEST_HASH_BYTES). */
  readonly requestHash: Buffer;
  /** The status the route answers with on success (100-599). */
  readonly status: number;
}

/** A committed answer, as stored. */
export interface StoredResponse {
  readonly requestHash: Buffer;
  readonly status: number;
  /** The exact serialised body. */
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type ClaimResult =
  | { readonly claimed: true; readonly id: string }
  | { readonly claimed: false; readonly stored: StoredResponse };

/** The claim after validation: every refusal before any SQL. */
function validateClaim(claim: IdempotencyClaim): IdempotencyClaim {
  const key = validateIdempotencyKey(claim.key);
  const { route, requestHash, status } = claim;
  if (typeof route !== "string" || !IDEMPOTENCY_ROUTE_PATTERN.test(route)) {
    throw new IdempotencyError("invalid_route");
  }
  if (
    !Buffer.isBuffer(requestHash) ||
    requestHash.length !== REQUEST_HASH_BYTES
  ) {
    throw new IdempotencyError("invalid_hash");
  }
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new IdempotencyError("invalid_status");
  }
  return { route, key, requestHash, status };
}

type ClaimRow = {
  has_context: boolean;
  id: string | null;
};

type StoredRow = {
  request_hash: Buffer;
  status: number;
  response: string | null;
  headers: Record<string, string> | null;
};

/**
 * Claims (route, key) for the transaction's org and user. The first
 * claim, or a claim on an expired row, inserts (or resets) the row and
 * returns `{ claimed: true, id }`; the caller must complete it with
 * storeIdempotencyResponse() before COMMIT. Any other claim returns the
 * committed answer as `{ claimed: false, stored }`; a concurrent claim
 * waits for the first transaction to end. Refusals before any SQL:
 * invalid_key, invalid_route, invalid_hash, invalid_status; outside a
 * tenant context: no_tenant_context, and nothing is written.
 */
export async function claimIdempotencyKey(
  tx: Tx,
  claim: IdempotencyClaim,
): Promise<ClaimResult> {
  const { route, key, requestHash, status } = validateClaim(claim);
  const ttl = String(IDEMPOTENCY_TTL_SECONDS);
  // One statement: the tenant check, the insert-or-reset, and whether a
  // row was claimed. The INSERT selects from `ctx`, so without a tenant
  // context it inserts nothing (and RLS would refuse it anyway).
  const claimed = await tx.execute<ClaimRow>(sql`
    WITH ctx AS (
      SELECT app.current_org() AS org, app.current_user_id() AS usr
    ),
    ins AS (
      INSERT INTO bricx.idempotency_keys
        (org_id, user_id, route, key, request_hash, status, expires_at)
      SELECT org, usr, ${route}, ${key}, ${requestHash}, ${status}::smallint,
             now() + make_interval(secs => ${ttl}::int)
      FROM ctx WHERE org IS NOT NULL AND usr IS NOT NULL
      ON CONFLICT ON CONSTRAINT idempotency_keys_scope DO UPDATE
        SET id = uuidv7(),
            request_hash = EXCLUDED.request_hash,
            status = EXCLUDED.status,
            response = NULL,
            headers = NULL,
            created_at = now(),
            expires_at = EXCLUDED.expires_at
        WHERE bricx.idempotency_keys.expires_at <= now()
      RETURNING id
    )
    SELECT (SELECT org IS NOT NULL AND usr IS NOT NULL FROM ctx) AS has_context,
           (SELECT id::text FROM ins) AS id`);
  const row = claimed.rows[0];
  if (row === undefined || !row.has_context) {
    throw new IdempotencyError("no_tenant_context");
  }
  if (row.id !== null) return { claimed: true, id: row.id };
  // The row exists and is live: read the committed answer (RLS scopes
  // it to this org and user).
  const stored = await tx.execute<StoredRow>(sql`
    SELECT request_hash, status, response, headers
    FROM bricx.idempotency_keys
    WHERE route = ${route} AND key = ${key}`);
  const found = stored.rows[0];
  if (
    found === undefined ||
    found.response === null ||
    found.headers === null
  ) {
    throw new IdempotencyError("incomplete_row");
  }
  return {
    claimed: false,
    stored: {
      requestHash: found.request_hash,
      status: found.status,
      body: found.response,
      headers: found.headers,
    },
  };
}

/** The headers after validation: allow-listed names, header-safe strings. */
function validateHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const copy: Record<string, string> = {};
  for (const name of Reflect.ownKeys(headers)) {
    const value: unknown = Reflect.get(headers, name);
    if (
      typeof name !== "string" ||
      !replayHeaders.has(name) ||
      typeof value !== "string" ||
      !HEADER_VALUE.test(value)
    ) {
      throw new IdempotencyError("invalid_headers");
    }
    copy[name] = value;
  }
  return copy;
}

/**
 * Completes the claimed row `id` with the serialised `body` and its
 * replayable `headers`, in the same transaction as the claim. Refusals
 * before any SQL: invalid_id, response_too_large (UTF-8 bytes over
 * MAX_RESPONSE_BYTES), invalid_headers (a name outside REPLAY_HEADERS, a
 * non-string, or a value that is not header-safe). A row this
 * transaction cannot see (another user's, or none) is invalid_id.
 */
export async function storeIdempotencyResponse(
  tx: Tx,
  id: string,
  body: string,
  headers: Readonly<Record<string, string>>,
): Promise<void> {
  if (typeof id !== "string" || !ANY_UUID.test(id)) {
    throw new IdempotencyError("invalid_id");
  }
  if (
    typeof body !== "string" ||
    Buffer.byteLength(body) > MAX_RESPONSE_BYTES
  ) {
    throw new IdempotencyError("response_too_large");
  }
  const safe = validateHeaders(headers);
  const result = await tx.execute(sql`
    UPDATE bricx.idempotency_keys
    SET response = ${body}, headers = ${JSON.stringify(safe)}::jsonb
    WHERE id = ${id}::uuid`);
  if (result.rowCount !== 1) throw new IdempotencyError("invalid_id");
}
