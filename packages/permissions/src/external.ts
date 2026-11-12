// External members (P6-06b, ADR 0084; owner conditions C3). An external
// member (a subcontractor's or a client's person, memberships.is_external)
// works on the projects they are assigned to and nothing else. The rule
// lives inside the one permission computation (apps/api buildAccess), not
// beside it:
// - of the org role's bundle an external member keeps the org-scope keys
//   in EXTERNAL_ORG_KEYS only; every other org-scope key, and every
//   own-scope key of the org role, is dropped;
// - project, site and own keys come from their project memberships, as
//   for anyone;
// - an elevation (access grant) at org scope is never theirs.
// So an external member's grants are a subset of what the same rows give
// an internal member (test/external.test.ts proves it for all 13 system
// roles), they never hold an org-scope finance key, and they never reach
// every project of the org (no key of EXTERNAL_ORG_KEYS is on a project
// or site resource).
// Completeness: every resource with an org-scope key is either fully in
// EXTERNAL_ORG_KEYS or named in EXTERNAL_ORG_DENIED with its reason; the
// test fails when a new resource is in neither. A new action on a denied
// resource is denied without an edit (the safe direction).
// Client-safe: no node:* import.
import {
  CATALOGUE,
  type CatalogueKey,
  parseCatalogueKey,
  splitPermission,
} from "./catalogue.ts";

/** The only org-scope keys an external member's org role keeps (for architect review). */
export const EXTERNAL_ORG_KEYS: readonly CatalogueKey[] = Object.freeze([
  // Units, formats, time zone and language: needed to render anything.
  "org.region_config.read.org",
] as const satisfies readonly CatalogueKey[]);

/** Every other resource with an org-scope key, and why an external member has none of it. */
export const EXTERNAL_ORG_DENIED: Readonly<Record<string, string>> =
  Object.freeze({
    "org.organization": "organisation settings are the organisation's own",
    "org.member": "the member list is personal data of the organisation",
    "org.role": "role definitions are an administrator's view",
    "org.audit": "the audit log is the organisation's own",
    "org.session": "other users' sessions",
    "org.access_grant": "elevations are an administrator's view",
    "org.region_config":
      "read only: the configuration is changed by the organisation",
    "project.project":
      "org scope is every project; an external member has assigned projects only",
    "project.site":
      "org scope is every project; an external member has assigned projects only",
    "project.task":
      "org scope is every project; an external member has assigned projects only",
    "project.milestone":
      "org scope is every project; an external member has assigned projects only",
    "project.member": "org scope is every project's members",
    "field.attendance": "org scope is every project; workers' personal data",
    "field.dailylog":
      "org scope is every project; an external member has assigned projects only",
    "field.photo":
      "org scope is every project; an external member has assigned projects only",
    "field.drawing":
      "org scope is every project; an external member has assigned projects only",
    "document.file": "org scope is every project's documents",
    "supply.material":
      "the organisation's material catalogue (for architect review)",
    "supply.material_request":
      "org scope is every project; an external member has assigned projects only",
    "supply.goods_receipt":
      "org scope is every project; an external member has assigned projects only",
    "supply.inventory":
      "org scope is every project; an external member has assigned projects only",
    "supply.purchase_order": "prices and supplier terms are commercial data",
    "finance.budget": "no org-scope finance key (owner condition C3)",
    "finance.expenditure": "no org-scope finance key (owner condition C3)",
    "finance.payment": "no org-scope finance key (owner condition C3)",
    "finance.reconciliation": "no org-scope finance key (owner condition C3)",
    "finance.change_order": "no org-scope finance key (owner condition C3)",
    "finance.fx_rate": "no org-scope finance key (owner condition C3)",
    "finance.ledger": "no org-scope finance key (owner condition C3)",
    "report.dashboard": "dashboards aggregate finance figures across projects",
  });

const ALLOWED: ReadonlySet<string> = new Set(EXTERNAL_ORG_KEYS);

/** Whether an external member's org role keeps `key` (a catalogue key). */
export function externalKeepsOrgKey(key: string): boolean {
  return ALLOWED.has(key);
}

/** The keys of an org role's bundle an external member keeps. */
export function externalOrgKeys(
  bundle: readonly CatalogueKey[],
): CatalogueKey[] {
  return bundle.filter((key) => ALLOWED.has(key));
}

/**
 * Whether an external member may be elevated with `key`: never at org
 * scope (the key would reach every project, or the organisation itself).
 * An unknown key is false.
 */
export function externalAllowsElevation(key: string): boolean {
  const parsed = parseCatalogueKey(key);
  return parsed !== undefined && parsed.scope !== "org";
}

/** The resources that have at least one org-scope catalogue key, sorted. */
export function orgScopeSubjects(): string[] {
  const subjects = new Set<string>();
  for (const key of CATALOGUE) {
    const parsed = parseCatalogueKey(key);
    if (parsed?.scope !== "org") continue;
    const parts = splitPermission(parsed.permission);
    if (parts !== undefined) subjects.add(parts.subject);
  }
  return [...subjects].sort();
}
