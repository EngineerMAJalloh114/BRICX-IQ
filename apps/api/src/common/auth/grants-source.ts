// Where an identity's projects and grants come from (P5-02, ADR 0062,
// owner condition 1; P5-05, ADR 0066, phase ruling D7, owner condition
// 2). The auth guard asks once per request, after the token is verified
// and the user provisioned, for the org the request chose; undefined is
// "no open membership there" (403 membership_missing). Production binds
// DbGrantsSource: one withTx() as that org and user (no project ids)
// reading, through the own-row policies, the user's open org membership
// and its role, the user's open project memberships there (newest first,
// at most MAX_PROJECT_MEMBERSHIPS) and their roles, and the open
// role_permissions of those roles; buildAccess() turns the rows into
// grants:
// - the org membership's keys: org and own scope as they are; project
//   and site keys are dropped (an org role names no project);
// - each project membership: effectiveKeys(bundle, overrides) from
//   @bricx/permissions; project keys become one grant per permission
//   listing every project it is held on, own keys stay, org keys are
//   dropped (no project row grants beyond the project) and site keys
//   wait for P6-05's site assignment (for architect review);
// - a role with system_key owner is the virtual bundle ROLES.owner from
//   code (its rows carry no permissions); an archived role grants nothing
//   while its memberships stand (for architect review);
// - a key the catalogue no longer knows is dropped and counted
//   (unknownKeys; the guard logs one grants.unknown_permission line);
// - allProjects (app.project_ids = '*', the typed withTx() option) when an
//   org-scoped grant names a project- or site-level resource: what org
//   scope already means in CASL. A project-scope-only identity never gets
//   it, and nothing else (a claim, a header) can set it.
// P5-06 (ADR 0067, DW2, DW5): the same transaction also reads the user's
// active access_grants rows (temporary elevations) at the instant of the
// injected Clock, bound as a parameter, never now(): starts_at <= t <
// expires_at and not revoked (expired_at is the worker's record, not the
// rule). An elevation is one catalogue key at one scope: an org key
// becomes an org grant, a project key a project grant on its scope_id,
// merged with the membership's grants; anything else (site, own, a
// project key without a scope, an org key with one) is dropped and an
// unknown key counted. allProjects and projectIds come from the
// memberships alone: an elevation never sets app.project_ids = '*' and
// adds no project id (a project the user left stays hidden by RLS; for
// architect review). At most MAX_ACCESS_GRANTS rows are read, newest
// first (the API caps open grants per user well below it).
// PR #71 review, amendment 3 (ADR 0067): membershipGrants is the same
// computation before the elevations are merged, the grants a granter is
// checked against (no transitive elevation: a key held only through an
// elevation never lets its holder elevate someone else).
// Tests bind their own source through createApp's test-only option
// (test/support); src never maps role names to grants.
import type { Database } from "@bricx/db/database";
import { type ProjectId, isProjectId } from "@bricx/ids/branded";
import type { Grant } from "@bricx/permissions/ability";
import {
  type CatalogueKey,
  type PermissionName,
  parseCatalogueKey,
  resourceOf,
  splitPermission,
} from "@bricx/permissions/catalogue";
import { effectiveKeys, knownKeys } from "@bricx/permissions/overrides";
import { ROLES } from "@bricx/permissions/roles";
import { sql } from "drizzle-orm";
import type { Clock } from "../clock.js";

export interface Access {
  readonly projectIds: readonly string[];
  readonly grants: readonly Grant[];
  /** The grants from the memberships alone, without any elevation (amendment 3). */
  readonly membershipGrants: readonly Grant[];
  /** Every project of the org (app.project_ids = '*'); then projectIds is empty. */
  readonly allProjects: boolean;
  /** Stored keys the catalogue does not know, dropped (logged by the guard). */
  readonly unknownKeys?: number;
}

export interface GrantsSource {
  /** The user's access in the org, or undefined without an open membership there. */
  grantsFor(user: {
    readonly userId: string;
    readonly orgId: string;
  }): Promise<Access | undefined>;
}

