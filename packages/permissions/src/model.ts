// The permission model the generators read: resources, role bundles and SoD
// rules. DEFAULT_MODEL is the package's own data; tests pass mutated copies
// to prove that a change reaches every generated layer (design constraint
// 5). validateModel lists the problems of a model as codes with the subject
// or role they concern (never user input).
import type { Level } from "./catalogue.ts";
import { RESOURCES, SUBJECT_TYPES } from "./catalogue.ts";
import { ROLES, ROLE_IDS } from "./roles.ts";
import { SCOPES } from "./scopes.ts";
import type { Scope } from "./scopes.ts";
import { SOD_RULES } from "./sod-rules.ts";

export interface ModelResource {
  level: Level;
  createdBy: boolean;
  synced: boolean;
  appendOnly: boolean;
  columns?: { org?: string; project?: string; site?: string };
  actions: Record<string, Scope[]>;
}

export interface ModelSodRule {
  id: string;
  first: string;
  second: string;
  source: "roadmap" | "owner_review";
}

export interface Model {
  resources: Record<string, ModelResource>;
  roles: Record<string, string[]>;
  sodRules: ModelSodRule[];
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The package's own model (a deep-frozen copy of RESOURCES, ROLES and SOD_RULES). */
export const DEFAULT_MODEL: Model = deepFreeze({
  resources: Object.fromEntries(
    SUBJECT_TYPES.map((s) => {
      const r = RESOURCES[s];
      const columns: ModelResource["columns"] =
        "columns" in r ? { ...r.columns } : undefined;
      const resource: ModelResource = {
        level: r.level,
        createdBy: r.createdBy,
        synced: r.synced,
        appendOnly: r.appendOnly,
        ...(columns === undefined ? {} : { columns }),
        actions: Object.fromEntries(
          Object.entries(
            r.actions as Readonly<Record<string, readonly Scope[]>>,
          ).map(([a, scopes]) => [a, [...scopes]]),
        ),
      };
      return [s, resource];
    }),
  ),
  roles: Object.fromEntries(ROLE_IDS.map((id) => [id, [...ROLES[id]]])),
  sodRules: SOD_RULES.map((r) => ({ ...r })),
});

/** "module.resource.action.scope" -> parts, checked against the model. */
export function modelKey(
  model: Model,
  key: string,
): { subject: string; action: string; scope: Scope } | undefined {
  const parts = key.split(".");
  if (parts.length !== 4) return undefined;
  const [module, name, action, scope] = parts as [
    string,
    string,
    string,
    string,
  ];
  const subject = `${module}.${name}`;
  const resource = Object.hasOwn(model.resources, subject)
    ? model.resources[subject]
    : undefined;
  if (resource === undefined || !Object.hasOwn(resource.actions, action))
    return undefined;
  const allowed = (resource.actions[action] ?? []).find((s) => s === scope);
  return allowed === undefined
    ? undefined
    : { subject, action, scope: allowed };
}

const hasPermission = (model: Model, permission: string): boolean => {
  const dot = permission.lastIndexOf(".");
  const subject = permission.slice(0, dot);
  const resource = Object.hasOwn(model.resources, subject)
    ? model.resources[subject]
    : undefined;
  return (
    resource !== undefined &&
    Object.hasOwn(resource.actions, permission.slice(dot + 1))
  );
};

export function validateModel(model: Model): readonly string[] {
  const problems: string[] = [];
  for (const [subject, r] of Object.entries(model.resources)) {
    const scopes = Object.values(r.actions).flat();
    if (Object.keys(r.actions).length === 0)
      problems.push(`no_actions:${subject}`);
    if (scopes.some((s) => !(SCOPES as readonly string[]).includes(s))) {
      problems.push(`unknown_scope:${subject}`);
    }
    if (scopes.includes("own") && !r.createdBy)
      problems.push(`own_without_created_by:${subject}`);
    if (scopes.includes("site") && r.level !== "site") {
      problems.push(`site_scope_without_site_rows:${subject}`);
    }
    if (r.level === "org" && scopes.some((s) => s !== "org")) {
      problems.push(`narrow_scope_on_org_rows:${subject}`);
    }
    if (Object.values(r.actions).some((list) => !list.includes("org"))) {
      problems.push(`action_without_org_scope:${subject}`);
    }
    if (r.synced && !Object.hasOwn(r.actions, "read"))
      problems.push(`synced_without_read:${subject}`);
    if (r.synced && subject.startsWith("finance."))
      problems.push(`finance_synced:${subject}`);
    if (Object.hasOwn(r.actions, "approve")) {
      // Every authoring action is paired with approve (architect review 1).
      for (const action of ["create", "update"]) {
        if (
          Object.hasOwn(r.actions, action) &&
          !model.sodRules.some(
            (x) =>
              x.first === `${subject}.${action}` &&
              x.second === `${subject}.approve`,
          )
        ) {
          problems.push(`authoring_action_not_paired:${subject}.${action}`);
        }
      }
    }
    if (
      Object.hasOwn(r.actions, "approve") &&
      !model.sodRules.some((x) => x.second === `${subject}.approve`)
    ) {
      problems.push(`approve_without_sod_pair:${subject}`);
    }
  }
  for (const [role, keys] of Object.entries(model.roles)) {
    if (keys.some((k) => modelKey(model, k) === undefined)) {
      problems.push(`role_entry_not_in_catalogue:${role}`);
    }
    const permissions = keys.map((k) => k.slice(0, k.lastIndexOf(".")));
    if (new Set(permissions).size !== permissions.length) {
      problems.push(`role_permission_twice:${role}`);
    }
  }
  for (const r of model.sodRules) {
    if (!hasPermission(model, r.first) || !hasPermission(model, r.second)) {
      problems.push(`sod_side_not_in_catalogue:${r.id}`);
    }
    if (
      r.first === r.second ||
      r.first.endsWith(".read") ||
      r.second.endsWith(".read")
    ) {
      problems.push(`sod_pair_invalid:${r.id}`);
    }
  }
  return problems;
}
