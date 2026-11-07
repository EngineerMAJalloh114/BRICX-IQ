// Organisations' rows (P6-02, ADR 0072), in the caller's transaction:
// the create attempts (bricx.org_create_attempts: the user's own rows under
// RLS, settled once by trigger P6003) and the organisation's editable
// columns (bricx_app may update only those; trigger P6002 keeps the rest).
// The organisation insert and its bootstrap are @bricx/db/organizations'
// createOrganization() (PD-2), shared with the CLI and the seed.
import type { Tx } from "@bricx/db/database";
import {
  ORGANIZATION_COLUMNS,
  type OrganizationRow,
} from "@bricx/db/organizations";
import { orgCreateAttempts, organizations } from "@bricx/db/schema";
import { Injectable } from "@nestjs/common";
import { and, count, eq, inArray, sql } from "drizzle-orm";

/**
 * The first key of the two-key advisory lock taken per user before the
 * cap is read ("ORGC"), so parallel creates of one user are serialised.
 */
export const ORG_CREATE_LOCK_NAMESPACE = 0x4f524743;

export type AttemptState = "pending" | "committed" | "refused";

export interface Attempt {
  readonly requestHash: Buffer;
  readonly orgId: string;
  readonly slug: string;
  readonly state: AttemptState;
}

const isState = (value: string): value is AttemptState =>
  value === "pending" || value === "committed" || value === "refused";

export interface OrganizationChanges {
  readonly legalName?: string;
  readonly country?: string;
  readonly defaultCurrency?: string;
  readonly defaultLanguage?: string;
  readonly timezone?: string;
  readonly units?: string;
  readonly brandColor?: string | null;
  readonly updatedAt: string;
  readonly archivedAt?: string;
}

@Injectable()
export class OrganizationsRepository {
  /** Waits for the user's other creates (until COMMIT). */
  async lockUser(tx: Tx, userId: string): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${ORG_CREATE_LOCK_NAMESPACE}::int4, hashtext(${userId}::text))`,
    );
  }

  /** The user's attempt under `keyHash`; FOR UPDATE when `lock`. */
  async findAttempt(
    tx: Tx,
    userId: string,
    keyHash: Buffer,
    lock = false,
  ): Promise<Attempt | undefined> {
    const query = tx
      .select({
        requestHash: orgCreateAttempts.requestHash,
        orgId: orgCreateAttempts.orgId,
        slug: orgCreateAttempts.slug,
        state: orgCreateAttempts.state,
      })
      .from(orgCreateAttempts)
      .where(
        and(
          eq(orgCreateAttempts.userId, userId),
          eq(orgCreateAttempts.keyHash, keyHash),
        ),
      );
    const [row] = lock ? await query.for("update") : await query;
    if (row === undefined) return undefined;
    if (!isState(row.state)) throw new Error("unknown attempt state");
    return { ...row, state: row.state };
  }

  /** The user's attempts that count toward the cap: pending and committed (D13). */
  async countCounted(tx: Tx, userId: string): Promise<number> {
    const [row] = await tx
      .select({ n: count() })
      .from(orgCreateAttempts)
      .where(
        and(
          eq(orgCreateAttempts.userId, userId),
          inArray(orgCreateAttempts.state, ["pending", "committed"]),
        ),
      );
    return row?.n ?? 0;
  }

  async insertAttempt(
    tx: Tx,
    attempt: {
      readonly userId: string;
      readonly keyHash: Buffer;
      readonly requestHash: Buffer;
      readonly orgId: string;
      readonly slug: string;
      readonly now: string;
    },
  ): Promise<void> {
    await tx.insert(orgCreateAttempts).values({
      userId: attempt.userId,
      keyHash: attempt.keyHash,
      requestHash: attempt.requestHash,
      orgId: attempt.orgId,
      slug: attempt.slug,
      createdAt: attempt.now,
    });
  }

  /** Settles a pending attempt (trigger P6003 refuses anything else). */
  async settleAttempt(
    tx: Tx,
    userId: string,
    keyHash: Buffer,
    state: "committed" | "refused",
    now: string,
  ): Promise<void> {
    await tx
      .update(orgCreateAttempts)
      .set({ state, settledAt: now })
      .where(
        and(
          eq(orgCreateAttempts.userId, userId),
          eq(orgCreateAttempts.keyHash, keyHash),
        ),
      );
  }

  /** Updates the transaction's organisation; undefined when RLS hides it. */
  async update(
    tx: Tx,
    id: string,
    changes: OrganizationChanges,
  ): Promise<OrganizationRow | undefined> {
    const [row] = await tx
      .update(organizations)
      .set(changes)
      .where(eq(organizations.id, id))
      .returning(ORGANIZATION_COLUMNS);
    return row;
  }
}
