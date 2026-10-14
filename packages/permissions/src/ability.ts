// buildAbility(grants, context) and the one checked entry point (ROADMAP
// P3-05 step 3; architect ruling 1; ADR 0048).
//
// CASL answers ability.can(action, "finance.payment") -- a subject TYPE with
// no record -- with true if any rule for that type exists, whatever its
// conditions. So the CASL ability never leaves this package: buildAbility
// returns an opaque, frozen handle, and every check goes through
// can(ability, action, subjectType, record), which needs a record with the
// closed fields its resource's rows carry (orgId always, projectId and
// siteId by level, createdBy where rows have it) and throws invalid_record
// without them. accessibleQuery() is the list-query helper with the same
// fail-closed rules. Usable on the API and on devices (no Node API).
import { isOrgId, isProjectId, isSiteId, isUserId } from "@bricx/ids/branded";
import type { OrgId, ProjectId, SiteId, UserId } from "@bricx/ids/branded";
import { isUuidV7 } from "@bricx/ids/uuid-v7";
import {
  allowedScopes,
  isPermissionName,
  resourceOf,
  scopesOf,
} from "./catalogue.ts";
import type { ActionOf, PermissionName, SubjectType } from "./catalogue.ts";
import { PermissionError } from "./errors.ts";
import { LIMITS } from "./limits.ts";
import { abilityFromRules, engineOf, rulesFor } from "./rules.ts";
import type { Ability, CaslRule, CaslSubject, ParsedGrant } from "./rules.ts";
import { isScope } from "./scopes.ts";

export type { Ability } from "./rules.ts";

/** A grant: one permission at one scope; project and site grants name their targets. */
export type Grant =
  | { readonly permission: PermissionName; readonly scope: "org" }
  | { readonly permission: PermissionName; readonly scope: "own" }
  | {
      readonly permission: PermissionName;
      readonly scope: "project";
      readonly projectIds: readonly ProjectId[];
    }
  | {
      readonly permission: PermissionName;
      readonly scope: "site";
      readonly siteIds: readonly SiteId[];
    };

export interface AbilityContext {
  readonly orgId: OrgId;
  readonly userId: UserId;
}

/** The closed record fields a check reads. Which are required depends on the resource. */
export interface PermissionRecord {
  readonly orgId: string;
  readonly projectId?: string;
  readonly siteId?: string;
  readonly createdBy?: string;
}

/** A list filter: rows matching any filter are allowed (each pinned to the org). */
export interface AccessFilter {
  readonly orgId: OrgId;
  readonly projectIds?: readonly ProjectId[];
  readonly siteIds?: readonly SiteId[];
  readonly createdBy?: UserId;
}

export type AccessQuery =
  | { readonly kind: "none" }
  | { readonly kind: "any_of"; readonly filters: readonly AccessFilter[] };

