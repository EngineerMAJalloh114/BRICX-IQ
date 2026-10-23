// Temporary elevations, the worker's side (P5-06, D-G, owner conditions 3
// and 4, ADR 0067). The API grants, lists and revokes through its own
// org-scoped reads (apps/api access-grants module); the worker's expiry
// consumer uses the two helpers here:
// - accessGrantsDue(tx, limit): the 5-minute sweep's cross-org read,
//   app.access_grants_due(), a SECURITY DEFINER function only bricx_relay
//   may execute, inside withRelayTx(): open grants past expires_at, oldest
//   first. It writes nothing.
// - endAccessGrantsOf(tx, orgId, userId, by, now, projectId?): inside the
//   API's withTx() as bricx_app (P5-07, ROADMAP Also from the PR #71
//   review, rule 13): the memberships module ends a removed member's open
//   grants through here instead of writing this table itself.
// - expireAccessGrant(tx, grantId): inside withTx() as bricx_app in the
//   grant's org. Sets expired_at = now() (the database clock) on an open
//   grant past expires_at and returns the row before and after; otherwise
//   answers the row's state (pending, open, revoked, expired) and changes
//   nothing; an unseen row (another org, or none) is undefined. The caller
//   records the audit event and the users.mfa_check row in the same
//   transaction when `changed` is true, and throws on pending/open so the
//   job is retried (condition 3: an early job never completes as a no-op).
// Ids are checked before any SQL; an error never carries a value; the
// reason is never read here (it is audited at grant time, never logged).
import { sql } from "drizzle-orm";
import type { Tx } from "./tx.js";

export type AccessGrantErrorCode =
  "invalid_id" | "invalid_instant" | "invalid_result";

export class AccessGrantError extends Error {
  readonly code: AccessGrantErrorCode;

