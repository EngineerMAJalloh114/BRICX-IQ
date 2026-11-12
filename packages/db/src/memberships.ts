// Temporary memberships (P6-06b, ADR 0084): the worker's side of the
// P5-06 expiry pattern (ADR 0067), reused for bricx.memberships and
// bricx.project_memberships.
// - Access ends at expires_at with no job at all: the API's grants source
//   reads active rows only, at the request's Clock.
// - What is left is the record: expired_at and one audit event, written
//   by the worker as bricx_app in the membership's org.
//   expireMembership() sets expired_at = now() (the database clock, so
//   the due read and the update agree, as ADR 0077 D10) on an open row
//   past expires_at, and answers the row's state otherwise. A renewal
//   clears expired_at and moves expires_at, so a job scheduled for the
//   earlier instant finds a row that is `renewed`, not `open`.
// - membershipsDue() and membershipsExpiring() are the sweep's cross-org
//   reads (SECURITY DEFINER, bricx_relay only): they write nothing.
// - markExpiryNotified() claims the one memberships.expiring notice of a
//   row (owner condition C8).
// Errors carry a code, never a value.
import { sql } from "drizzle-orm";
import type { Tx } from "./tx.js";

export type MembershipErrorCode =
  "invalid_id" | "invalid_kind" | "invalid_instant" | "invalid_result";

export class MembershipError extends Error {
  readonly code: MembershipErrorCode;