/** Own enumerable keys of `value`, stopping once past `max` (undefined if over). */
function boundedKeys(value: object, max: number): string[] | undefined {
  const keys: string[] = [];
  for (const key in value) {
    if (Object.hasOwn(value, key)) {
      keys.push(key);
      if (keys.length > max) return undefined;
    }
  }
  return keys;
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const GRANT_KEYS: Readonly<Record<string, readonly string[]>> = {
  org: ["permission", "scope"],
  own: ["permission", "scope"],
  project: ["permission", "scope", "projectIds"],
  site: ["permission", "scope", "siteIds"],
};

/**
 * Validates grants from any source (database rows, JSON). Lengths are
 * checked before any element is read; codes only, never values.
 */
export function parseGrants(grants: unknown): ParsedGrant[] {
  if (!Array.isArray(grants)) throw new PermissionError("invalid_grants");
  if (grants.length > LIMITS.grants)
    throw new PermissionError("too_many_grants");
  const parsed: ParsedGrant[] = [];
  let total = 0;
  for (let i = 0; i < grants.length; i += 1) {
    const grant: unknown = grants[i];
    if (!isPlainObject(grant)) throw new PermissionError("invalid_grants");
    const keys = boundedKeys(grant, LIMITS.objectKeys);
    if (keys === undefined) throw new PermissionError("invalid_grants");
    const { permission, scope } = grant;
    if (
      typeof permission !== "string" ||
      permission.length > LIMITS.permissionName
    ) {
      throw new PermissionError("invalid_grants");
    }
    if (!isScope(scope)) throw new PermissionError("invalid_grants");
    const expected = GRANT_KEYS[scope] ?? [];
    if (
      keys.length !== expected.length ||
      !keys.every((k) => expected.includes(k))
    ) {
      throw new PermissionError("invalid_grants");
    }
    if (!isPermissionName(permission))
      throw new PermissionError("unknown_permission");
    if (!allowedScopes(permission).includes(scope)) {
      throw new PermissionError("scope_not_allowed");
    }
    let targets: string[] = [];
    if (scope === "project" || scope === "site") {
      const list = scope === "project" ? grant.projectIds : grant.siteIds;
      if (!Array.isArray(list) || list.length === 0)
        throw new PermissionError("invalid_grants");
      if (list.length > LIMITS.targetsPerGrant)
        throw new PermissionError("too_many_targets");
      total += list.length;
      if (total > LIMITS.targetsTotal)
        throw new PermissionError("too_many_targets");
      const valid = scope === "project" ? isProjectId : isSiteId;
      targets = [];
      for (let j = 0; j < list.length; j += 1) {
        const id: unknown = list[j];
        if (!valid(id)) throw new PermissionError("invalid_grants");
        targets.push(id);
      }
    }
    parsed.push({ permission, scope, targets: Object.freeze(targets) });
  }
  return parsed;
}

function parseContext(context: unknown): AbilityContext {
  if (!isPlainObject(context)) throw new PermissionError("invalid_context");
  const keys = boundedKeys(context, LIMITS.objectKeys);
  if (keys?.length !== 2) throw new PermissionError("invalid_context");
  const { orgId, userId } = context;
  if (!isOrgId(orgId) || !isUserId(userId))
    throw new PermissionError("invalid_context");
  return { orgId, userId };
}

/**
 * Builds the ability for one user in one organisation. Deny by default: only
 * the listed grants allow anything, there is no wildcard, and every rule is
 * pinned to context.orgId.
 */
export function buildAbility(
  grants: readonly Grant[],
  context: AbilityContext,
): Ability {
  const parsed = parseGrants(grants);
  return abilityFromRules(rulesFor(parsed, parseContext(context)));
}

function engineFor(ability: Ability) {
  const engine = engineOf(ability);
  if (engine === undefined) throw new PermissionError("invalid_ability");
  return engine;
}

function checkPermission(subjectType: unknown, action: unknown): void {
  if (
    typeof subjectType !== "string" ||
    typeof action !== "string" ||
    subjectType.length > LIMITS.permissionName ||
    action.length > LIMITS.permissionName ||
    scopesOf(subjectType, action) === undefined
  ) {
    throw new PermissionError("unknown_permission");
  }
}

/** The CASL subject for a record: the closed fields its resource requires, nothing else. */
function subjectOf(subjectType: string, record: unknown): CaslSubject {
  const resource = resourceOf(subjectType);
  if (resource === undefined) throw new PermissionError("unknown_permission");
  if (
    !isPlainObject(record) ||
    boundedKeys(record, LIMITS.objectKeys) === undefined
  ) {
    throw new PermissionError("invalid_record");
  }
  const field = (
    name: "orgId" | "projectId" | "siteId" | "createdBy",
  ): string => {
    const value = record[name];
    if (!isUuidV7(value)) throw new PermissionError("invalid_record");
    return value;
  };
  return {
    kind: subjectType,
    orgId: field("orgId"),
    ...(resource.level === "org" ? {} : { projectId: field("projectId") }),
    ...(resource.level === "site" ? { siteId: field("siteId") } : {}),
    ...(resource.createdBy ? { createdBy: field("createdBy") } : {}),
  };
}

/**
 * The one checked entry point. Throws invalid_record when the record is
 * missing or lacks a field its resource carries (orgId always; projectId,
 * siteId and createdBy by resource) or a field is not a lowercase UUIDv7;
 * throws unknown_permission for an action the subject does not have.
 */
export function can<S extends SubjectType>(
  ability: Ability,
  action: ActionOf<S>,
  subjectType: S,
  record: PermissionRecord,
): boolean {
  const engine = engineFor(ability);
  checkPermission(subjectType, action);
  return engine.can(action, subjectOf(subjectType, record));
}

/**
 * The list-query helper (accessibleBy equivalent): the filters a row must
 * match one of, in grant order, or "none". Each filter carries orgId; a
 * rule without one throws (fail closed). P4 turns filters into SQL.
 */
export function accessibleQuery<S extends SubjectType>(
  ability: Ability,
  action: ActionOf<S>,
  subjectType: S,
): AccessQuery {
  const engine = engineFor(ability);
  checkPermission(subjectType, action);
  const rules = engine.rulesFor(action, subjectType);
  if (rules.length === 0) return { kind: "none" };
  const filters: AccessFilter[] = [];
  // CASL lists later rules first; filters follow grant order.
  for (const rule of [...rules].reverse()) {
    const c = rule.conditions as unknown as
      Partial<CaslRule["conditions"]> | undefined;
    if (rule.inverted || c === undefined || !isOrgId(c.orgId)) {
      throw new PermissionError("invalid_ability");
    }
    filters.push({
      orgId: c.orgId,
      ...(Array.isArray(c.projectId?.$in)
        ? { projectIds: c.projectId.$in.filter(isProjectId) }
        : {}),
      ...(Array.isArray(c.siteId?.$in)
        ? { siteIds: c.siteId.$in.filter(isSiteId) }
        : {}),
      ...(c.createdBy === undefined || !isUserId(c.createdBy)
        ? {}
        : { createdBy: c.createdBy }),
    });
  }
  return { kind: "any_of", filters };
}

/** A read-only copy of an ability's rules (snapshots, tests). */
export function rulesOf(ability: Ability): readonly CaslRule[] {
  return engineFor(ability).rules.map((r) => ({
    action: String(r.action),
    subject: String(r.subject),
    conditions: r.conditions as unknown as CaslRule["conditions"],
    ...(r.inverted === undefined ? {} : { inverted: r.inverted }),
  }));
}
