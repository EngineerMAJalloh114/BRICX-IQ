// Invitations, the shared side (P6-06, ADR 0077). The API's invitations
// module reads and writes its table through its own repository; what more
// than one caller needs lives here:
// - the token (D1): `<cellId>.<secret>`, the secret 32 bytes from the
//   CSPRNG as base64url (43 characters). Only SHA-256 of the secret's 32
//   bytes is stored; hashes are compared with timingSafeEqual. The cell id
//   is not secret (directory answers carry it) and tells the client which
//   cell to call (D3).
// - invitationByTokenHash(tx, hash): app.invitation_by_token_hash(), the
//   API's cross-org lookup (EXECUTE bricx_app), id, org and inviter only.
// - invitationsDue(tx, limit): app.invitations_due(), the sweeper's
//   cross-org read (EXECUTE bricx_relay, inside withRelayTx()).
// - mintInvitationToken(tx, input): the worker's send step, in the
//   invitation's org: sets the hash only while the row is pending, unexpired
//   and still on the send it was made for (send_seq), so a stale job never
//   mints a token (C7, S20); answers the address to send to, or undefined.
// - expireInvitation(tx, id, now): the sweeper's expiry, in the org.
// - invitationMessageSettings(tx, org), pendingInvitationAddress(tx, id,
//   now): what the worker reads in the org to write the e-mail and to
//   activate the account.
// - revokePendingInvitations(tx, input): the cascades (D14) of a member's
//   removal, a project's archive and an organisation's archive, in the
//   caller's transaction; the caller audits each revoked row.
// Ids and instants are checked before any SQL; an error never carries a
// value; no function here logs.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Tx } from "./tx.js";

export type InvitationErrorCode =
  "invalid_id" | "invalid_instant" | "invalid_hash" | "invalid_result";

export class InvitationError extends Error {
  readonly code: InvitationErrorCode;

  constructor(code: InvitationErrorCode) {
    super(`invitation: ${code}`);
    this.code = code;
  }
}
Object.defineProperty(InvitationError.prototype, "name", {
  value: "InvitationError",
});

/** Bytes of a token's secret (256 bits, D1). */
export const INVITATION_SECRET_BYTES = 32;
/** base64url characters of a 32-byte secret, no padding. */
const SECRET_CHARS = 43;
/** Most characters a token may have (a cell id is at most 32). */
export const INVITATION_TOKEN_MAX = 32 + 1 + SECRET_CHARS;
/** The directory's cell id shape (P6-02, CELL_ID). */
const CELL = /^[a-z]{2}(?:-[a-z]+)+-[0-9]+$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;

/** The statuses of an invitation row. */
export const INVITATION_STATUSES = Object.freeze([
  "pending",
  "accepted",
  "expired",
  "revoked",
] as const);
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

/** Why a pending invitation was revoked (the table's CHECK lists the same). */
export const REVOKE_REASONS = Object.freeze([
  "manual",
  "inviter_removed",
  // P6-06b (ADR 0084): the inviter's org membership was suspended.
  "inviter_suspended",
  "inviter_lacks_rights",
  "project_archived",
  "org_archived",
] as const);
export type RevokeReason = (typeof REVOKE_REASONS)[number];

/** A fresh secret: 32 CSPRNG bytes, base64url. */
export function newInvitationSecret(): string {
  return randomBytes(INVITATION_SECRET_BYTES).toString("base64url");
}

/** The token a link carries: the cell hint, a dot, the secret. */
export function invitationTokenOf(cellId: string, secret: string): string {
  if (!CELL.test(cellId) || cellId.length > 32 || !SECRET.test(secret)) {
    throw new InvitationError("invalid_hash");
  }
  return `${cellId}.${secret}`;
}

/** A token's parts, or undefined for anything that is not one (bounded first). */
export function parseInvitationToken(
  token: unknown,
): { readonly cellId: string; readonly secret: string } | undefined {
  if (typeof token !== "string" || token.length > INVITATION_TOKEN_MAX) {
    return undefined;
  }
  const dot = token.lastIndexOf(".");
  if (dot < 1) return undefined;
  const cellId = token.slice(0, dot);
  const secret = token.slice(dot + 1);
  if (!CELL.test(cellId) || !SECRET.test(secret)) return undefined;
  return { cellId, secret };
}

/** SHA-256 of the secret's 32 bytes (what the table stores). */
export function hashInvitationSecret(secret: string): Buffer {
  if (!SECRET.test(secret)) throw new InvitationError("invalid_hash");
  const bytes = Buffer.from(secret, "base64url");
  if (bytes.length !== INVITATION_SECRET_BYTES) {
    throw new InvitationError("invalid_hash");
  }
  return createHash("sha256").update(bytes).digest();
}

