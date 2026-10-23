// The permission catalogue as data (ROADMAP P3-05 step 1, ADR 0048). A
// permission is module.resource.action; a catalogue entry adds one of the
// scopes the permission allows: module.resource.action.scope, e.g.
// finance.payment.approve.project. CASL sees subject "module.resource" and
// action "action". Closed lists: nothing outside RESOURCES exists, there is
// no wildcard, and "manage" (org.role.manage) is a literal action.
//
// Per resource:
//   level      the isolation columns its rows carry: "org" (org_id),
//              "project" (org_id, project_id), "site" (org_id, project_id,
//              site_id). site scope needs site rows, project scope needs
//              project or site rows.
//   createdBy  rows carry created_by (needed by own scope; RLS checks it on
//              insert).
//   synced     streamed to devices (PowerSync); never a finance resource
//              until P8-02/P9 decide financial sync (ruling 3, rule 9).
//   appendOnly no UPDATE (audit log, ledger: CLAUDE.md rule 2).
//   columns    column names where they differ from org_id/project_id/site_id.
//   actions    action -> allowed scopes.
import type { Scope } from "./scopes.ts";
import { SCOPES } from "./scopes.ts";

export type Level = "org" | "project" | "site";

export interface ResourceDef {
  readonly level: Level;
  readonly createdBy: boolean;
  readonly synced: boolean;
  readonly appendOnly: boolean;
  readonly columns?: {
    readonly org?: string;
    readonly project?: string;
    readonly site?: string;
  };
  readonly actions: Readonly<Record<string, readonly Scope[]>>;
}

const O = ["org"] as const;
const OP = ["org", "project"] as const;
const OPS = ["org", "project", "site"] as const;
const OPSW = ["org", "project", "site", "own"] as const;
const OPW = ["org", "project", "own"] as const;

export const RESOURCES = Object.freeze({
  "org.organization": {
    level: "org",
    createdBy: false,
    synced: false,
    appendOnly: false,
    columns: { org: "id" },
    actions: { read: O, update: O },
  },
  "org.member": {
    level: "org",
    createdBy: false,
    synced: false,
    appendOnly: false,
    actions: { read: O, invite: O, update: O, remove: O },
  },
  "org.role": {
    level: "org",
    createdBy: false,
    synced: false,
    appendOnly: false,
    actions: { read: O, manage: O },
  },
  "org.audit": {
    level: "org",
    createdBy: false,
    synced: false,
    appendOnly: true,
    actions: { read: O, export: O },
  },
  // P5-03 (ADR 0063): a user's own sessions are readable and revocable by
  // an own-row RLS policy with no grant; these entries are the
  // administrator path over every session of the organisation.
  "org.session": {
    level: "org",
    createdBy: false,
    synced: false,
    appendOnly: false,
    actions: { read: O, revoke: O },
  },
  // P5-06 (ADR 0067): a temporary elevation is one catalogue key granted to
  // one user for a bounded time. Granting and revoking are org-level
  // administrator actions (the granter must hold the key org-wide); a
  // user's own grants are readable by an own-row RLS policy with no grant.
  // Not synced until P8-02; a revocation updates the row.
  "org.access_grant": {
    level: "org",
    createdBy: false,
    synced: false,
    appendOnly: false,
    actions: { read: O, grant: O, revoke: O },
  },
  "project.project": {
    level: "project",
    createdBy: true,
    synced: true,
    appendOnly: false,
    columns: { project: "id" },
    actions: { create: O, read: OP, update: OP, archive: OP },
  },
  "project.site": {
    level: "site",
    createdBy: true,
    synced: true,
    appendOnly: false,
    columns: { site: "id" },
    actions: { create: OP, read: OPS, update: OPS, archive: OP },
  },
  "project.member": {
    level: "project",
    createdBy: false,
    synced: false,
    appendOnly: false,
    actions: { read: OP, assign: OP },
  },
  "project.task": {
    level: "site",
    createdBy: true,
    synced: true,
    appendOnly: false,
    actions: { create: OPS, read: OPSW, update: OPSW, complete: OPSW },
  },
  "project.milestone": {
    level: "project",
    createdBy: true,
    synced: true,
    appendOnly: false,
    actions: { create: OP, read: OP, update: OP, verify: OP },
  },
  "field.dailylog": {
    level: "site",
    createdBy: true,
    synced: true,
    appendOnly: false,
    actions: { create: OPSW, read: OPSW, update: OPSW, approve: OPS },
  },
  "field.photo": {
    level: "site",
    createdBy: true,
    synced: true,
    appendOnly: false,
    actions: { create: OPSW, read: OPSW },
  },
  "field.attendance": {
    level: "site",
    createdBy: true,
    synced: true,
    appendOnly: false,
    actions: { create: OPSW, read: OPSW, approve: OPS },
  },
  "field.drawing": {
    level: "site",
    createdBy: true,
    synced: true,
    appendOnly: false,
    actions: { upload: OPS, read: OPS, markup: OPS },
  },
  "supply.material": {
    level: "org",
    createdBy: true,
    synced: true,
    appendOnly: false,
    actions: { create: O, read: O, update: O },
  },
  "supply.material_request": {
    level: "site",
    createdBy: true,
    synced: true,
    appendOnly: false,
    actions: { create: OPSW, read: OPSW, update: OPSW, approve: OPS },
  },
  "supply.purchase_order": {
    level: "site",
    createdBy: true,
    synced: false,
    appendOnly: false,
    actions: { create: OP, read: OPS, approve: OP },
  },
  "supply.goods_receipt": {
    level: "site",
    createdBy: true,
    synced: true,
    appendOnly: false,
    actions: { create: OPS, read: OPS },
  },
  "supply.inventory": {
    level: "site",
    createdBy: true,
    synced: true,
    appendOnly: false,
    actions: { read: OPS, issue: OPS, adjust: OPS },
  },
  "finance.budget": {
    level: "project",
    createdBy: true,
    synced: false,
    appendOnly: false,
    actions: { create: OP, read: OP, update: OP, approve: OP },
  },
  "finance.expenditure": {
    level: "project",
    createdBy: true,
    synced: false,
    appendOnly: false,
    actions: { create: OPW, read: OPW, approve: OP },
  },
  "finance.payment": {
    level: "project",
    createdBy: true,
    synced: false,
    appendOnly: false,
    actions: { request: OP, read: OP, approve: OP, record: OP },
  },
  "finance.reconciliation": {
    level: "org",
    createdBy: true,
    synced: false,
    appendOnly: false,
    actions: { create: O, read: O },
  },
  "finance.change_order": {
    level: "project",
    createdBy: true,
    synced: false,
    appendOnly: false,
    actions: { create: OP, read: OP, approve: OP, sign_off: OP },
  },
  "finance.fx_rate": {
    level: "org",
    createdBy: true,
    synced: false,
    appendOnly: false,
    actions: { read: O, update: O },
  },
  "finance.ledger": {
    level: "org",
    createdBy: false,
    synced: false,
    appendOnly: true,
    actions: { read: O, export: O },
  },
  "document.file": {
    level: "site",
    createdBy: true,
    synced: true,
    appendOnly: false,
    actions: { upload: OPSW, read: OPSW, share: OPS },
  },
  "report.dashboard": {
    level: "project",
    createdBy: false,
    synced: false,
    appendOnly: false,
    actions: { read: OP, export: OP },
  },
} as const satisfies Readonly<Record<string, ResourceDef>>);

