// CASL rules from parsed grants, and the registry that keeps each CASL
// ability behind an opaque handle (ruling 1). Internal: not in the exports
// map. Every rule carries the context's orgId; the scope adds one more
// condition (ADR 0048 D4):
//   org     { orgId }
//   project { orgId, projectId: { $in: projectIds } }
//   site    { orgId, siteId: { $in: siteIds } }
//   own     { orgId, createdBy: userId }
import { createMongoAbility } from "@casl/ability";
import type { MongoAbility } from "@casl/ability";
import type { Scope } from "./scopes.ts";

/** The closed condition fields. */
// Type aliases (not interfaces) so they fit CASL's index-signature types.
export type Conditions = {
  readonly orgId: string;
  readonly projectId?: { readonly $in: string[] };
  readonly siteId?: { readonly $in: string[] };
  readonly createdBy?: string;
};

export interface CaslRule {
  readonly action: string;
  readonly subject: string;
  readonly conditions: Conditions;
  readonly inverted?: boolean;
}

/** A grant after validation: targets are the project or site ids (else empty). */
export interface ParsedGrant {
  readonly permission: string;
  readonly scope: Scope;
  readonly targets: readonly string[];
}

export interface RuleContext {
  readonly orgId: string;
  readonly userId: string;
}

/** What CASL sees: a fresh object with the subject type and the closed fields only. */
export type CaslSubject = {
  readonly kind: string;
  readonly orgId: string;
  readonly projectId?: string;
  readonly siteId?: string;
  readonly createdBy?: string;
};

type Engine = MongoAbility;

/** Opaque: callers check through can() and accessibleQuery() only. */
declare const abilityBrand: unique symbol;
export interface Ability {
  readonly [abilityBrand]: "Ability";
}

// CASL treats action "manage" and subject "all" as wildcards unless told
// otherwise. These names cannot be an action or a subject (no dot, a
// character no catalogue name has), so org.role.manage stays literal (D5).
const NO_WILDCARD = "\u0000none";

export function ruleFor(grant: ParsedGrant, context: RuleContext): CaslRule {
  const dot = grant.permission.lastIndexOf(".");
  const subject = grant.permission.slice(0, dot);
  const action = grant.permission.slice(dot + 1);
  const base = { orgId: context.orgId };
  let conditions: Conditions;
  switch (grant.scope) {
    case "org":
      conditions = base;
      break;
    case "project":
      conditions = { ...base, projectId: { $in: [...grant.targets] } };
      break;
    case "site":
      conditions = { ...base, siteId: { $in: [...grant.targets] } };
      break;
    case "own":
      conditions = { ...base, createdBy: context.userId };
      break;
  }
  return { action, subject, conditions };
}

export const rulesFor = (
  grants: readonly ParsedGrant[],
  context: RuleContext,
): CaslRule[] => grants.map((g) => ruleFor(g, context));

const engines = new WeakMap<Ability, Engine>();

/**
 * Wraps rules in a CASL MongoAbility behind a frozen handle. The sentinel
 * wildcard names are on unless a sabotage test turns them off.
 */
export function abilityFromRules(
  rules: readonly CaslRule[],
  options: { readonly wildcardSentinels: boolean } = {
    wildcardSentinels: true,
  },
): Ability {
  const engine: Engine = createMongoAbility(
    rules.map((r) => ({
      action: r.action,
      subject: r.subject,
      conditions: r.conditions,
      ...(r.inverted === undefined ? {} : { inverted: r.inverted }),
    })),
    {
      detectSubjectType: (subject) =>
        typeof subject.kind === "string" ? subject.kind : NO_WILDCARD,
      ...(options.wildcardSentinels
        ? { anyAction: NO_WILDCARD, anySubjectType: NO_WILDCARD }
        : {}),
    },
  );
  const handle = Object.freeze({}) as Ability;
  engines.set(handle, engine);
  return handle;
}

/** The engine behind a handle, or undefined for anything else. */
export function engineOf(ability: unknown): Engine | undefined {
  return typeof ability === "object" && ability !== null
    ? engines.get(ability as Ability)
    : undefined;
}
