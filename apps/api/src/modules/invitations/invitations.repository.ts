// Invitations' repository (P6-06, ADR 0077): every statement runs in the
// `tx` the service's runner hands over, as bricx_app under FORCE RLS
// (org_id = app.current_org()); the statements add the org id too. The
// lifecycle writes are conditional UPDATEs, so a concurrent request can
// never move a settled row (the table's trigger refuses it too, C6):
// - accept (D7): status pending, the same token hash and expires_at past
//   the Clock's `now`, in ONE statement (S1, S2, S11); the address is
//   cleared in the same UPDATE (D9);
// - activate (D6): the same conditions and fewer than
//   MAX_ACTIVATIONS activations (S19);
// - resend (D11): pending, unexpired, fewer resends than the cap; the
//   send number moves on, so the old job's token is never minted (S20);
// - revoke: pending and unexpired.
// The duplicate rule (D12) is the partial unique index; insert() asks
// ON CONFLICT on it and answers undefined, so a race is 409, never 500.
// A pending row past expires_at is presented as expired (lazy, D10).
// Instants are ISO 8601 UTC with milliseconds, in and out. The token
// hash is read only by findForAccept() and never leaves the service.
import type { Tx } from "@bricx/db/database";
import {
  type SettledInvitation,
  REVOKE_REASONS,
  insertPendingInvitation,
} from "@bricx/db/invitations";
import { Injectable } from "@nestjs/common";
import { type SQL, sql } from "drizzle-orm";
import type { InvitationData } from "./invitations.dto.js";

/** At most three activations per invitation (D6, S19). */
export const MAX_ACTIVATIONS = 3;

const NIL = "00000000-0000-0000-0000-000000000000";

type Status = InvitationData["status"];

/** One row as stored, with the status as presented at the query's `now`. */
export interface InvitationRow {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string | null;
  readonly email: string | null;
  readonly roleId: string;
  readonly projectRoleId: string | null;
  /** The stored status. */
  readonly storedStatus: Status;
  /** As presented: a pending row past expiresAt is expired. */
  readonly status: Status;
  readonly sendSeq: number;
  readonly resendCount: number;
  readonly activationCount: number;
  readonly expiresAt: string;
  readonly lastSentAt: string | null;
  readonly invitedBy: string;
  readonly acceptedBy: string | null;
  readonly acceptedAt: string | null;
  readonly revokedBy: string | null;
  readonly revokedAt: string | null;
  readonly revokeReason: string | null;
  readonly createdAt: string;
  /** P6-06b (ADR 0084): the membership it creates is external. */
  readonly external: boolean;
  /** P6-06b: the end of the membership it creates (absolute), or null. */
  readonly membershipExpiresAt: string | null;
}

/** findForAccept()'s row: the stored hash too. */
export interface AcceptRow extends InvitationRow {
  readonly tokenHash: Buffer | null;
}

export interface NewInvitation {
  readonly id: string;
  readonly orgId: string;
  readonly projectId: string | null;
  readonly email: string;
  readonly roleId: string;
  readonly projectRoleId: string | null;
  readonly invitedBy: string;
  readonly expiresAt: string;
  readonly now: string;
  readonly external: boolean;
  readonly membershipExpiresAt: string | null;
}