export type Resources = typeof RESOURCES;
export type SubjectType = keyof Resources;
export type ActionOf<S extends SubjectType> = keyof Resources[S]["actions"] &
  string;
export type Action = { [S in SubjectType]: ActionOf<S> }[SubjectType];
export type PermissionName = {
  [S in SubjectType]: `${S}.${ActionOf<S>}`;
}[SubjectType];
export type CatalogueKey = `${PermissionName}.${Scope}`;

export const SUBJECT_TYPES: readonly SubjectType[] = Object.freeze(
  Object.keys(RESOURCES) as SubjectType[],
);

/** Every action name, sorted. */
export const ACTIONS: readonly Action[] = Object.freeze(
  [
    ...new Set(SUBJECT_TYPES.flatMap((s) => Object.keys(RESOURCES[s].actions))),
  ].sort() as Action[],
);

/** Every permission (module.resource.action), in catalogue order. */
export const PERMISSIONS: readonly PermissionName[] = Object.freeze(
  SUBJECT_TYPES.flatMap((s) =>
    Object.keys(RESOURCES[s].actions).map((a) => `${s}.${a}` as PermissionName),
  ),
);

const resource = (subject: string): ResourceDef | undefined =>
  Object.hasOwn(RESOURCES, subject)
    ? (RESOURCES as Readonly<Record<string, ResourceDef>>)[subject]
    : undefined;

/** The definition of a subject type, or undefined for anything else. */
export const resourceOf = resource;

export const isSubjectType = (value: unknown): value is SubjectType =>
  typeof value === "string" && resource(value) !== undefined;

/** The scopes a subject's action allows, or undefined if it has no such action. */
export function scopesOf(
  subject: string,
  action: string,
): readonly Scope[] | undefined {
  const r = resource(subject);
  if (r === undefined || !Object.hasOwn(r.actions, action)) return undefined;
  return r.actions[action];
}

/** Splits "module.resource.action" at its last dot. */
export function splitPermission(
  name: string,
): { subject: string; action: string } | undefined {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return { subject: name.slice(0, dot), action: name.slice(dot + 1) };
}

export function isPermissionName(value: unknown): value is PermissionName {
  if (typeof value !== "string" || value.length > 64) return false;
  const parts = splitPermission(value);
  return (
    parts !== undefined && scopesOf(parts.subject, parts.action) !== undefined
  );
}

/** The scopes a permission allows (empty for an unknown name). */
export function allowedScopes(permission: PermissionName): readonly Scope[] {
  const parts = splitPermission(permission);
  return (
    (parts === undefined ? undefined : scopesOf(parts.subject, parts.action)) ??
    []
  );
}

/** Every catalogue entry module.resource.action.scope, sorted. */
export const CATALOGUE: readonly CatalogueKey[] = Object.freeze(
  PERMISSIONS.flatMap((p) =>
    SCOPES.filter((s) => allowedScopes(p).includes(s)).map(
      (s): CatalogueKey => `${p}.${s}`,
    ),
  ).sort(),
);

/** Parses a catalogue entry; undefined unless it is one. */
export function parseCatalogueKey(
  key: string,
): { readonly permission: PermissionName; readonly scope: Scope } | undefined {
  if (key.length > 72) return undefined;
  const dot = key.lastIndexOf(".");
  if (dot <= 0) return undefined;
  const permission = key.slice(0, dot);
  const scope = key.slice(dot + 1);
  if (!isPermissionName(permission)) return undefined;
  const allowed = allowedScopes(permission).find((s) => s === scope);
  return allowed === undefined ? undefined : { permission, scope: allowed };
}
