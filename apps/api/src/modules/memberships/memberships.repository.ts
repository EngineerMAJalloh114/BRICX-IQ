// Memberships' repository (P5-05, ADR 0066): every statement runs in the
// `tx` TxRunner hands over, as bricx_app under RLS (org_id =
// app.current_org() on memberships; that and app.has_project(project_id)
// on project_memberships; the own-row SELECT policies for the caller's
// rows in any org); the statements add the org id too, so the policy
// check in the service is the only thing deciding whose rows are touched.
// A role's system_key rides with each row (the owner role is virtual:
// its bundle is in code). A list is the open rows (removed_at IS NULL),
// newest first (by id: UUIDv7), at most MEMBER_LIST_LIMIT. A unique
// violation (one open row per user, or per project and user) is
// ApiError("request.conflict") and a foreign key violation (the user, or
// the role in this org) ApiError("not_found"), here and only here. The
// roles table is read only through the roles module's repository.
// P6-05 (ADR 0075 D15, owner condition C4): a project membership's site
// assignment is its open project_membership_sites rows (siteIds, sorted;
// none = no site keys). setSites() replaces it: rows for dropped sites
// get removed_at, new ones are inserted; unassigning the membership, or
// removing the user from the org, closes them too. Whether each site is
// an open site of the project is the service's check (ProjectsReader).
import { type Tx, sqlstateOf } from "@bricx/db/database";
import {
  memberships,
  projectMembershipSites,
  projectMemberships,
  roles,
} from "@bricx/db/schema";
import { Injectable } from "@nestjs/common";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  type SQL,
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { ApiError } from "../../common/errors/api-error.js";
import { MEMBER_LIST_LIMIT } from "./memberships.dto.js";

/**
 * removed_at for a row closed at `now`, never before the row's created_at
 * (CHECK *_removed): a Clock behind the writer that created the row (clock
 * skew between instances, or fixtures written at the database clock)
 * must not turn a removal into a 500 (P6-06c, owner review of PR #95,
 * item B: 23514 memberships_removed in removeOrg).
 */
const removedAt = (created: SQLWrapper, now: string): SQL =>
  sql`GREATEST(${created}, ${now}::timestamptz)`;

const UNIQUE_VIOLATION = "23505";
const FOREIGN_KEY_VIOLATION = "23503";
/** The membership guard triggers (0014): an owner is neither temporary nor external. */
const GUARD_VIOLATION = "P606B";
const OWNERSHIP_GUARD_VIOLATION = "P606C";
/** The per-org advisory lock the last-owner count is taken under ("MEMB"). */
export const MEMBERS_LOCK_NAMESPACE = 0x4d_45_4d_42;
/** Most project rows read for the caller's own list (every org). */
const MY_PROJECTS_LIMIT = 1_000;