  constructor(code: AccessGrantErrorCode) {
    super(`access grant: ${code}`);
    this.code = code;
  }
}
Object.defineProperty(AccessGrantError.prototype, "name", {
  value: "AccessGrantError",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Most rows one sweep read may return (the function caps it too). */
export const MAX_DUE = 1000;

/** A grant the sweep found due. */
export interface DueAccessGrant {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
}

/** The state of a grant row as expireAccessGrant() found or left it. */
export type AccessGrantState = "pending" | "open" | "revoked" | "expired";

/** A grant's audited columns (the reason stays out: audited at grant, never re-read). */
export interface ExpiredAccessGrant {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly permission: string;
  readonly scopeId: string | null;
  readonly grantedBy: string;
  readonly startsAt: string;
  readonly expiresAt: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
  readonly expiredAt: string | null;
}

export interface ExpireOutcome {
  readonly state: AccessGrantState;
  /** True when this call set expired_at. */
  readonly changed: boolean;
  /** The row after the call (before it when nothing changed). */
  readonly grant: ExpiredAccessGrant;
}

const checkId = (id: unknown): string => {
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new AccessGrantError("invalid_id");
  }
  return id;
};

const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";

type GrantRow = Record<string, unknown> & {
  readonly id: unknown;
  readonly org_id: unknown;
  readonly user_id: unknown;
  readonly permission: unknown;
  readonly scope_id: unknown;
  readonly granted_by: unknown;
  readonly starts_at: unknown;
  readonly expires_at: unknown;
  readonly revoked_at: unknown;
  readonly revoked_by: unknown;
  readonly expired_at: unknown;
  readonly state: unknown;
};

const STATES: readonly string[] = ["pending", "open", "revoked", "expired"];

/** The row as ExpiredAccessGrant and its state, or invalid_result. */
function grantOf(row: GrantRow | undefined): {
  grant: ExpiredAccessGrant;
  state: AccessGrantState;
} {
  if (
    row === undefined ||
    !isString(row.id) ||
    !isString(row.org_id) ||
    !isString(row.user_id) ||
    !isString(row.permission) ||
    !isNullableString(row.scope_id) ||
    !isString(row.granted_by) ||
    !isString(row.starts_at) ||
    !isString(row.expires_at) ||
    !isNullableString(row.revoked_at) ||
    !isNullableString(row.revoked_by) ||
    !isNullableString(row.expired_at) ||
    !isString(row.state) ||
    !STATES.includes(row.state)
  ) {
    throw new AccessGrantError("invalid_result");
  }
  const state: AccessGrantState =
    row.state === "pending"
      ? "pending"
      : row.state === "open"
        ? "open"
        : row.state === "revoked"
          ? "revoked"
          : "expired";
  return {
    state,
    grant: {
      id: row.id,
      orgId: row.org_id,
      userId: row.user_id,
      permission: row.permission,
      scopeId: row.scope_id,
      grantedBy: row.granted_by,
      startsAt: row.starts_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      revokedBy: row.revoked_by,
      expiredAt: row.expired_at,
    },
  };
}

// Every instant as toISOString() writes it (UTC, milliseconds, Z), so the
// audit event's before/after carry ADR 0055's form. The column is a
// quoted identifier, never raw text.
const ISO = (column: string) =>
  sql`to_char(${sql.identifier(column)} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/**
 * Up to `limit` open grants past expires_at, in every org, oldest expiry
 * first: app.access_grants_due() through the relay's transaction.
 */
export async function accessGrantsDue(
  tx: Tx,
  limit: number,
): Promise<DueAccessGrant[]> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_DUE) {
    throw new RangeError("accessGrantsDue limit: out of range");
  }
  const result = await tx.execute<{
    id: unknown;
    org_id: unknown;
    user_id: unknown;
  }>(
    sql`SELECT id::text, org_id::text, user_id::text
        FROM app.access_grants_due(${limit}::integer)`,
  );
  return result.rows.map((r) => {
    if (!isString(r.id) || !isString(r.org_id) || !isString(r.user_id)) {
      throw new AccessGrantError("invalid_result");
    }
    return { id: r.id, orgId: r.org_id, userId: r.user_id };
  });
}

/**
 * Expires `grantId` when it is open and past expires_at (the database
 * clock), in `tx` (withTx() as bricx_app in the grant's org). The answer
 * carries the row's state and whether this call changed it; undefined
 * when the transaction sees no such row.
 */
export async function expireAccessGrant(
  tx: Tx,
  grantId: string,
): Promise<ExpireOutcome | undefined> {
  const id = checkId(grantId);
  const columns = sql`id::text, org_id::text, user_id::text, permission, scope_id::text,
       granted_by::text, ${ISO("starts_at")} AS starts_at, ${ISO("expires_at")} AS expires_at,
       ${ISO("revoked_at")} AS revoked_at, revoked_by::text, ${ISO("expired_at")} AS expired_at`;
  const updated = await tx.execute<GrantRow>(
    sql`UPDATE bricx.access_grants SET expired_at = now()
        WHERE id = ${id}::uuid AND revoked_at IS NULL AND expired_at IS NULL
          AND expires_at <= now()
        RETURNING ${columns}, 'expired'::text AS state`,
  );
  if (updated.rows.length === 1) {
    return { ...grantOf(updated.rows[0]), changed: true };
  }
  const found = await tx.execute<GrantRow>(
    sql`SELECT ${columns},
          CASE WHEN revoked_at IS NOT NULL THEN 'revoked'
               WHEN expired_at IS NOT NULL THEN 'expired'
               WHEN starts_at > now() THEN 'pending'
               ELSE 'open' END AS state
        FROM bricx.access_grants WHERE id = ${id}::uuid`,
  );
  if (found.rows.length === 0) return undefined;
  return { ...grantOf(found.rows[0]), changed: false };
}

/** An access grant endAccessGrantsOf() ended. */
export interface EndedGrant {
  readonly id: string;
  readonly revokedAt: string | null;
  readonly revokedBy: string | null;
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Ends `userId`'s open access grants in `orgId` (revoked_at = `now`,
 * revoked_by = `by`): org-wide, or only those scoped to `projectId`.
 * Open = not revoked, not expired and expires_at after `now` (a pending
 * one included; an elapsed one is the expiry's to record). Oldest id
 * first. Ids and the instant (toISOString() form) are checked before any
 * SQL.
 */
export async function endAccessGrantsOf(
  tx: Tx,
  orgId: string,
  userId: string,
  by: string,
  now: string,
  projectId?: string,
): Promise<readonly EndedGrant[]> {
  const org = checkId(orgId);
  const user = checkId(userId);
  const actor = checkId(by);
  const project = projectId === undefined ? undefined : checkId(projectId);
  if (typeof now !== "string" || !INSTANT.test(now)) {
    throw new AccessGrantError("invalid_instant");
  }
  const scoped =
    project === undefined ? sql`` : sql` AND scope_id = ${project}::uuid`;
  const result = await tx.execute<{
    id: unknown;
    revoked_at: unknown;
    revoked_by: unknown;
  }>(
    sql`UPDATE bricx.access_grants
        SET revoked_at = ${now}::timestamptz, revoked_by = ${actor}::uuid
        WHERE org_id = ${org}::uuid AND user_id = ${user}::uuid
          AND revoked_at IS NULL AND expired_at IS NULL
          AND expires_at > ${now}::timestamptz${scoped}
        RETURNING id::text, ${ISO("revoked_at")} AS revoked_at, revoked_by::text`,
  );
  const ended = result.rows.map((r): EndedGrant => {
    if (
      !isString(r.id) ||
      !isNullableString(r.revoked_at) ||
      !isNullableString(r.revoked_by)
    ) {
      throw new AccessGrantError("invalid_result");
    }
    return { id: r.id, revokedAt: r.revoked_at, revokedBy: r.revoked_by };
  });
  return ended.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