const iso = (column: SQL) =>
  sql`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

/** The selected columns; `now` decides the presented status. */
const columns = (now: string) => sql`
  i.id::text AS id, i.org_id::text AS org_id, i.project_id::text AS project_id,
  i.email_normalised AS email, i.role_id::text AS role_id,
  i.project_role_id::text AS project_role_id, i.status AS stored_status,
  CASE WHEN i.status = 'pending' AND i.expires_at <= ${now}::timestamptz
       THEN 'expired' ELSE i.status END AS status,
  i.send_seq, i.resend_count, i.activation_count,
  ${iso(sql`i.expires_at`)} AS expires_at,
  ${iso(sql`i.last_sent_at`)} AS last_sent_at,
  i.invited_by::text AS invited_by, i.accepted_by::text AS accepted_by,
  ${iso(sql`i.accepted_at`)} AS accepted_at,
  i.revoked_by::text AS revoked_by, ${iso(sql`i.revoked_at`)} AS revoked_at,
  i.revoke_reason, ${iso(sql`i.created_at`)} AS created_at,
  i.is_external, ${iso(sql`i.membership_expires_at`)} AS membership_expires_at`;

type Raw = Record<string, unknown>;

const str = (v: unknown): string => {
  if (typeof v !== "string") throw new Error("invitations: unexpected row");
  return v;
};
const strOrNull = (v: unknown): string | null => (v === null ? null : str(v));
const num = (v: unknown): number => {
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n)) {
    throw new Error("invitations: unexpected row");
  }
  return n;
};
const STATUSES: ReadonlySet<string> = new Set([
  "pending",
  "accepted",
  "expired",
  "revoked",
]);
const status = (v: unknown): Status => {
  const s = str(v);
  if (!STATUSES.has(s)) throw new Error("invitations: unexpected row");
  return s as Status;
};

function rowOf(r: Raw): InvitationRow {
  return {
    id: str(r.id),
    orgId: str(r.org_id),
    projectId: strOrNull(r.project_id),
    email: strOrNull(r.email),
    roleId: str(r.role_id),
    projectRoleId: strOrNull(r.project_role_id),
    storedStatus: status(r.stored_status),
    status: status(r.status),
    sendSeq: num(r.send_seq),
    resendCount: num(r.resend_count),
    activationCount: num(r.activation_count),
    expiresAt: str(r.expires_at),
    lastSentAt: strOrNull(r.last_sent_at),
    invitedBy: str(r.invited_by),
    acceptedBy: strOrNull(r.accepted_by),
    acceptedAt: strOrNull(r.accepted_at),
    revokedBy: strOrNull(r.revoked_by),
    revokedAt: strOrNull(r.revoked_at),
    revokeReason: strOrNull(r.revoke_reason),
    createdAt: str(r.created_at),
    external: r.is_external === true,
    membershipExpiresAt: strOrNull(r.membership_expires_at),
  };
}

export interface ListFilter {
  readonly status?: Status | undefined;
  readonly projectId?: string | undefined;
  readonly beforeId?: string | undefined;
  readonly limit: number;
  readonly now: string;
}

@Injectable()
export class InvitationsRepository {
  /** One invitation of the org, or undefined. */
  async find(
    tx: Tx,
    orgId: string,
    id: string,
    now: string,
  ): Promise<InvitationRow | undefined> {
    const result = await tx.execute<Raw>(
      sql`SELECT ${columns(now)} FROM bricx.invitations i
          WHERE i.org_id = ${orgId}::uuid AND i.id = ${id}::uuid`,
    );
    const [row] = result.rows;
    return row === undefined ? undefined : rowOf(row);
  }

  /** The row accept and activate work on, with its hash, locked for the transaction. */
  async findForAccept(
    tx: Tx,
    orgId: string,
    id: string,
    now: string,
  ): Promise<AcceptRow | undefined> {
    const result = await tx.execute<Raw>(
      sql`SELECT ${columns(now)}, i.token_hash FROM bricx.invitations i
          WHERE i.org_id = ${orgId}::uuid AND i.id = ${id}::uuid
          FOR UPDATE`,
    );
    const [row] = result.rows;
    if (row === undefined) return undefined;
    const hash: unknown = row.token_hash;
    return {
      ...rowOf(row),
      tokenHash: Buffer.isBuffer(hash) ? hash : null,
    };
  }

  /** Newest first (UUIDv7 ids), at most `limit`, after the cursor. */
  async list(
    tx: Tx,
    orgId: string,
    filter: ListFilter,
  ): Promise<InvitationRow[]> {
    const { now } = filter;
    const conditions: SQL[] = [sql`i.org_id = ${orgId}::uuid`];
    if (filter.projectId !== undefined) {
      conditions.push(sql`i.project_id = ${filter.projectId}::uuid`);
    }
    if (filter.beforeId !== undefined) {
      conditions.push(sql`i.id < ${filter.beforeId}::uuid`);
    }
    if (filter.status === "pending") {
      conditions.push(
        sql`i.status = 'pending' AND i.expires_at > ${now}::timestamptz`,
      );
    } else if (filter.status === "expired") {
      conditions.push(
        sql`(i.status = 'expired' OR (i.status = 'pending' AND i.expires_at <= ${now}::timestamptz))`,
      );
    } else if (filter.status !== undefined) {
      conditions.push(sql`i.status = ${filter.status}`);
    }
    const result = await tx.execute<Raw>(
      sql`SELECT ${columns(now)} FROM bricx.invitations i
          WHERE ${sql.join(conditions, sql` AND `)}
          ORDER BY i.id DESC LIMIT ${filter.limit}`,
    );
    return result.rows.map(rowOf);
  }

  /**
   * Expires the pending row for (org, project, address) that is already
   * past expires_at (lazy expiry before a new invitation takes its slot).
   */
  async expireStale(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly projectId: string | null;
      readonly email: string;
      readonly now: string;
    },
  ): Promise<SettledInvitation[]> {
    const result = await tx.execute<Raw>(
      sql`UPDATE bricx.invitations
          SET status = 'expired',
              updated_at = GREATEST(updated_at, ${input.now}::timestamptz)
          WHERE org_id = ${input.orgId}::uuid
            AND COALESCE(project_id, ${NIL}::uuid) = COALESCE(${input.projectId}::uuid, ${NIL}::uuid)
            AND email_normalised = ${input.email}
            AND status = 'pending' AND expires_at <= ${input.now}::timestamptz
          RETURNING id::text, project_id::text, status, revoke_reason`,
    );
    return result.rows.map((r) => ({
      id: str(r.id),
      projectId: strOrNull(r.project_id),
      status: "expired" as const,
      revokeReason: null,
    }));
  }

  /**
   * Inserts a pending invitation; undefined when one is already pending
   * (D12). The INSERT is @bricx/db/invitations' insertPendingInvitation,
   * the one statement the bulk consumer runs too (P6-06c, ADR 0085); the
   * row is then read back in this module's shape.
   */
  async insert(
    tx: Tx,
    input: NewInvitation,
  ): Promise<InvitationRow | undefined> {
    const inserted = await insertPendingInvitation(tx, input);
    if (inserted === undefined) return undefined;
    const result = await tx.execute<Raw>(
      sql`SELECT ${columns(input.now)} FROM bricx.invitations i
          WHERE i.id = ${inserted.id}::uuid AND i.org_id = ${input.orgId}::uuid`,
    );
    const [row] = result.rows;
    if (row === undefined) throw new Error("invitations: unexpected row");
    return rowOf(row);
  }

  /** The id of the pending invitation for (org, project, address), or undefined. */
  async pendingId(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly projectId: string | null;
      readonly email: string;
    },
  ): Promise<string | undefined> {
    const result = await tx.execute<Raw>(
      sql`SELECT id::text AS id FROM bricx.invitations
          WHERE org_id = ${input.orgId}::uuid
            AND COALESCE(project_id, ${NIL}::uuid) = COALESCE(${input.projectId}::uuid, ${NIL}::uuid)
            AND email_normalised = ${input.email} AND status = 'pending'`,
    );
    const [row] = result.rows;
    return row === undefined ? undefined : str(row.id);
  }

  /**
   * A new send (D11): send_seq + 1, resend_count + 1, a fresh expiry, and
   * the old token dies here (token_hash NULL; the worker mints the next
   * one for the new send); only while pending, unexpired and under the
   * cap. undefined otherwise.
   */
  async resend(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly id: string;
      readonly expiresAt: string;
      readonly maxResends: number;
      readonly now: string;
    },
  ): Promise<InvitationRow | undefined> {
    const result = await tx.execute<Raw>(
      sql`UPDATE bricx.invitations AS i
          SET send_seq = i.send_seq + 1, resend_count = i.resend_count + 1,
              token_hash = NULL,
              expires_at = ${input.expiresAt}::timestamptz,
              updated_at = GREATEST(i.updated_at, ${input.now}::timestamptz)
          WHERE i.org_id = ${input.orgId}::uuid AND i.id = ${input.id}::uuid
            AND i.status = 'pending' AND i.expires_at > ${input.now}::timestamptz
            AND i.resend_count < ${input.maxResends}
          RETURNING ${columns(input.now)}`,
    );
    const [row] = result.rows;
    return row === undefined ? undefined : rowOf(row);
  }

  /** Revokes a pending, unexpired invitation by hand; undefined otherwise. */
  async revoke(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly id: string;
      readonly by: string | null;
      readonly reason: (typeof REVOKE_REASONS)[number];
      readonly now: string;
    },
  ): Promise<InvitationRow | undefined> {
    const result = await tx.execute<Raw>(
      sql`UPDATE bricx.invitations AS i
          SET status = 'revoked', revoked_at = ${input.now}::timestamptz,
              revoked_by = ${input.by}::uuid, revoke_reason = ${input.reason},
              updated_at = GREATEST(i.updated_at, ${input.now}::timestamptz)
          WHERE i.org_id = ${input.orgId}::uuid AND i.id = ${input.id}::uuid
            AND i.status = 'pending' AND i.expires_at > ${input.now}::timestamptz
          RETURNING ${columns(input.now)}`,
    );
    const [row] = result.rows;
    return row === undefined ? undefined : rowOf(row);
  }

  /** One activation (D6): true when counted (pending, unexpired, under 3). */
  async activate(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly id: string;
      readonly hash: Buffer;
      readonly now: string;
    },
  ): Promise<boolean> {
    const result = await tx.execute<Raw>(
      sql`UPDATE bricx.invitations
          SET activation_count = activation_count + 1,
              updated_at = GREATEST(updated_at, ${input.now}::timestamptz)
          WHERE org_id = ${input.orgId}::uuid AND id = ${input.id}::uuid
            AND token_hash = ${input.hash}::bytea AND status = 'pending'
            AND expires_at > ${input.now}::timestamptz
            AND activation_count < ${MAX_ACTIVATIONS}
          RETURNING id::text AS id`,
    );
    return result.rows.length === 1;
  }

  /**
   * The accept (D7): one conditional UPDATE. true when this call moved
   * the row from pending to accepted; false for every other case.
   */
  async accept(
    tx: Tx,
    input: {
      readonly orgId: string;
      readonly id: string;
      readonly hash: Buffer;
      readonly userId: string;
      readonly now: string;
    },
  ): Promise<boolean> {
    const result = await tx.execute<Raw>(
      sql`UPDATE bricx.invitations
          SET status = 'accepted', accepted_by = ${input.userId}::uuid,
              accepted_at = ${input.now}::timestamptz, email_normalised = NULL,
              token_hash = NULL,
              updated_at = GREATEST(updated_at, ${input.now}::timestamptz)
          WHERE org_id = ${input.orgId}::uuid AND id = ${input.id}::uuid
            AND token_hash = ${input.hash}::bytea AND status = 'pending'
            AND expires_at > ${input.now}::timestamptz
          RETURNING id::text AS id`,
    );
    return result.rows.length === 1;
  }

  /** Whether the transaction's org is archived. */
  async orgArchived(tx: Tx): Promise<boolean> {
    const result = await tx.execute<Raw>(
      sql`SELECT (archived_at IS NOT NULL) AS archived
          FROM bricx.organizations WHERE id = app.current_org()`,
    );
    return result.rows[0]?.archived === true;
  }
}