const iso = (
  column: typeof memberships.createdAt | typeof projectMemberships.createdAt,
) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const isoOrNull = (
  column: typeof memberships.removedAt | typeof projectMemberships.removedAt,
) =>
  sql<
    string | null
  >`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The lifecycle columns of a membership row (P6-06b, ADR 0084). The
 * instants are UTC with milliseconds (toISOString()'s form).
 */
export interface Lifecycle {
  readonly suspendedAt: string | null;
  readonly suspendReason: string | null;
  readonly expiresAt: string | null;
  readonly expiredAt: string | null;
  /** memberships.is_external of the user's org membership. */
  readonly external: boolean;
}

/** A memberships row with its role's system_key. */
export interface MembershipRow extends Lifecycle {
  readonly id: string;
  readonly userId: string;
  readonly roleId: string;
  readonly systemKey: string | null;
  readonly createdAt: string;
  readonly removedAt: string | null;
}

/** A project_memberships.overrides value as stored (lists of anything). */
export interface StoredOverrides {
  readonly add?: readonly unknown[] | undefined;
  readonly remove?: readonly unknown[] | undefined;
}

export interface ProjectMembershipRow extends MembershipRow {
  readonly projectId: string;
  readonly overrides: StoredOverrides;
  /** The open assigned sites, sorted (P6-05, C4). */
  readonly siteIds: readonly string[];
}

/** A membership's new site assignment (P6-05, C4). */
export interface SiteAssignment {
  readonly orgId: string;
  readonly projectId: string;
  readonly membershipId: string;
  readonly userId: string;
  /** The sites to hold, unique; checked open sites of the project. */
  readonly siteIds: readonly string[];
  readonly now: string;
  /** A new row id (UUIDv7) for each inserted site. */
  readonly nextId: () => string;
}

export interface NewMembership {
  readonly id: string;
  readonly orgId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly now: string;
  /** A temporary membership's end (P6-06b); absent: permanent. */
  readonly expiresAt?: string | null | undefined;
  /** memberships.is_external (org rows only); absent: internal. */
  readonly external?: boolean | undefined;
}

export interface NewProjectMembership extends NewMembership {
  readonly projectId: string;
  readonly overrides: { readonly add: string[]; readonly remove: string[] };
}

/** The rows the MFA computation reads for some users (plan 4.4, condition 1). */
export interface AccessRows {
  readonly memberships: readonly MembershipRow[];
  readonly projects: readonly ProjectMembershipRow[];
}

/** The caller's own rows in every org. */
export interface MyRows {
  readonly memberships: readonly {
    readonly id: string;
    readonly orgId: string;
    readonly roleId: string;
    readonly createdAt: string;
    readonly suspendedAt: string | null;
    readonly expiresAt: string | null;
    readonly external: boolean;
  }[];
  readonly projects: readonly {
    readonly orgId: string;
    readonly projectId: string;
  }[];
}

/** An instant column as toISOString() writes it, or null. */
const ms = (
  column:
    | typeof memberships.suspendedAt
    | typeof memberships.expiresAt
    | typeof memberships.expiredAt
    | typeof projectMemberships.suspendedAt
    | typeof projectMemberships.expiresAt
    | typeof projectMemberships.expiredAt,
) =>
  sql<
    string | null
  >`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const memberLifecycle = {
  suspendedAt: ms(memberships.suspendedAt),
  suspendReason: memberships.suspendReason,
  expiresAt: ms(memberships.expiresAt),
  expiredAt: ms(memberships.expiredAt),
  external: memberships.isExternal,
};

const memberColumns = {
  id: memberships.id,
  userId: memberships.userId,
  roleId: memberships.roleId,
  systemKey: roles.systemKey,
  createdAt: iso(memberships.createdAt),
  removedAt: isoOrNull(memberships.removedAt),
  ...memberLifecycle,
};

const projectLifecycle = {
  suspendedAt: ms(projectMemberships.suspendedAt),
  suspendReason: projectMemberships.suspendReason,
  expiresAt: ms(projectMemberships.expiresAt),
  expiredAt: ms(projectMemberships.expiredAt),
  // The flag is the org membership's (one copy; ADR 0084). The outer
  // columns are table-qualified by hand: in UPDATE … RETURNING drizzle
  // renders a column bare, which inside the sub-select would bind to m.
  external: sql<boolean>`coalesce((
    SELECT m.is_external FROM ${memberships} m
    WHERE m.org_id = ${sql.identifier("project_memberships")}.${sql.identifier("org_id")}
      AND m.user_id = ${sql.identifier("project_memberships")}.${sql.identifier("user_id")}
      AND m.removed_at IS NULL), false)`,
};

/** The lifecycle of a row this statement just inserted. */
const fresh = (input: NewMembership): Lifecycle => ({
  suspendedAt: null,
  suspendReason: null,
  expiresAt: input.expiresAt ?? null,
  expiredAt: null,
  external: input.external === true,
});

const projectColumns = {
  id: projectMemberships.id,
  projectId: projectMemberships.projectId,
  userId: projectMemberships.userId,
  roleId: projectMemberships.roleId,
  systemKey: roles.systemKey,
  overrides: projectMemberships.overrides,
  createdAt: iso(projectMemberships.createdAt),
  removedAt: isoOrNull(projectMemberships.removedAt),
  ...projectLifecycle,
  siteIds: sql<unknown>`coalesce((
    SELECT array_agg(s.site_id::text ORDER BY s.site_id)
    FROM ${projectMembershipSites} s
    WHERE s.org_id = ${projectMemberships.orgId}
      AND s.project_membership_id = ${projectMemberships.id}
      AND s.removed_at IS NULL), '{}')`,
};

/** A stored site list as strings (anything else is none). */
function siteIdsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const list: readonly unknown[] = value;
  return list.filter((id): id is string => typeof id === "string");
}

/** A stored list, when the value is one (the entries are checked by the service). */
function listOf(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: readonly unknown[] = value;
  return list;
}