export const GRANTS_SOURCE = Symbol("GRANTS_SOURCE");

/**
 * Most project memberships read per request, newest first: with the
 * catalogue's 61 project-scope keys, 100 projects stay under
 * LIMITS.targetsTotal (10 000) and LIMITS.targetsPerGrant (1 000); the
 * unit test checks the arithmetic. (for architect review)
 */
export const MAX_PROJECT_MEMBERSHIPS = 100;

/**
 * Most active elevations read per request, newest first (P5-06): the
 * API allows ACCESS_GRANTS_MAX_PER_USER (at most 1 000) open grants per
 * user and org, so the cap is a bound on a schema violation, not a
 * working limit. (for architect review)
 */
export const MAX_ACCESS_GRANTS = 1_000;

/** A membership row joined with its role. */
export interface RoleRow {
  readonly roleId: string;
  readonly systemKey: string | null;
  readonly archived: boolean;
}

/** A project_memberships.overrides value as stored (lists of anything). */
export interface StoredOverrides {
  readonly add?: readonly unknown[] | undefined;
  readonly remove?: readonly unknown[] | undefined;
}

export interface ProjectRow extends RoleRow {
  readonly projectId: string;
  readonly overrides: StoredOverrides;
}

/** An active access_grants row (P5-06): one catalogue key at one scope. */
export interface ElevationRow {
  readonly permission: string;
  /** The project of a project-scoped key; null for an org-scoped one. */
  readonly scopeId: string | null;
}

/** What the source read for one user in one org. */
export interface AccessRows {
  readonly membership: RoleRow;
  readonly projects: readonly ProjectRow[];
  /** Open role_permissions keys per role id (absent: none). */
  readonly permissions: ReadonlyMap<string, readonly string[]>;
  /** The user's elevations active at the Clock's instant (P5-06). */
  readonly elevations: readonly ElevationRow[];
}

/** The keys a role row grants: the virtual owner bundle, nothing when archived, else its open rows. */
function bundleOf(role: RoleRow, rows: AccessRows): readonly string[] {
  if (role.archived) return [];
  if (role.systemKey === "owner") return ROLES.owner;
  return rows.permissions.get(role.roleId) ?? [];
}

/** The strings of a stored override list, and how many entries were not strings. */
function stringsOf(value: readonly unknown[] | undefined): {
  keys: string[];
  dropped: number;
} {
  const keys: string[] = [];
  let dropped = 0;
  for (const entry of value ?? []) {
    if (typeof entry === "string") keys.push(entry);
    else dropped += 1;
  }
  return { keys, dropped };
}

const isProjectLevel = (permission: PermissionName): boolean => {
  const parts = splitPermission(permission);
  const level =
    parts === undefined ? undefined : resourceOf(parts.subject)?.level;
  return level === "project" || level === "site";
};

/** The grants of the three sets, sorted by permission, then scope. */
function grantsOf(
  org: ReadonlySet<PermissionName>,
  own: ReadonlySet<PermissionName>,
  project: ReadonlyMap<PermissionName, ReadonlySet<ProjectId>>,
): Grant[] {
  return [
    ...[...org].map((permission): Grant => ({ permission, scope: "org" })),
    ...[...own].map((permission): Grant => ({ permission, scope: "own" })),
    ...[...project].map(([permission, targets]): Grant => ({
      permission,
      scope: "project",
      projectIds: [...targets].sort(),
    })),
  ].sort((a, b) =>
    a.permission === b.permission
      ? a.scope < b.scope
        ? -1
        : 1
      : a.permission < b.permission
        ? -1
        : 1,
  );
}

