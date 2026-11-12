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
//   become site grants on the membership's open assigned sites (P6-05,
//   ADR 0075 D15, owner condition C4: no assigned site, no site key; on
//   an archived site only read keys stay);
// - a role with system_key owner is the virtual bundle ROLES.owner from
//   code (its rows carry no permissions); an archived role grants nothing
//   while its memberships stand (for architect review);
// - a key the catalogue no longer knows is dropped and counted
//   (unknownKeys; the guard logs one grants.unknown_permission line);
// - allProjects (app.project_ids = '*', the typed withTx() option) when an
//   org-scoped grant names a project- or site-level resource: what org
//   scope already means in CASL. A project-scope-only identity never gets
//   it, and nothing else (a claim, a header) can set it.
// P5-07 (ADR 0068): the reads are accessRowsFor(), shared with
// SodService (the approver candidates, decision D-C).
// P5-06 (ADR 0067, DW2, DW5): the same transaction also reads the user's
// active access_grants rows (temporary elevations) at the instant of the
// injected Clock, bound as a parameter, never now(): starts_at <= t <
// expires_at and not revoked (expired_at is the worker's record, not the
// rule). An elevation is one catalogue key at one scope: an org key
// becomes an org grant, a project key a project grant on its scope_id,
// merged with the membership's grants; P6-05 (ADR 0075, amending ADR
// 0067; C9): a site key with scope_id and site_id a site grant on that
// site (read keys only once the site is archived); anything else (own, a
// project key without a scope or with a site, an org key with either, a
// site key without both) is dropped and an unknown key counted. allProjects and projectIds come from the
// memberships alone: an elevation never sets app.project_ids = '*' and
// adds no project id (a project the user left stays hidden by RLS; for
// architect review). At most MAX_ACCESS_GRANTS rows are read, newest
// first (the API caps open grants per user well below it).
// PR #71 review, amendment 3 (ADR 0067): membershipGrants is the same
// computation before the elevations are merged, the grants a granter is
// checked against (no transitive elevation: a key held only through an
// elevation never lets its holder elevate someone else).
// P6-02 (ADR 0072, D6/D16): the same transaction reads whether the org is
// archived (bricx.organizations, visible to its own context only); an
// archived org is orgArchived, which the guard answers with 404.
// P6-06b (ADR 0084, owner conditions C1, C3): the rows read are ACTIVE
// memberships: not removed, not suspended, not past expires_at at the
// request's Clock (bound, never now()); the same three conditions on the
// org row and on every project row. A suspended or expired org
// membership is therefore "no membership" (403 membership_missing) on the
// next request, and a project one drops that project. An EXTERNAL member
// (memberships.is_external) keeps, of the org role's bundle, the
// org-scope keys of EXTERNAL_ORG_KEYS only and no own-scope key, and an
// org-scope elevation is dropped: their grants are a subset of an
// internal member's with the same rows.
// Tests bind their own source through createApp's test-only option
// (test/support); src never maps role names to grants.
import type { Database, Tx } from "@bricx/db/database";
import {
  type ProjectId,
  type SiteId,
  isProjectId,
  isSiteId,
} from "@bricx/ids/branded";
import type { Grant } from "@bricx/permissions/ability";
import {
  type CatalogueKey,
  type PermissionName,
  parseCatalogueKey,
  resourceOf,
  splitPermission,
} from "@bricx/permissions/catalogue";
import { externalKeepsOrgKey } from "@bricx/permissions/external";
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
  /** The org is archived (P6-02): 404 except on @AllowArchivedOrg() routes. */
  readonly orgArchived?: boolean;
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

/** A site assigned to a project membership (P6-05, C4). */
export interface AssignedSite {
  readonly siteId: string;
  readonly archived: boolean;
}

export interface ProjectRow extends RoleRow {
  readonly projectId: string;
  readonly overrides: StoredOverrides;
  /** The membership's open site assignments (P6-05); absent or empty: none. */
  readonly sites?: readonly AssignedSite[];
}

/** An active access_grants row (P5-06): one catalogue key at one scope. */
export interface ElevationRow {
  readonly permission: string;
  /** The project of a project- or site-scoped key; null for an org-scoped one. */
  readonly scopeId: string | null;
  /** The site of a site-scoped key (P6-05, C9); null or absent otherwise. */
  readonly siteId?: string | null;
  /** Whether that site is archived (P6-05, C4). */
  readonly siteArchived?: boolean;
}