/** The stored overrides object, lenient: anything else is no overrides. */
export function storedOverridesOf(value: unknown): StoredOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return {
    add: listOf(Reflect.get(value, "add")),
    remove: listOf(Reflect.get(value, "remove")),
  };
}

const roleJoin = and(
  eq(roles.orgId, memberships.orgId),
  eq(roles.id, memberships.roleId),
);
const projectRoleJoin = and(
  eq(roles.orgId, projectMemberships.orgId),
  eq(roles.id, projectMemberships.roleId),
);

function refuse(error: unknown): never {
  const state = sqlstateOf(error);
  if (state === UNIQUE_VIOLATION) throw new ApiError("request.conflict");
  if (state === FOREIGN_KEY_VIOLATION) throw new ApiError("not_found");
  if (state === GUARD_VIOLATION) throw new ApiError("request.conflict");
  // P6-06c (ADR 0085): memberships_guard v2's ownership rule; the service
  // answers ownership.transfer_required before a request gets here.
  if (state === OWNERSHIP_GUARD_VIOLATION) {
    throw new ApiError("request.conflict");
  }
  throw error;
}

const projectRowOf = (row: {
  readonly id: string;
  readonly projectId: string;
  readonly userId: string;
  readonly roleId: string;
  readonly systemKey: string | null;
  readonly overrides: unknown;
  readonly createdAt: string;
  readonly removedAt: string | null;
  readonly suspendedAt: string | null;
  readonly suspendReason: string | null;
  readonly expiresAt: string | null;
  readonly expiredAt: string | null;
  readonly external: boolean;
  readonly siteIds: unknown;
}): ProjectMembershipRow => ({
  ...row,
  overrides: storedOverridesOf(row.overrides),
  siteIds: siteIdsOf(row.siteIds),
});

@Injectable()
export class MembershipsRepository {
  /**
   * The org's open memberships, newest first, at most the limit: active,
   * suspended and expired ones alike (the answer carries the status).
   * With `expiring` only the temporary ones whose end is after `from` and
   * not after `until`, soonest first (P6-06b: the owner's "expiring soon"
   * list; the cap then keeps the most urgent).
   */
  listOrg(
    tx: Tx,
    orgId: string,
    expiring?: { readonly from: string; readonly until: string },
  ): Promise<MembershipRow[]> {
    return tx
      .select(memberColumns)
      .from(memberships)
      .innerJoin(roles, roleJoin)
      .where(
        and(
          eq(memberships.orgId, orgId),
          isNull(memberships.removedAt),
          expiring === undefined
            ? undefined
            : sql`${memberships.expiresAt} > ${expiring.from}::timestamptz AND ${memberships.expiresAt} <= ${expiring.until}::timestamptz`,
        ),
      )
      .orderBy(
        ...(expiring === undefined
          ? [desc(memberships.id)]
          : [asc(memberships.expiresAt), desc(memberships.id)]),
      )
      .limit(MEMBER_LIST_LIMIT);
  }