/** The grants, project ids and wildcard of `rows` (pure; see the header). */
export function buildAccess(rows: AccessRows): Access {
  let unknownKeys = 0;
  const org = new Set<PermissionName>();
  const own = new Set<PermissionName>();
  const project = new Map<PermissionName, Set<ProjectId>>();
  const projectIds = new Set<ProjectId>();

  const orgKeys = knownKeys(bundleOf(rows.membership, rows));
  unknownKeys += orgKeys.unknown;
  for (const key of orgKeys.known) {
    const parsed = parseCatalogueKey(key);
    if (parsed === undefined) continue;
    if (parsed.scope === "org") org.add(parsed.permission);
    else if (parsed.scope === "own") own.add(parsed.permission);
  }

  for (const row of rows.projects) {
    if (!isProjectId(row.projectId)) continue;
    projectIds.add(row.projectId);
    const add = stringsOf(row.overrides.add);
    const remove = stringsOf(row.overrides.remove);
    const bundle = bundleOf(row, rows);
    unknownKeys +=
      knownKeys(bundle).unknown +
      knownKeys(add.keys).unknown +
      knownKeys(remove.keys).unknown +
      add.dropped +
      remove.dropped;
    const keys: readonly CatalogueKey[] = effectiveKeys(bundle, {
      add: add.keys,
      remove: remove.keys,
    });
    for (const key of keys) {
      const parsed = parseCatalogueKey(key);
      if (parsed === undefined) continue;
      if (parsed.scope === "project") {
        const targets = project.get(parsed.permission) ?? new Set<ProjectId>();
        targets.add(row.projectId);
        project.set(parsed.permission, targets);
      } else if (parsed.scope === "own") {
        own.add(parsed.permission);
      }
    }
  }

  // allProjects is settled before the elevations are merged: it comes
  // from the membership's org keys alone (DW5).
  const allProjects = [...org].some(isProjectLevel);
  // So are the membership grants (amendment 3), from copies the
  // elevations below do not touch.
  const membershipGrants = grantsOf(org, own, project);

  for (const row of rows.elevations) {
    const known = knownKeys([row.permission]);
    unknownKeys += known.unknown;
    const key = known.known[0];
    const parsed = key === undefined ? undefined : parseCatalogueKey(key);
    if (parsed === undefined) continue;
    if (parsed.scope === "org" && row.scopeId === null) {
      org.add(parsed.permission);
    } else if (
      parsed.scope === "project" &&
      row.scopeId !== null &&
      isProjectId(row.scopeId)
    ) {
      const targets = project.get(parsed.permission) ?? new Set<ProjectId>();
      targets.add(row.scopeId);
      project.set(parsed.permission, targets);
    }
  }

  return {
    projectIds: allProjects ? [] : [...projectIds].sort(),
    grants: grantsOf(org, own, project),
    membershipGrants,
    allProjects,
    unknownKeys,
  };
}

type MembershipRow = Record<string, unknown> & {
  readonly role_id: unknown;
  readonly system_key: unknown;
  readonly archived: unknown;
};
type ProjectMembershipRow = MembershipRow & {
  readonly project_id: unknown;
  readonly overrides: unknown;
};
type PermissionRow = Record<string, unknown> & {
  readonly role_id: unknown;
  readonly permission: unknown;
};
type ElevationDbRow = Record<string, unknown> & {
  readonly permission: unknown;
  readonly scope_id: unknown;
};