/** Whether two hashes are equal, in constant time for equal lengths. */
export function sameInvitationHash(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const checkId = (value: string): string => {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new InvitationError("invalid_id");
  }
  return value;
};
const checkInstant = (value: string): string => {
  if (typeof value !== "string" || !INSTANT.test(value)) {
    throw new InvitationError("invalid_instant");
  }
  return value;
};
const checkHash = (value: Buffer): Buffer => {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new InvitationError("invalid_hash");
  }
  return value;
};
const isString = (v: unknown): v is string => typeof v === "string";

/** An invitation found by hash or due: its id, its org and its inviter. */
export interface InvitationRef {
  readonly id: string;
  readonly orgId: string;
  readonly invitedBy: string;
}

const refsOf = (
  rows: readonly { id: unknown; org_id: unknown; invited_by: unknown }[],
): InvitationRef[] =>
  rows.map((r) => {
    if (!isString(r.id) || !isString(r.org_id) || !isString(r.invited_by)) {
      throw new InvitationError("invalid_result");
    }
    return { id: r.id, orgId: r.org_id, invitedBy: r.invited_by };
  });

/** The invitation whose token hash is `hash`, in any org, or undefined. */
export async function invitationByTokenHash(
  tx: Tx,
  hash: Buffer,
): Promise<InvitationRef | undefined> {
  const value = checkHash(hash);
  const result = await tx.execute<{
    id: unknown;
    org_id: unknown;
    invited_by: unknown;
  }>(
    sql`SELECT id::text, org_id::text, invited_by::text
        FROM app.invitation_by_token_hash(${value}::bytea)`,
  );
  return refsOf(result.rows)[0];
}

/** Most rows one sweep read may return (the function caps it too). */
export const MAX_DUE_INVITATIONS = 1000;

/** Up to `limit` pending invitations past expires_at, in every org, oldest first. */
export async function invitationsDue(
  tx: Tx,
  limit: number,
): Promise<InvitationRef[]> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_DUE_INVITATIONS
  ) {
    throw new RangeError("invitationsDue limit: out of range");
  }
  const result = await tx.execute<{
    id: unknown;
    org_id: unknown;
    invited_by: unknown;
  }>(
    sql`SELECT id::text, org_id::text, invited_by::text
        FROM app.invitations_due(${limit}::integer)`,
  );
  return refsOf(result.rows);
}

/** What the send step needs: the address and when the invitation ends. */
export interface MintedInvitation {
  readonly id: string;
  readonly email: string;
  readonly expiresAt: string;
}

/**
 * Stores `hash` as the invitation's token while the row is pending, not
 * expired at `now` and still on send `sendSeq`; undefined otherwise (a
 * stale or settled job: nothing minted).
 */
export async function mintInvitationToken(
  tx: Tx,
  input: {
    readonly id: string;
    readonly sendSeq: number;
    readonly hash: Buffer;
    readonly now: string;
  },
): Promise<MintedInvitation | undefined> {
  const id = checkId(input.id);
  const hash = checkHash(input.hash);
  const now = checkInstant(input.now);
  if (!Number.isSafeInteger(input.sendSeq) || input.sendSeq < 1) {
    throw new InvitationError("invalid_id");
  }
  const result = await tx.execute<{
    id: unknown;
    email: unknown;
    expires_at: unknown;
  }>(
    sql`UPDATE bricx.invitations
        SET token_hash = ${hash}::bytea, last_sent_at = ${now}::timestamptz,
            updated_at = GREATEST(updated_at, ${now}::timestamptz)
        WHERE id = ${id}::uuid AND status = 'pending'
          AND send_seq = ${input.sendSeq}::integer
          AND expires_at > ${now}::timestamptz
        RETURNING id::text, email_normalised AS email,
          to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at`,
  );
  const [row] = result.rows;
  if (row === undefined) return undefined;
  if (!isString(row.id) || !isString(row.email) || !isString(row.expires_at)) {
    throw new InvitationError("invalid_result");
  }
  return { id: row.id, email: row.email, expiresAt: row.expires_at };
}

/** A row a revoke or an expiry settled: what its audit event carries. */
export interface SettledInvitation {
  readonly id: string;
  readonly projectId: string | null;
  readonly status: InvitationStatus;
  readonly revokeReason: RevokeReason | null;
}

const settledOf = (
  rows: readonly {
    id: unknown;
    project_id: unknown;
    status: unknown;
    revoke_reason: unknown;
  }[],
): SettledInvitation[] =>
  rows
    .map((r) => {
      if (
        !isString(r.id) ||
        !(r.project_id === null || isString(r.project_id)) ||
        !isString(r.status) ||
        !(INVITATION_STATUSES as readonly string[]).includes(r.status) ||
        !(
          r.revoke_reason === null ||
          (isString(r.revoke_reason) &&
            (REVOKE_REASONS as readonly string[]).includes(r.revoke_reason))
        )
      ) {
        throw new InvitationError("invalid_result");
      }
      return {
        id: r.id,
        projectId: r.project_id,
        status: r.status as InvitationStatus,
        revokeReason: r.revoke_reason as RevokeReason | null,
      };
    })
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