  /** The org's membership `id`, removed or not (the activity read). */
  async findOrgAny(
    tx: Tx,
    orgId: string,
    id: string,
  ): Promise<{ readonly id: string; readonly userId: string } | undefined> {
    const rows = await tx
      .select({ id: memberships.id, userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.id, id)));
    return rows[0];
  }

  /**
   * Every membership id `userId` has or had in the org, org and project
   * rows, newest first, at most `limit` each: the subjects of the
   * member's activity (owner addition A4: matched by user id inside the
   * org).
   */
  async membershipIdsOf(
    tx: Tx,
    orgId: string,
    userId: string,
    limit: number,
  ): Promise<{ readonly org: string[]; readonly project: string[] }> {
    const org = await tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(and(eq(memberships.orgId, orgId), eq(memberships.userId, userId)))
      .orderBy(desc(memberships.id))
      .limit(limit);
    const project = await tx
      .select({ id: projectMemberships.id })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.orgId, orgId),
          eq(projectMemberships.userId, userId),
        ),
      )
      .orderBy(desc(projectMemberships.id))
      .limit(limit);
    return { org: org.map((r) => r.id), project: project.map((r) => r.id) };
  }

  /**
   * Suspends the open, not yet suspended org membership (P6-06b);
   * undefined when there is none (already suspended, or gone).
   */
  async suspendOrg(
    tx: Tx,
    orgId: string,
    id: string,
    suspension: {
      readonly by: string;
      readonly reason: string;
      readonly now: string;
    },
  ): Promise<{ readonly id: string } | undefined> {
    const rows = await tx
      .update(memberships)
      .set({
        suspendedAt: suspension.now,
        suspendedBy: suspension.by,
        suspendReason: suspension.reason,
      })
      .where(
        and(
          eq(memberships.orgId, orgId),
          eq(memberships.id, id),
          isNull(memberships.removedAt),
          isNull(memberships.suspendedAt),
        ),
      )
      .returning({ id: memberships.id });
    return rows[0];
  }

  /** Clears the suspension of the open, suspended org membership; undefined when none. */
  async reactivateOrg(
    tx: Tx,
    orgId: string,
    id: string,
  ): Promise<{ readonly id: string } | undefined> {
    const rows = await tx
      .update(memberships)
      .set({ suspendedAt: null, suspendedBy: null, suspendReason: null })
      .where(
        and(
          eq(memberships.orgId, orgId),
          eq(memberships.id, id),
          isNull(memberships.removedAt),
          isNotNull(memberships.suspendedAt),
        ),
      )
      .returning({ id: memberships.id });
    return rows[0];
  }

  /**
   * A new end on the open TEMPORARY org membership: expired_at and the
   * notice mark are cleared (an expired one is renewed the same way);
   * undefined when the membership is permanent or gone.
   */
  async renewOrg(
    tx: Tx,
    orgId: string,
    id: string,
    expiresAt: string,
  ): Promise<{ readonly id: string } | undefined> {
    const rows = await tx
      .update(memberships)
      .set({ expiresAt, expiredAt: null, expiryNotifiedAt: null })
      .where(
        and(
          eq(memberships.orgId, orgId),
          eq(memberships.id, id),
          isNull(memberships.removedAt),
          isNotNull(memberships.expiresAt),
        ),
      )
      .returning({ id: memberships.id });
    return rows[0];
  }

  /** As suspendOrg, for a project membership. */
  async suspendProject(
    tx: Tx,
    orgId: string,
    id: string,
    suspension: {
      readonly by: string;
      readonly reason: string;
      readonly now: string;
    },
  ): Promise<{ readonly id: string } | undefined> {
    const rows = await tx
      .update(projectMemberships)
      .set({
        suspendedAt: suspension.now,
        suspendedBy: suspension.by,
        suspendReason: suspension.reason,
      })
      .where(
        and(
          eq(projectMemberships.orgId, orgId),
          eq(projectMemberships.id, id),
          isNull(projectMemberships.removedAt),
          isNull(projectMemberships.suspendedAt),
        ),
      )
      .returning({ id: projectMemberships.id });
    return rows[0];
  }

  /** As reactivateOrg, for a project membership. */
  async reactivateProject(
    tx: Tx,
    orgId: string,
    id: string,
  ): Promise<{ readonly id: string } | undefined> {
    const rows = await tx
      .update(projectMemberships)
      .set({ suspendedAt: null, suspendedBy: null, suspendReason: null })
      .where(
        and(
          eq(projectMemberships.orgId, orgId),
          eq(projectMemberships.id, id),
          isNull(projectMemberships.removedAt),
          isNotNull(projectMemberships.suspendedAt),
        ),
      )
      .returning({ id: projectMemberships.id });
    return rows[0];
  }

  /** As renewOrg, for a project membership. */
  async renewProject(
    tx: Tx,
    orgId: string,
    id: string,
    expiresAt: string,
  ): Promise<{ readonly id: string } | undefined> {
    const rows = await tx
      .update(projectMemberships)
      .set({ expiresAt, expiredAt: null, expiryNotifiedAt: null })
      .where(
        and(
          eq(projectMemberships.orgId, orgId),
          eq(projectMemberships.id, id),
          isNull(projectMemberships.removedAt),
          isNotNull(projectMemberships.expiresAt),
        ),
      )
      .returning({ id: projectMemberships.id });
    return rows[0];
  }

  /** Marks the expiry notice of an org (or project) membership as written at `now`. */
  async markNotified(
    tx: Tx,
    orgId: string,
    kind: "org" | "project",
    id: string,
    now: string,
  ): Promise<void> {
    if (kind === "org") {
      await tx
        .update(memberships)
        .set({ expiryNotifiedAt: now })
        .where(and(eq(memberships.orgId, orgId), eq(memberships.id, id)));
      return;
    }
    await tx
      .update(projectMemberships)
      .set({ expiryNotifiedAt: now })
      .where(
        and(eq(projectMemberships.orgId, orgId), eq(projectMemberships.id, id)),
      );
  }

  /** The org's open membership `id`, or undefined. */
  async findOrg(
    tx: Tx,
    orgId: string,
    id: string,
  ): Promise<MembershipRow | undefined> {
    const rows = await tx
      .select(memberColumns)
      .from(memberships)
      .innerJoin(roles, roleJoin)
      .where(
        and(
          eq(memberships.orgId, orgId),
          eq(memberships.id, id),
          isNull(memberships.removedAt),
        ),
      );
    return rows[0];
  }

  /** `userId`'s open org membership, with its role's system key (P6-06c). */
  async findOrgOfUser(
    tx: Tx,
    orgId: string,
    userId: string,
  ): Promise<MembershipRow | undefined> {
    const rows = await tx
      .select(memberColumns)
      .from(memberships)
      .innerJoin(roles, roleJoin)
      .where(
        and(
          eq(memberships.orgId, orgId),
          eq(memberships.userId, userId),
          isNull(memberships.removedAt),
        ),
      );
    return rows[0];
  }

  /**
   * Inserts one org membership unless the user already has an open one
   * (P6-06, ADR 0077, D7, D12: accepting an invitation; ON CONFLICT on
   * memberships_open). undefined when one exists: the caller answers
   * already_member and never changes that member's role.
   */
  async insertOrgIfAbsent(
    tx: Tx,
    input: NewMembership,
    systemKey: string | null,
  ): Promise<MembershipRow | undefined> {
    let rows: { id: string; createdAt: string; removedAt: string | null }[];
    try {
      rows = await tx
        .insert(memberships)
        .values({
          id: input.id,
          orgId: input.orgId,
          userId: input.userId,
          roleId: input.roleId,
          createdAt: input.now,
          expiresAt: input.expiresAt ?? null,
          isExternal: input.external === true,
        })
        .onConflictDoNothing({
          target: [memberships.orgId, memberships.userId],
          where: sql`${memberships.removedAt} IS NULL`,
        })
        .returning({
          id: memberships.id,
          createdAt: iso(memberships.createdAt),
          removedAt: isoOrNull(memberships.removedAt),
        });
    } catch (error) {
      refuse(error);
    }
    const [row] = rows;
    if (row === undefined) return undefined;
    return {
      ...row,
      userId: input.userId,
      roleId: input.roleId,
      systemKey,
      ...fresh(input),
    };
  }

  /** A new role on the open membership (the role was read by the caller). */
  async setOrgRole(
    tx: Tx,
    orgId: string,
    id: string,
    roleId: string,
    systemKey: string | null,
  ): Promise<MembershipRow> {
    let rows: (Lifecycle & {
      id: string;
      userId: string;
      createdAt: string;
      removedAt: string | null;
    })[];
    try {
      rows = await tx
        .update(memberships)
        .set({ roleId })
        .where(
          and(
            eq(memberships.orgId, orgId),
            eq(memberships.id, id),
            isNull(memberships.removedAt),
          ),
        )
        .returning({
          id: memberships.id,
          userId: memberships.userId,
          createdAt: iso(memberships.createdAt),
          removedAt: isoOrNull(memberships.removedAt),
          ...memberLifecycle,
        });
    } catch (error) {
      refuse(error);
    }
    const [row] = rows;
    if (row === undefined) throw new ApiError("not_found");
    return { ...row, roleId, systemKey };
  }

  /**
   * The accepted ownership transfer's two role changes (P6-06c, ADR 0085):
   * the one sanctioned exception to the self-change guard (ADR 0077 D13),
   * a method of its own, never a flag on setOrgRole(). The recipient
   * becomes owner first, then the initiator gets the previous role;
   * memberships_guard v2 lets exactly these through in the transaction
   * that accepted the transfer. Then the last-owner rule as a backstop
   * (it always holds: 409 otherwise, rolled back).
   */
  async transferOwnership(
    tx: Tx,
    orgId: string,
    input: {
      readonly recipientMembershipId: string;
      readonly ownerRoleId: string;
      readonly initiatorMembershipId: string;
      readonly previousRoleId: string;
    },
  ): Promise<void> {
    const steps: [string, string][] = [
      [input.recipientMembershipId, input.ownerRoleId],
      [input.initiatorMembershipId, input.previousRoleId],
    ];
    for (const [id, roleId] of steps) {
      let changed: { id: string }[];
      try {
        changed = await tx
          .update(memberships)
          .set({ roleId })
          .where(
            and(
              eq(memberships.orgId, orgId),
              eq(memberships.id, id),
              isNull(memberships.removedAt),
            ),
          )
          .returning({ id: memberships.id });
      } catch (error) {
        refuse(error);
      }
      if (changed.length !== 1) throw new ApiError("request.conflict");
    }
    if ((await this.countActiveOwners(tx, orgId)) < 1) {
      throw new ApiError("request.conflict");
    }
  }

  /** Sets removed_at on the open membership; undefined when none. */
  async removeOrg(
    tx: Tx,
    orgId: string,
    id: string,
    now: string,
  ): Promise<{ readonly id: string } | undefined> {
    const rows = await tx
      .update(memberships)
      .set({ removedAt: removedAt(memberships.createdAt, now) })
      .where(
        and(
          eq(memberships.orgId, orgId),
          eq(memberships.id, id),
          isNull(memberships.removedAt),
        ),
      )
      .returning({ id: memberships.id });
    return rows[0];
  }

  /** Closes the user's open project memberships in the org; how many. */
  async removeProjectsOfUser(
    tx: Tx,
    orgId: string,
    userId: string,
    now: string,
  ): Promise<number> {
    const rows = await tx
      .update(projectMemberships)
      .set({ removedAt: removedAt(projectMemberships.createdAt, now) })
      .where(
        and(
          eq(projectMemberships.orgId, orgId),
          eq(projectMemberships.userId, userId),
          isNull(projectMemberships.removedAt),
        ),
      )
      .returning({ id: projectMemberships.id });
    await tx
      .update(projectMembershipSites)
      .set({ removedAt: removedAt(projectMembershipSites.createdAt, now) })
      .where(
        and(
          eq(projectMembershipSites.orgId, orgId),
          eq(projectMembershipSites.userId, userId),
          isNull(projectMembershipSites.removedAt),
        ),
      );
    return rows.length;
  }

  /** The org's lock for the last-owner count (held until COMMIT). */
  async lockOrg(tx: Tx, orgId: string): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${MEMBERS_LOCK_NAMESPACE}::integer, hashtext(${orgId}))`,
    );
  }

  /**
   * How many ACTIVE memberships hold the virtual owner role (P6-06b, ADR
   * 0084: a suspended owner does not count; an owner is never temporary).
   */
  async countActiveOwners(tx: Tx, orgId: string): Promise<number> {
    const rows = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(memberships)
      .innerJoin(roles, roleJoin)
      .where(
        and(
          eq(memberships.orgId, orgId),
          isNull(memberships.removedAt),
          isNull(memberships.suspendedAt),
          eq(roles.systemKey, "owner"),
        ),
      );
    return rows[0]?.n ?? 0;
  }

  /** The project's open memberships, newest first, at most the limit. */
  async listProject(
    tx: Tx,
    orgId: string,
    projectId: string,
  ): Promise<ProjectMembershipRow[]> {
    const rows = await tx
      .select(projectColumns)
      .from(projectMemberships)
      .innerJoin(roles, projectRoleJoin)
      .where(
        and(
          eq(projectMemberships.orgId, orgId),
          eq(projectMemberships.projectId, projectId),
          isNull(projectMemberships.removedAt),
        ),
      )
      .orderBy(desc(projectMemberships.id))
      .limit(MEMBER_LIST_LIMIT);
    return rows.map(projectRowOf);
  }

  /** The project's open membership `id`, or undefined. */
  async findProject(
    tx: Tx,
    orgId: string,
    projectId: string,
    id: string,
  ): Promise<ProjectMembershipRow | undefined> {
    const rows = await tx
      .select(projectColumns)
      .from(projectMemberships)
      .innerJoin(roles, projectRoleJoin)
      .where(
        and(
          eq(projectMemberships.orgId, orgId),
          eq(projectMemberships.projectId, projectId),
          eq(projectMemberships.id, id),
          isNull(projectMemberships.removedAt),
        ),
      );
    const [row] = rows;
    return row === undefined ? undefined : projectRowOf(row);
  }

  /** Inserts one project membership (both override lists stored). */
  async insertProject(
    tx: Tx,
    input: NewProjectMembership,
    systemKey: string | null,
  ): Promise<ProjectMembershipRow> {
    let rows: { id: string; createdAt: string; removedAt: string | null }[];
    try {
      rows = await tx
        .insert(projectMemberships)
        .values({
          id: input.id,
          orgId: input.orgId,
          projectId: input.projectId,
          userId: input.userId,
          roleId: input.roleId,
          overrides: input.overrides,
          createdAt: input.now,
          expiresAt: input.expiresAt ?? null,
        })
        .returning({
          id: projectMemberships.id,
          createdAt: iso(projectMemberships.createdAt),
          removedAt: isoOrNull(projectMemberships.removedAt),
        });
    } catch (error) {
      refuse(error);
    }
    const [row] = rows;
    if (row === undefined) throw new Error("insert returned no row");
    return {
      ...row,
      projectId: input.projectId,
      userId: input.userId,
      roleId: input.roleId,
      systemKey,
      overrides: input.overrides,
      siteIds: [],
      ...fresh(input),
    };
  }

  /**
   * Inserts one project membership unless the user already has an open
   * one on that project (P6-06, ADR 0077, D12; ON CONFLICT on
   * project_memberships_open). undefined when one exists.
   */
  async insertProjectIfAbsent(
    tx: Tx,
    input: NewProjectMembership,
    systemKey: string | null,
  ): Promise<ProjectMembershipRow | undefined> {
    let rows: { id: string; createdAt: string; removedAt: string | null }[];
    try {
      rows = await tx
        .insert(projectMemberships)
        .values({
          id: input.id,
          orgId: input.orgId,
          projectId: input.projectId,
          userId: input.userId,
          roleId: input.roleId,
          overrides: input.overrides,
          createdAt: input.now,
          expiresAt: input.expiresAt ?? null,
        })
        .onConflictDoNothing({
          target: [
            projectMemberships.orgId,
            projectMemberships.projectId,
            projectMemberships.userId,
          ],
          where: sql`${projectMemberships.removedAt} IS NULL`,
        })
        .returning({
          id: projectMemberships.id,
          createdAt: iso(projectMemberships.createdAt),
          removedAt: isoOrNull(projectMemberships.removedAt),
        });
    } catch (error) {
      refuse(error);
    }
    const [row] = rows;
    if (row === undefined) return undefined;
    return {
      ...row,
      projectId: input.projectId,
      userId: input.userId,
      roleId: input.roleId,
      systemKey,
      overrides: input.overrides,
      siteIds: [],
      ...fresh(input),
    };
  }

  /** A new role and/or overrides on the open project membership. */
  async updateProject(
    tx: Tx,
    orgId: string,
    id: string,
    patch: {
      readonly roleId: string;
      readonly systemKey: string | null;
      readonly overrides: { readonly add: string[]; readonly remove: string[] };
    },
  ): Promise<ProjectMembershipRow> {
    let rows: (Lifecycle & {
      id: string;
      projectId: string;
      userId: string;
      createdAt: string;
      removedAt: string | null;
      siteIds: unknown;
    })[];
    try {
      rows = await tx
        .update(projectMemberships)
        .set({ roleId: patch.roleId, overrides: patch.overrides })
        .where(
          and(
            eq(projectMemberships.orgId, orgId),
            eq(projectMemberships.id, id),
            isNull(projectMemberships.removedAt),
          ),
        )
        .returning({
          id: projectMemberships.id,
          projectId: projectMemberships.projectId,
          userId: projectMemberships.userId,
          createdAt: iso(projectMemberships.createdAt),
          removedAt: isoOrNull(projectMemberships.removedAt),
          ...projectLifecycle,
          siteIds: projectColumns.siteIds,
        });
    } catch (error) {
      refuse(error);
    }
    const [row] = rows;
    if (row === undefined) throw new ApiError("not_found");
    return {
      ...row,
      siteIds: siteIdsOf(row.siteIds),
      roleId: patch.roleId,
      systemKey: patch.systemKey,
      overrides: patch.overrides,
    };
  }

  /** Sets removed_at on the open project membership; undefined when none. */
  async removeProject(
    tx: Tx,
    orgId: string,
    id: string,
    now: string,
  ): Promise<{ readonly id: string } | undefined> {
    const rows = await tx
      .update(projectMemberships)
      .set({ removedAt: removedAt(projectMemberships.createdAt, now) })
      .where(
        and(
          eq(projectMemberships.orgId, orgId),
          eq(projectMemberships.id, id),
          isNull(projectMemberships.removedAt),
        ),
      )
      .returning({ id: projectMemberships.id });
    if (rows[0] !== undefined) {
      await tx
        .update(projectMembershipSites)
        .set({ removedAt: removedAt(projectMembershipSites.createdAt, now) })
        .where(
          and(
            eq(projectMembershipSites.orgId, orgId),
            eq(projectMembershipSites.projectMembershipId, id),
            isNull(projectMembershipSites.removedAt),
          ),
        );
    }
    return rows[0];
  }

  /**
   * Replaces the membership's open site assignment with `siteIds` (P6-05,
   * C4): the dropped sites' rows are closed, the new ones inserted; the
   * sorted list held afterwards. A foreign key violation (a site not of
   * this project) is ApiError("not_found"), the service's check before
   * it being the rule.
   */
  async setSites(tx: Tx, input: SiteAssignment): Promise<string[]> {
    const wanted = [...new Set(input.siteIds)].sort();
    await tx
      .update(projectMembershipSites)
      .set({ removedAt: input.now })
      .where(
        and(
          eq(projectMembershipSites.orgId, input.orgId),
          eq(projectMembershipSites.projectMembershipId, input.membershipId),
          isNull(projectMembershipSites.removedAt),
          wanted.length === 0
            ? undefined
            : notInArray(projectMembershipSites.siteId, wanted),
        ),
      );
    if (wanted.length === 0) return [];
    const held = await tx
      .select({ siteId: projectMembershipSites.siteId })
      .from(projectMembershipSites)
      .where(
        and(
          eq(projectMembershipSites.orgId, input.orgId),
          eq(projectMembershipSites.projectMembershipId, input.membershipId),
          isNull(projectMembershipSites.removedAt),
        ),
      );
    const have = new Set(held.map((row) => row.siteId));
    const added = wanted.filter((siteId) => !have.has(siteId));
    if (added.length > 0) {
      try {
        await tx.insert(projectMembershipSites).values(
          added.map((siteId) => ({
            id: input.nextId(),
            orgId: input.orgId,
            projectId: input.projectId,
            projectMembershipId: input.membershipId,
            userId: input.userId,
            siteId,
            createdAt: input.now,
          })),
        );
      } catch (error) {
        refuse(error);
      }
    }
    return wanted;
  }

  /**
   * The open org and project memberships of `userIds` in the org, with
   * their roles' system_key: what the MFA computation needs. Project rows
   * are the ones the transaction may read (app.has_project), so an
   * editor without the wildcard sees the projects they hold only (for
   * architect review).
   */
  async accessRowsOf(
    tx: Tx,
    orgId: string,
    userIds: readonly string[],
  ): Promise<AccessRows> {
    if (userIds.length === 0) return { memberships: [], projects: [] };
    const ids = [...userIds];
    const members = await tx
      .select(memberColumns)
      .from(memberships)
      .innerJoin(roles, roleJoin)
      .where(
        and(
          eq(memberships.orgId, orgId),
          inArray(memberships.userId, ids),
          isNull(memberships.removedAt),
        ),
      );
    const projects = await tx
      .select(projectColumns)
      .from(projectMemberships)
      .innerJoin(roles, projectRoleJoin)
      .where(
        and(
          eq(projectMemberships.orgId, orgId),
          inArray(projectMemberships.userId, ids),
          isNull(projectMemberships.removedAt),
        ),
      );
    return { memberships: members, projects: projects.map(projectRowOf) };
  }

  /** The caller's own open rows in every org (the own-row policies). */
  async listMine(tx: Tx, userId: string): Promise<MyRows> {
    const mine = await tx
      .select({
        id: memberships.id,
        orgId: memberships.orgId,
        roleId: memberships.roleId,
        createdAt: iso(memberships.createdAt),
        suspendedAt: ms(memberships.suspendedAt),
        expiresAt: ms(memberships.expiresAt),
        external: memberships.isExternal,
      })
      .from(memberships)
      .where(and(eq(memberships.userId, userId), isNull(memberships.removedAt)))
      .orderBy(desc(memberships.id))
      .limit(MEMBER_LIST_LIMIT);
    const projects = await tx
      .select({
        orgId: projectMemberships.orgId,
        projectId: projectMemberships.projectId,
      })
      .from(projectMemberships)
      .where(
        and(
          eq(projectMemberships.userId, userId),
          isNull(projectMemberships.removedAt),
        ),
      )
      .orderBy(desc(projectMemberships.id))
      .limit(MY_PROJECTS_LIMIT);
    return { memberships: mine, projects };
  }
}