/** The rows read are not what the schema promises. */
export class GrantsRowError extends Error {
  constructor() {
    super("grants: unexpected row");
  }
}
Object.defineProperty(GrantsRowError.prototype, "name", {
  value: "GrantsRowError",
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function roleRowOf(row: MembershipRow): RoleRow {
  if (
    typeof row.role_id !== "string" ||
    !UUID.test(row.role_id) ||
    (row.system_key !== null && typeof row.system_key !== "string") ||
    typeof row.archived !== "boolean"
  ) {
    throw new GrantsRowError();
  }
  return {
    roleId: row.role_id,
    systemKey: row.system_key,
    archived: row.archived,
  };
}

/** A stored list, when the value is one (the entries are checked by buildAccess). */
function listOf(value: unknown): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const list: readonly unknown[] = value;
  return list;
}

function overridesOf(value: unknown): StoredOverrides {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return {
    add: listOf(Reflect.get(value, "add")),
    remove: listOf(Reflect.get(value, "remove")),
  };
}

/** Production: the membership and elevation rows, through withTx() as the chosen org. */
export class DbGrantsSource implements GrantsSource {
  constructor(
    private readonly database: Database,
    private readonly clock: Clock,
  ) {}

  grantsFor(user: {
    readonly userId: string;
    readonly orgId: string;
  }): Promise<Access | undefined> {
    // The instant every elevation is judged at: read once, before the
    // transaction, and bound as a parameter (never the database's now()).
    const at = new Date(this.clock.now()).toISOString();
    return this.database.withTx(
      { orgId: user.orgId, userId: user.userId, projectIds: [] },
      async (tx) => {
        const membership = await tx.execute<MembershipRow>(
          sql`SELECT r.id::text AS role_id, r.system_key, (r.archived_at IS NOT NULL) AS archived
              FROM bricx.memberships m
              JOIN bricx.roles r ON r.org_id = m.org_id AND r.id = m.role_id
              WHERE m.org_id = app.current_org() AND m.user_id = app.current_user_id() AND m.removed_at IS NULL
              LIMIT 2`,
        );
        const first = membership.rows[0];
        if (first === undefined) return undefined;
        if (membership.rows.length !== 1) throw new GrantsRowError();
        const projects = await tx.execute<ProjectMembershipRow>(
          sql`SELECT pm.project_id::text AS project_id, pm.overrides, r.id::text AS role_id, r.system_key, (r.archived_at IS NOT NULL) AS archived
              FROM bricx.project_memberships pm
              JOIN bricx.roles r ON r.org_id = pm.org_id AND r.id = pm.role_id
              WHERE pm.org_id = app.current_org() AND pm.user_id = app.current_user_id() AND pm.removed_at IS NULL
              ORDER BY pm.created_at DESC, pm.id DESC
              LIMIT ${MAX_PROJECT_MEMBERSHIPS}`,
        );
        const elevations = await tx.execute<ElevationDbRow>(
          sql`SELECT g.permission, g.scope_id::text AS scope_id
              FROM bricx.access_grants g
              WHERE g.org_id = app.current_org() AND g.user_id = app.current_user_id()
                AND g.revoked_at IS NULL
                AND g.starts_at <= ${at}::timestamptz AND ${at}::timestamptz < g.expires_at
              ORDER BY g.created_at DESC, g.id DESC
              LIMIT ${MAX_ACCESS_GRANTS}`,
        );
        const rows: AccessRows = {
          membership: roleRowOf(first),
          projects: projects.rows.map((row) => {
            if (typeof row.project_id !== "string") throw new GrantsRowError();
            return {
              ...roleRowOf(row),
              projectId: row.project_id,
              overrides: overridesOf(row.overrides),
            };
          }),
          permissions: new Map(),
          elevations: elevations.rows.map((row) => {
            if (
              typeof row.permission !== "string" ||
              (row.scope_id !== null && typeof row.scope_id !== "string")
            ) {
              throw new GrantsRowError();
            }
            return { permission: row.permission, scopeId: row.scope_id };
          }),
        };
        const roleIds = [
          ...new Set(
            [rows.membership, ...rows.projects]
              .filter((r) => !r.archived && r.systemKey !== "owner")
              .map((r) => r.roleId),
          ),
        ];
        const permissions = new Map<string, string[]>();
        if (roleIds.length > 0) {
          // One bind parameter, a Postgres array literal of the UUIDs
          // roleRowOf() checked (Drizzle would expand a JavaScript array
          // into one parameter per element).
          const literal = `{${roleIds.join(",")}}`;
          const result = await tx.execute<PermissionRow>(
            sql`SELECT role_id::text AS role_id, permission
                FROM bricx.role_permissions
                WHERE org_id = app.current_org() AND role_id = ANY(${literal}::uuid[]) AND revoked_at IS NULL
                ORDER BY role_id, permission`,
          );
          for (const row of result.rows) {
            if (
              typeof row.role_id !== "string" ||
              typeof row.permission !== "string"
            ) {
              throw new GrantsRowError();
            }
            const keys = permissions.get(row.role_id) ?? [];
            keys.push(row.permission);
            permissions.set(row.role_id, keys);
          }
        }
        return buildAccess({ ...rows, permissions });
      },
    );
  }
}