  constructor(code: MembershipErrorCode) {
    super(`membership: ${code}`);
    this.code = code;
  }
}
Object.defineProperty(MembershipError.prototype, "name", {
  value: "MembershipError",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Most rows one due or expiring read returns (the SQL functions cap the same). */
export const MAX_MEMBERSHIPS_DUE = 1000;
/** How long before expires_at the notice is written (owner answer Q6). */
export const EXPIRY_NOTICE_DAYS = 7;
export const EXPIRY_NOTICE_MS = EXPIRY_NOTICE_DAYS * 86_400_000;

/** An org membership or a project membership. */
export const MEMBERSHIP_KINDS = Object.freeze(["org", "project"] as const);
export type MembershipKind = (typeof MEMBERSHIP_KINDS)[number];

/** A row the sweep read: what the expiry transaction needs to open. */
export interface DueMembership {
  readonly kind: MembershipKind;
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
}

/**
 * - open: not past expires_at (a job that ran early);
 * - renewed: open, and expires_at is not the instant the job was made for;
 * - permanent: no expires_at;
 * - removed, expired: nothing to record.
 */
export type MembershipExpiryState =
  "open" | "renewed" | "permanent" | "removed" | "expired";

/** The audited columns of a membership at its expiry (never the suspend reason). */
export interface ExpiredMembership {
  readonly kind: MembershipKind;
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly projectId: string | null;
  readonly external: boolean;
  readonly expiresAt: string | null;
  readonly expiredAt: string | null;
}

export interface MembershipExpireOutcome {
  readonly membership: ExpiredMembership;
  readonly state: MembershipExpiryState;
  /** This call set expired_at. */
  readonly changed: boolean;
}

const checkId = (id: unknown): string => {
  if (typeof id !== "string" || !UUID.test(id)) {
    throw new MembershipError("invalid_id");
  }
  return id;
};

const checkKind = (kind: unknown): MembershipKind => {
  if (kind !== "org" && kind !== "project") {
    throw new MembershipError("invalid_kind");
  }
  return kind;
};

const isString = (v: unknown): v is string => typeof v === "string";
const isNullableString = (v: unknown): v is string | null =>
  v === null || typeof v === "string";

type Row = Record<string, unknown>;

const STATES: readonly string[] = [
  "open",
  "renewed",
  "permanent",
  "removed",
  "expired",
];

function outcomeOf(
  kind: MembershipKind,
  row: Row | undefined,
  changed: boolean,
): MembershipExpireOutcome {
  if (row === undefined) throw new MembershipError("invalid_result");
  const {
    id,
    org_id: orgId,
    user_id: userId,
    role_id: roleId,
    project_id: projectId,
    is_external: external,
    expires_at: expiresAt,
    expired_at: expiredAt,
    state,
  } = row;
  if (
    !isString(id) ||
    !isString(orgId) ||
    !isString(userId) ||
    !isString(roleId) ||
    !isNullableString(projectId) ||
    typeof external !== "boolean" ||
    !isNullableString(expiresAt) ||
    !isNullableString(expiredAt) ||
    !isString(state) ||
    !STATES.includes(state)
  ) {
    throw new MembershipError("invalid_result");
  }
  return {
    membership: {
      kind,
      id,
      orgId,
      userId,
      roleId,
      projectId,
      external,
      expiresAt,
      expiredAt,
    },
    // Checked against STATES above.
    state: state as MembershipExpiryState,
    changed,
  };
}

function dueOf(rows: readonly Row[]): DueMembership[] {
  return rows.map((r) => {
    if (
      !isString(r["id"]) ||
      !isString(r["org_id"]) ||
      !isString(r["user_id"])
    ) {
      throw new MembershipError("invalid_result");
    }
    return {
      kind: checkKind(r["kind"]),
      id: r["id"],
      orgId: r["org_id"],
      userId: r["user_id"],
    };
  });
}

const checkLimit = (limit: number): number => {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_MEMBERSHIPS_DUE
  ) {
    throw new RangeError("memberships limit: out of range");
  }
  return limit;
};

/**
 * Up to `limit` open memberships past expires_at with no expired_at, in
 * every org, oldest expiry first: app.memberships_due() through the
 * relay's transaction.
 */
export async function membershipsDue(
  tx: Tx,
  limit: number,
): Promise<DueMembership[]> {
  const n = checkLimit(limit);
  const result = await tx.execute<Row>(
    sql`SELECT kind, id::text, org_id::text, user_id::text
        FROM app.memberships_due(${n}::integer)`,
  );
  return dueOf(result.rows);
}

/**
 * Up to `limit` open memberships that expire within EXPIRY_NOTICE_DAYS
 * and have no notice yet: app.memberships_expiring().
 */
export async function membershipsExpiring(
  tx: Tx,
  limit: number,
): Promise<DueMembership[]> {
  const n = checkLimit(limit);
  const result = await tx.execute<Row>(
    sql`SELECT kind, id::text, org_id::text, user_id::text
        FROM app.memberships_expiring(${EXPIRY_NOTICE_DAYS}::integer, ${n}::integer)`,
  );
  return dueOf(result.rows);
}

/**
 * Records the expiry of membership `id` (`kind`) when it is open and past
 * expires_at on the database clock, in `tx` (withTx() as bricx_app in the
 * membership's org). `scheduledFor` is the expires_at a delayed job was
 * made for (toISOString() form): a row whose expires_at differs was
 * renewed since, and the job has nothing to do. The answer carries the
 * row's state and whether this call changed it; undefined when the
 * transaction sees no such row.
 */
export async function expireMembership(
  tx: Tx,
  kind: MembershipKind,
  id: string,
  scheduledFor?: string,
): Promise<MembershipExpireOutcome | undefined> {
  const k = checkKind(kind);
  const membershipId = checkId(id);
  if (
    scheduledFor !== undefined &&
    (typeof scheduledFor !== "string" || !INSTANT.test(scheduledFor))
  ) {
    throw new MembershipError("invalid_instant");
  }
  const at = scheduledFor ?? null;
  // Two fixed statements per kind: the table is never built from a value.
  if (k === "org") {
    const updated = await tx.execute<Row>(
      sql`UPDATE bricx.memberships SET expired_at = now()
          WHERE id = ${membershipId}::uuid AND removed_at IS NULL AND expired_at IS NULL
            AND expires_at IS NOT NULL AND expires_at <= now()
          RETURNING id::text, org_id::text, user_id::text, role_id::text, NULL::text AS project_id, is_external,
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
            to_char(expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expired_at,
            'expired'::text AS state`,
    );
    if (updated.rows.length === 1) return outcomeOf(k, updated.rows[0], true);
    const found = await tx.execute<Row>(
      sql`SELECT id::text, org_id::text, user_id::text, role_id::text, NULL::text AS project_id, is_external,
            to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
            to_char(expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expired_at,
            CASE WHEN removed_at IS NOT NULL THEN 'removed'
                 WHEN expired_at IS NOT NULL THEN 'expired'
                 WHEN expires_at IS NULL THEN 'permanent'
                 WHEN ${at}::timestamptz IS NOT NULL AND date_trunc('milliseconds', expires_at) <> ${at}::timestamptz THEN 'renewed'
                 ELSE 'open' END AS state
          FROM bricx.memberships WHERE id = ${membershipId}::uuid`,
    );
    if (found.rows.length === 0) return undefined;
    return outcomeOf(k, found.rows[0], false);
  }
  const updated = await tx.execute<Row>(
    sql`UPDATE bricx.project_memberships pm SET expired_at = now()
        WHERE pm.id = ${membershipId}::uuid AND pm.removed_at IS NULL AND pm.expired_at IS NULL
          AND pm.expires_at IS NOT NULL AND pm.expires_at <= now()
        RETURNING pm.id::text, pm.org_id::text, pm.user_id::text, pm.role_id::text, pm.project_id::text AS project_id,
          coalesce((SELECT m.is_external FROM bricx.memberships m WHERE m.org_id = pm.org_id AND m.user_id = pm.user_id AND m.removed_at IS NULL), false) AS is_external,
          to_char(pm.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
          to_char(pm.expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expired_at,
          'expired'::text AS state`,
  );
  if (updated.rows.length === 1) return outcomeOf(k, updated.rows[0], true);
  const found = await tx.execute<Row>(
    sql`SELECT pm.id::text, pm.org_id::text, pm.user_id::text, pm.role_id::text, pm.project_id::text AS project_id,
          coalesce((SELECT m.is_external FROM bricx.memberships m WHERE m.org_id = pm.org_id AND m.user_id = pm.user_id AND m.removed_at IS NULL), false) AS is_external,
          to_char(pm.expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at,
          to_char(pm.expired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expired_at,
          CASE WHEN pm.removed_at IS NOT NULL THEN 'removed'
               WHEN pm.expired_at IS NOT NULL THEN 'expired'
               WHEN pm.expires_at IS NULL THEN 'permanent'
               WHEN ${at}::timestamptz IS NOT NULL AND date_trunc('milliseconds', pm.expires_at) <> ${at}::timestamptz THEN 'renewed'
               ELSE 'open' END AS state
        FROM bricx.project_memberships pm WHERE pm.id = ${membershipId}::uuid`,
  );
  if (found.rows.length === 0) return undefined;
  return outcomeOf(k, found.rows[0], false);
}

/**
 * Claims the one expiry notice of membership `id`: sets
 * expiry_notified_at = now() on an open, unexpired, temporary row that
 * has none. True when this call claimed it (the caller then writes the
 * memberships.expiring outbox row in the same transaction).
 */
export async function markExpiryNotified(
  tx: Tx,
  kind: MembershipKind,
  id: string,
): Promise<boolean> {
  const k = checkKind(kind);
  const membershipId = checkId(id);
  const result =
    k === "org"
      ? await tx.execute<Row>(
          sql`UPDATE bricx.memberships SET expiry_notified_at = now()
              WHERE id = ${membershipId}::uuid AND removed_at IS NULL AND expired_at IS NULL
                AND expires_at IS NOT NULL AND expiry_notified_at IS NULL
              RETURNING id::text`,
        )
      : await tx.execute<Row>(
          sql`UPDATE bricx.project_memberships SET expiry_notified_at = now()
              WHERE id = ${membershipId}::uuid AND removed_at IS NULL AND expired_at IS NULL
                AND expires_at IS NOT NULL AND expiry_notified_at IS NULL
              RETURNING id::text`,
        );
  return result.rows.length === 1;
}