/** What the source read for one user in one org. */
export interface AccessRows {
  readonly membership: RoleRow;
  readonly projects: readonly ProjectRow[];
  /** Open role_permissions keys per role id (absent: none). */
  readonly permissions: ReadonlyMap<string, readonly string[]>;
  /** The user's elevations active at the Clock's instant (P5-06). */
  readonly elevations: readonly ElevationRow[];
  /** memberships.is_external (P6-06b, ADR 0084); absent: internal. */
  readonly external?: boolean;
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

/** A read key: kept on an archived site (P6-05, C4). */
const isRead = (permission: PermissionName): boolean =>
  splitPermission(permission)?.action === "read";

/** Adds `target` to the set of `permission` in `map`. */
function addTarget<T>(
  map: Map<PermissionName, Set<T>>,
  permission: PermissionName,
  target: T,
): void {
  const targets = map.get(permission) ?? new Set<T>();
  targets.add(target);
  map.set(permission, targets);
}

/** A copy of a target map whose sets the caller may still change. */
const copyTargets = <T>(
  map: ReadonlyMap<PermissionName, ReadonlySet<T>>,
): Map<PermissionName, Set<T>> =>
  new Map([...map].map(([permission, set]) => [permission, new Set(set)]));

/** The grants of the four sets, sorted by permission, then scope. */
function grantsOf(
  org: ReadonlySet<PermissionName>,
  own: ReadonlySet<PermissionName>,
  project: ReadonlyMap<PermissionName, ReadonlySet<ProjectId>>,
  site: ReadonlyMap<PermissionName, ReadonlySet<SiteId>>,
): Grant[] {
  return [
    ...[...org].map((permission): Grant => ({ permission, scope: "org" })),
    ...[...own].map((permission): Grant => ({ permission, scope: "own" })),
    ...[...project].map(([permission, targets]): Grant => ({
      permission,
      scope: "project",
      projectIds: [...targets].sort(),
    })),
    ...[...site].map(([permission, targets]): Grant => ({
      permission,
      scope: "site",
      siteIds: [...targets].sort(),
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
  const site = new Map<PermissionName, Set<SiteId>>();
  const projectIds = new Set<ProjectId>();

  const external = rows.external === true;
  const orgKeys = knownKeys(bundleOf(rows.membership, rows));
  unknownKeys += orgKeys.unknown;
  for (const key of orgKeys.known) {
    const parsed = parseCatalogueKey(key);
    if (parsed === undefined) continue;
    // An external member's org role: the allowlisted org-scope keys only.
    if (external && !externalKeepsOrgKey(key)) continue;
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
        addTarget(project, parsed.permission, row.projectId);
      } else if (parsed.scope === "own") {
        own.add(parsed.permission);
      } else if (parsed.scope === "site") {
        for (const assigned of row.sites ?? []) {
          if (!isSiteId(assigned.siteId)) continue;
          if (assigned.archived && !isRead(parsed.permission)) continue;
          addTarget(site, parsed.permission, assigned.siteId);
        }
      }
    }
  }

  // allProjects is settled before the elevations are merged: it comes
  // from the membership's org keys alone (DW5).
  const allProjects = [...org].some(isProjectLevel);
  // So are the membership grants (amendment 3), from copies the
  // elevations below do not touch.
  const membershipGrants = grantsOf(org, own, project, site);
  const elevatedOrg = new Set(org);
  const elevatedProject = copyTargets(project);
  const elevatedSite = copyTargets(site);

  for (const row of rows.elevations) {
    const known = knownKeys([row.permission]);
    unknownKeys += known.unknown;
    const key = known.known[0];
    const parsed = key === undefined ? undefined : parseCatalogueKey(key);
    if (parsed === undefined) continue;
    const siteId = row.siteId ?? null;
    if (parsed.scope === "org" && row.scopeId === null && siteId === null) {
      // Never an org-scope elevation for an external member (C3).
      if (!external) elevatedOrg.add(parsed.permission);
    } else if (
      parsed.scope === "project" &&
      row.scopeId !== null &&
      isProjectId(row.scopeId) &&
      siteId === null
    ) {
      addTarget(elevatedProject, parsed.permission, row.scopeId);
    } else if (
      parsed.scope === "site" &&
      row.scopeId !== null &&
      isProjectId(row.scopeId) &&
      siteId !== null &&
      isSiteId(siteId) &&
      (row.siteArchived !== true || isRead(parsed.permission))
    ) {
      addTarget(elevatedSite, parsed.permission, siteId);
    }
  }

  return {
    projectIds: allProjects ? [] : [...projectIds].sort(),
    grants: grantsOf(elevatedOrg, own, elevatedProject, elevatedSite),
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
type OrgMembershipRow = MembershipRow & {
  readonly user_id: unknown;
  readonly is_external: unknown;
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
  readonly site_id: unknown;
  readonly site_archived: unknown;
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

/** The assigned sites a project membership row carries (a JSON array). */
function sitesOf(value: unknown): AssignedSite[] {
  if (!Array.isArray(value)) throw new GrantsRowError();
  const list: readonly unknown[] = value;
  return list.map((item): AssignedSite => {
    if (typeof item !== "object" || item === null) throw new GrantsRowError();
    const siteId: unknown = Reflect.get(item, "siteId");
    const archived: unknown = Reflect.get(item, "archived");
    if (
      typeof siteId !== "string" ||
      !UUID.test(siteId) ||
      typeof archived !== "boolean"
    ) {
      throw new GrantsRowError();
    }
    return { siteId, archived };
  });
}

/**
 * Most open site assignments read per project membership (P6-05): the
 * API caps a membership's siteIds at the same number.
 */
export const MAX_ASSIGNED_SITES = 100;

/** Most users accessRowsFor() reads in one call (four statements per call). */
export const MAX_ACCESS_ROW_USERS = 100;

/**
 * The membership and elevation rows of `userIds` in the transaction's org
 * (P5-07, ADR 0068: one SQL for the request's own user and for SodService's
 * approver candidates), memberships and elevations judged at `at` (bound,
 * never now()). Only ACTIVE memberships count (P6-06b, ADR 0084): not
 * removed, not suspended, not past expires_at.
 * A user with no active membership there is absent from the map; more than
 * one is GrantsRowError. Per user at most MAX_PROJECT_MEMBERSHIPS project
 * memberships and MAX_ACCESS_GRANTS elevations, newest first. What the
 * caller sees is what RLS lets the transaction see: its own rows through
 * the own-row policies (DbGrantsSource); other members' org rows, and
 * their project rows on the transaction's projects (SodService).
 */
export async function accessRowsFor(
  tx: Tx,
  userIds: readonly string[],
  at: string,
): Promise<Map<string, AccessRows>> {
  if (
    userIds.length > MAX_ACCESS_ROW_USERS ||
    !userIds.every((id) => UUID.test(id))
  ) {
    throw new GrantsRowError();
  }
  const out = new Map<string, AccessRows>();
  if (userIds.length === 0) return out;
  // One bind parameter, a Postgres array literal of checked UUIDs
  // (Drizzle would expand a JavaScript array into one per element).
  const users = `{${userIds.join(",")}}`;
  const membership = await tx.execute<OrgMembershipRow>(
    sql`SELECT m.user_id::text AS user_id, r.id::text AS role_id, r.system_key, (r.archived_at IS NOT NULL) AS archived, m.is_external
        FROM bricx.memberships m
        JOIN bricx.roles r ON r.org_id = m.org_id AND r.id = m.role_id
        WHERE m.org_id = app.current_org() AND m.user_id = ANY(${users}::uuid[]) AND m.removed_at IS NULL
          AND m.suspended_at IS NULL AND (m.expires_at IS NULL OR ${at}::timestamptz < m.expires_at)
        ORDER BY m.user_id`,
  );
  const memberships = new Map<string, RoleRow>();
  const externals = new Set<string>();
  for (const row of membership.rows) {
    if (typeof row.user_id !== "string") throw new GrantsRowError();
    if (typeof row.is_external !== "boolean") throw new GrantsRowError();
    if (memberships.has(row.user_id)) throw new GrantsRowError();
    memberships.set(row.user_id, roleRowOf(row));
    if (row.is_external) externals.add(row.user_id);
  }
  if (memberships.size === 0) return out;
  const members = `{${[...memberships.keys()].join(",")}}`;
  const projects = await tx.execute<
    ProjectMembershipRow & { user_id: unknown }
  >(
    sql`SELECT user_id, project_id, overrides, role_id, system_key, archived, sites FROM (
          SELECT pm.user_id::text AS user_id, pm.project_id::text AS project_id, pm.overrides, r.id::text AS role_id, r.system_key, (r.archived_at IS NOT NULL) AS archived,
                 (SELECT coalesce(json_agg(json_build_object('siteId', a.site_id::text, 'archived', a.archived) ORDER BY a.site_id), '[]'::json)
                  FROM (SELECT ms.site_id, (s.archived_at IS NOT NULL) AS archived
                        FROM bricx.project_membership_sites ms
                        JOIN bricx.sites s ON s.org_id = ms.org_id AND s.project_id = ms.project_id AND s.id = ms.site_id
                        WHERE ms.org_id = pm.org_id AND ms.project_membership_id = pm.id AND ms.removed_at IS NULL
                        ORDER BY ms.site_id LIMIT ${MAX_ASSIGNED_SITES}) a) AS sites,
                 row_number() OVER (PARTITION BY pm.user_id ORDER BY pm.created_at DESC, pm.id DESC) AS n
          FROM bricx.project_memberships pm
          JOIN bricx.roles r ON r.org_id = pm.org_id AND r.id = pm.role_id
          WHERE pm.org_id = app.current_org() AND pm.user_id = ANY(${members}::uuid[]) AND pm.removed_at IS NULL
            AND pm.suspended_at IS NULL AND (pm.expires_at IS NULL OR ${at}::timestamptz < pm.expires_at)
        ) p WHERE n <= ${MAX_PROJECT_MEMBERSHIPS}
        ORDER BY user_id, n`,
  );
  const elevations = await tx.execute<ElevationDbRow & { user_id: unknown }>(
    sql`SELECT user_id, permission, scope_id, site_id, site_archived FROM (
          SELECT g.user_id::text AS user_id, g.permission, g.scope_id::text AS scope_id, g.site_id::text AS site_id,
                 -- A site the transaction cannot see counts as archived:
                 -- read keys only (never more than the row could grant).
                 (g.site_id IS NOT NULL AND (s.id IS NULL OR s.archived_at IS NOT NULL)) AS site_archived,
                 row_number() OVER (PARTITION BY g.user_id ORDER BY g.created_at DESC, g.id DESC) AS n
          FROM bricx.access_grants g
          LEFT JOIN bricx.sites s ON s.org_id = g.org_id AND s.project_id = g.scope_id AND s.id = g.site_id
          WHERE g.org_id = app.current_org() AND g.user_id = ANY(${members}::uuid[])
            AND g.revoked_at IS NULL
            AND g.starts_at <= ${at}::timestamptz AND ${at}::timestamptz < g.expires_at
        ) e WHERE n <= ${MAX_ACCESS_GRANTS}
        ORDER BY user_id, n`,
  );
  const projectRows = new Map<string, ProjectRow[]>();
  for (const row of projects.rows) {
    if (typeof row.user_id !== "string" || typeof row.project_id !== "string") {
      throw new GrantsRowError();
    }
    const list = projectRows.get(row.user_id) ?? [];
    list.push({
      ...roleRowOf(row),
      projectId: row.project_id,
      overrides: overridesOf(row.overrides),
      sites: sitesOf(row["sites"]),
    });
    projectRows.set(row.user_id, list);
  }
  const elevationRows = new Map<string, ElevationRow[]>();
  for (const row of elevations.rows) {
    if (
      typeof row.user_id !== "string" ||
      typeof row.permission !== "string" ||
      (row.scope_id !== null && typeof row.scope_id !== "string") ||
      (row.site_id !== null && typeof row.site_id !== "string") ||
      typeof row.site_archived !== "boolean"
    ) {
      throw new GrantsRowError();
    }
    const list = elevationRows.get(row.user_id) ?? [];
    list.push({
      permission: row.permission,
      scopeId: row.scope_id,
      siteId: row.site_id,
      siteArchived: row.site_archived,
    });
    elevationRows.set(row.user_id, list);
  }
  const roleIds = [
    ...new Set(
      [...memberships.values(), ...[...projectRows.values()].flat()]
        .filter((r) => !r.archived && r.systemKey !== "owner")
        .map((r) => r.roleId),
    ),
  ];
  const permissions = new Map<string, string[]>();
  if (roleIds.length > 0) {
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
  for (const [userId, role] of memberships) {
    out.set(userId, {
      membership: role,
      projects: projectRows.get(userId) ?? [],
      permissions,
      elevations: elevationRows.get(userId) ?? [],
      ...(externals.has(userId) ? { external: true } : {}),
    });
  }
  return out;
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
        const rows = (await accessRowsFor(tx, [user.userId], at)).get(
          user.userId,
        );
        if (rows === undefined) return undefined;
        const access = buildAccess(rows);
        const archived = await tx.execute<{ archived: unknown }>(
          sql`SELECT (archived_at IS NOT NULL) AS archived FROM bricx.organizations WHERE id = app.current_org()`,
        );
        return archived.rows[0]?.archived === true
          ? { ...access, orgArchived: true }
          : access;
      },
    );
  }
}