/** Sets a pending invitation past expires_at (at `now`) to expired; undefined otherwise. */
export async function expireInvitation(
  tx: Tx,
  invitationId: string,
  now: string,
): Promise<SettledInvitation | undefined> {
  const id = checkId(invitationId);
  const at = checkInstant(now);
  const result = await tx.execute<{
    id: unknown;
    project_id: unknown;
    status: unknown;
    revoke_reason: unknown;
  }>(
    sql`UPDATE bricx.invitations
        SET status = 'expired', updated_at = GREATEST(updated_at, ${at}::timestamptz)
        WHERE id = ${id}::uuid AND status = 'pending'
          AND expires_at <= ${at}::timestamptz
        RETURNING id::text, project_id::text, status, revoke_reason`,
  );
  return settledOf(result.rows)[0];
}

/** Which pending invitations a cascade revokes (D14). */
export type RevokeScope =
  | { readonly invitedBy: string }
  | { readonly projectId: string }
  | { readonly allInOrg: true };

/**
 * Revokes the org's pending invitations in `scope` (revoked_at = `now`,
 * revoked_by = `by`, NULL for the system), oldest id first. Inside the
 * caller's withTx() as bricx_app; the caller records one event per row.
 */
export async function revokePendingInvitations(
  tx: Tx,
  input: {
    readonly orgId: string;
    readonly scope: RevokeScope;
    readonly reason: RevokeReason;
    readonly by: string | null;
    readonly now: string;
  },
): Promise<SettledInvitation[]> {
  const org = checkId(input.orgId);
  const now = checkInstant(input.now);
  const by = input.by === null ? null : checkId(input.by);
  if (!(REVOKE_REASONS as readonly string[]).includes(input.reason)) {
    throw new InvitationError("invalid_result");
  }
  const { scope } = input;
  const where =
    "invitedBy" in scope
      ? sql` AND invited_by = ${checkId(scope.invitedBy)}::uuid`
      : "projectId" in scope
        ? sql` AND project_id = ${checkId(scope.projectId)}::uuid`
        : sql``;
  const result = await tx.execute<{
    id: unknown;
    project_id: unknown;
    status: unknown;
    revoke_reason: unknown;
  }>(
    sql`UPDATE bricx.invitations
        SET status = 'revoked', revoked_at = ${now}::timestamptz,
            revoked_by = ${by}::uuid, revoke_reason = ${input.reason},
            updated_at = GREATEST(updated_at, ${now}::timestamptz)
        WHERE org_id = ${org}::uuid AND status = 'pending'${where}
        RETURNING id::text, project_id::text, status, revoke_reason`,
  );
  return settledOf(result.rows);
}

/** What an invitation e-mail is written in: the org's language and time zone. */
export interface InvitationMessageSettings {
  readonly language: string;
  readonly timezone: string;
}

/** The org's default language and time zone (the worker's send step, in the org). */
export async function invitationMessageSettings(
  tx: Tx,
  orgId: string,
): Promise<InvitationMessageSettings | undefined> {
  const org = checkId(orgId);
  const result = await tx.execute<{ language: unknown; timezone: unknown }>(
    sql`SELECT default_language AS language, timezone
        FROM bricx.organizations WHERE id = ${org}::uuid`,
  );
  const [row] = result.rows;
  if (row === undefined) return undefined;
  if (!isString(row.language) || !isString(row.timezone)) {
    throw new InvitationError("invalid_result");
  }
  return { language: row.language, timezone: row.timezone };
}

/** A pending, unexpired invitation's address and end (the activation step). */
export async function pendingInvitationAddress(
  tx: Tx,
  invitationId: string,
  now: string,
): Promise<{ readonly email: string; readonly expiresAt: string } | undefined> {
  const id = checkId(invitationId);
  const at = checkInstant(now);
  const result = await tx.execute<{ email: unknown; expires_at: unknown }>(
    sql`SELECT email_normalised AS email,
          to_char(expires_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS expires_at
        FROM bricx.invitations
        WHERE id = ${id}::uuid AND status = 'pending'
          AND expires_at > ${at}::timestamptz`,
  );
  const [row] = result.rows;
  if (row === undefined) return undefined;
  if (!isString(row.email) || !isString(row.expires_at)) {
    throw new InvitationError("invalid_result");
  }
  return { email: row.email, expiresAt: row.expires_at };
}
