// Roles' repository (P5-05, ADR 0066): every statement runs in the `tx`
// TxRunner hands over, as bricx_app under RLS (org_id = app.current_org()
// on roles and role_permissions); the statements add the org id too, so
// the policy check in the service is the only thing deciding whose rows
// are touched. A list is the open rows (archived_at IS NULL), newest first
// (by id: UUIDv7), at most ROLE_LIST_LIMIT; a bundle is the open
// role_permissions rows (revoked_at IS NULL). A unique violation on the
// key (SQLSTATE 23505) is ApiError("request.conflict") here and only here.
import { type Tx, sqlstateOf } from "@bricx/db/database";
import {
  memberships,
  projectMemberships,
  rolePermissions,
  roles,
} from "@bricx/db/schema";
import { Injectable } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { ApiError } from "../../common/errors/api-error.js";

/** Most rows a role list returns. */
export const ROLE_LIST_LIMIT = 100;
const UNIQUE_VIOLATION = "23505";

const iso = (column: typeof roles.createdAt) =>
  sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const isoOrNull = (column: typeof roles.archivedAt) =>
  sql<
    string | null
  >`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const columns = {
  id: roles.id,
  key: roles.key,
  name: roles.name,
  systemKey: roles.systemKey,
  createdAt: iso(roles.createdAt),
  updatedAt: iso(roles.updatedAt),
  archivedAt: isoOrNull(roles.archivedAt),
};

/** A roles row without its bundle. */
export interface RoleRow {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly systemKey: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

export interface NewRole {
  readonly id: string;
  readonly orgId: string;
  readonly key: string;
  readonly name: string;
  readonly now: string;
}

@Injectable()
export class RolesRepository {
  /** The org's open roles, newest first, at most the limit. */
  list(tx: Tx, orgId: string): Promise<RoleRow[]> {
    return tx
      .select(columns)
      .from(roles)
      .where(and(eq(roles.orgId, orgId), isNull(roles.archivedAt)))
      .orderBy(desc(roles.id))
      .limit(ROLE_LIST_LIMIT);
  }

  /** The org's open role `id`, or undefined. */
  async findOpen(
    tx: Tx,
    orgId: string,
    id: string,
  ): Promise<RoleRow | undefined> {
    const rows = await tx
      .select(columns)
      .from(roles)
      .where(
        and(eq(roles.orgId, orgId), eq(roles.id, id), isNull(roles.archivedAt)),
      );
    return rows[0];
  }

  /** The open keys of each of `roleIds`, sorted per role (absent: none). */
  async bundles(
    tx: Tx,
    orgId: string,
    roleIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly string[]>> {
    const out = new Map<string, string[]>();
    if (roleIds.length === 0) return out;
    const rows = await tx
      .select({
        roleId: rolePermissions.roleId,
        permission: rolePermissions.permission,
      })
      .from(rolePermissions)
      .where(
        and(
          eq(rolePermissions.orgId, orgId),
          inArray(rolePermissions.roleId, [...roleIds]),
          isNull(rolePermissions.revokedAt),
        ),
      )
      .orderBy(rolePermissions.roleId, rolePermissions.permission);
    for (const row of rows) {
      const keys = out.get(row.roleId) ?? [];
      keys.push(row.permission);
      out.set(row.roleId, keys);
    }
    return out;
  }

  /** Inserts one role; a unique violation (the key) is request.conflict. */
  async insert(tx: Tx, role: NewRole): Promise<RoleRow> {
    let rows: RoleRow[];
    try {
      rows = await tx
        .insert(roles)
        .values({
          id: role.id,
          orgId: role.orgId,
          key: role.key,
          name: role.name,
          systemKey: null,
          createdAt: role.now,
          updatedAt: role.now,
        })
        .returning(columns);
    } catch (error) {
      if (sqlstateOf(error) === UNIQUE_VIOLATION) {
        throw new ApiError("request.conflict");
      }
      throw error;
    }
    const [row] = rows;
    if (row === undefined) throw new Error("insert returned no row");
    return row;
  }

  /** Opens one row per key (ids made by the caller). */
  async grant(
    tx: Tx,
    orgId: string,
    roleId: string,
    rows: readonly { readonly id: string; readonly permission: string }[],
    now: string,
  ): Promise<void> {
    if (rows.length === 0) return;
    await tx.insert(rolePermissions).values(
      rows.map((row) => ({
        id: row.id,
        orgId,
        roleId,
        permission: row.permission,
        grantedAt: now,
      })),
    );
  }

  /** Closes the open rows of `keys`. */
  async revoke(
    tx: Tx,
    orgId: string,
    roleId: string,
    keys: readonly string[],
    now: string,
  ): Promise<void> {
    if (keys.length === 0) return;
    await tx
      .update(rolePermissions)
      .set({ revokedAt: now })
      .where(
        and(
          eq(rolePermissions.orgId, orgId),
          eq(rolePermissions.roleId, roleId),
          inArray(rolePermissions.permission, [...keys]),
          isNull(rolePermissions.revokedAt),
        ),
      );
  }

  /** A new name and/or updated_at. */
  async touch(
    tx: Tx,
    orgId: string,
    id: string,
    patch: { readonly name?: string | undefined; readonly now: string },
  ): Promise<RoleRow> {
    const rows = await tx
      .update(roles)
      .set({
        updatedAt: patch.now,
        ...(patch.name === undefined ? {} : { name: patch.name }),
      })
      .where(and(eq(roles.orgId, orgId), eq(roles.id, id)))
      .returning(columns);
    const [row] = rows;
    if (row === undefined) throw new Error("update returned no row");
    return row;
  }

  /** Sets archived_at (and updated_at) on the open role. */
  async archive(
    tx: Tx,
    orgId: string,
    id: string,
    now: string,
  ): Promise<RoleRow | undefined> {
    const rows = await tx
      .update(roles)
      .set({ archivedAt: now, updatedAt: now })
      .where(
        and(eq(roles.orgId, orgId), eq(roles.id, id), isNull(roles.archivedAt)),
      )
      .returning(columns);
    return rows[0];
  }

  /**
   * The distinct users holding the role through an open org or project
   * membership, at most `limit` (the caller judges the count).
   */
  async memberUserIds(
    tx: Tx,
    orgId: string,
    roleId: string,
    limit: number,
  ): Promise<string[]> {
    const result = await tx.execute<{ user_id: string }>(
      sql`SELECT user_id::text AS user_id FROM (
            SELECT user_id FROM ${memberships}
             WHERE ${memberships.orgId} = ${orgId} AND ${memberships.roleId} = ${roleId} AND ${memberships.removedAt} IS NULL
            UNION
            SELECT user_id FROM ${projectMemberships}
             WHERE ${projectMemberships.orgId} = ${orgId} AND ${projectMemberships.roleId} = ${roleId} AND ${projectMemberships.removedAt} IS NULL
          ) AS holders ORDER BY user_id LIMIT ${limit}`,
    );
    return result.rows.map((row) => row.user_id);
  }
}
