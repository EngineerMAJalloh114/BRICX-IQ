// The MFA rule (P5-05, phase ruling D5, ADR 0066): a user whose effective
// keys hold any finance.* key must hold the Keycloak realm role bricx-mfa
// (ADR 0060). P6-05e (ADR 0081, owner condition C2) adds the org-admin
// keys: the per-key MFA flag planned for P13-01, pulled forward. The API
// computes it from its org-scoped reads and the authorization guard asks
// for acr mfa on every such permission; the worker's MFA consumer reads
// the same rule in SQL (app.mfa_state() v3, packages/db; its key list,
// app.mfa_admin_keys(), is checked against MFA_ADMIN_KEYS live).
import {
  CATALOGUE,
  type CatalogueKey,
  type PermissionName,
  splitPermission,
} from "./catalogue.ts";
import { PermissionError } from "./errors.ts";

/** The catalogue module whose keys require MFA, as a key prefix. */
export const MFA_KEY_PREFIX = "finance.";

/**
 * The org-admin permissions that require MFA (C2): changing the
 * organisation, its members, roles, other users' sessions, elevations and
 * region configuration, assigning project members, and every export. A
 * user's own sessions and devices have no key (C1: self-service at pwd).
 */
export const MFA_ADMIN_PERMISSIONS: readonly PermissionName[] = Object.freeze([
  "org.organization.update",
  "org.organization.archive",
  "org.member.invite",
  "org.member.update",
  "org.member.remove",
  "org.role.manage",
  "org.session.revoke",
  "org.access_grant.grant",
  "org.access_grant.revoke",
  "org.region_config.update",
  "org.audit.export",
  "project.member.assign",
  "report.dashboard.export",
] as const satisfies readonly PermissionName[]);

/** Every catalogue key of an admin permission, at every scope it allows (the SQL list). */
export const MFA_ADMIN_KEYS: readonly CatalogueKey[] = Object.freeze(
  CATALOGUE.filter((key) => {
    const dot = key.lastIndexOf(".");
    return (MFA_ADMIN_PERMISSIONS as readonly string[]).includes(
      key.slice(0, dot),
    );
  }),
);

/** Actions that administer, whatever the resource. */
const ADMIN_ACTIONS: ReadonlySet<string> = new Set([
  "export",
  "manage",
  "grant",
  "invite",
  "assign",
  "revoke",
  "remove",
  "share",
]);

/**
 * Whether a permission (module.resource.action) is admin-class (C2): any
 * action but read on an org.* resource (the organisation's own
 * administration) or on project.member / project.role, and every
 * administering action (ADMIN_ACTIONS) anywhere. A new catalogue key of
 * this shape must join MFA_ADMIN_PERMISSIONS or ADMIN_CLASS_EXEMPT; the
 * completeness test fails otherwise.
 */
export function isAdminClass(permission: string): boolean {
  const parts = splitPermission(permission);
  if (parts === undefined) return false;
  const { subject, action } = parts;
  if (ADMIN_ACTIONS.has(action)) return true;
  if (action === "read") return false;
  return (
    /^org\.[a-z_]+$/.test(subject) ||
    subject === "project.member" ||
    subject === "project.role"
  );
}

/**
 * Admin-class permissions that do not require MFA, each with its reason
 * (C2). finance.* keys are not listed: they always require it.
 */
export const ADMIN_CLASS_EXEMPT: Readonly<Record<string, string>> =
  Object.freeze({
    "document.file.share":
      "Shares a file with people who can already reach its project or site; no route uses it before P8-06, which decides external sharing and its MFA rule (P8-06 Also line).",
  });

const ADMIN_KEY_SET: ReadonlySet<string> = new Set([
  ...MFA_ADMIN_PERMISSIONS,
  ...MFA_ADMIN_KEYS,
]);

/**
 * Whether `keys` (catalogue keys, or permission names as the guard
 * passes them) require MFA. Bounded by the catalogue.
 */
export function requiresMfa(keys: readonly string[]): boolean {
  if (!Array.isArray(keys) || keys.length > CATALOGUE.length) {
    throw new PermissionError("too_many_keys");
  }
  return keys.some(
    (key) =>
      typeof key === "string" &&
      (key.startsWith(MFA_KEY_PREFIX) || ADMIN_KEY_SET.has(key)),
  );
}
