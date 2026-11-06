// The organisation slugs nobody may create (P6-02, ADR 0072; owner ruling
// R5, D14): the platform's own host and path names, the auth and mail
// words, and the names that read as the platform speaking. POST
// /v1/organizations refuses them with organization.slug_unavailable, the
// same code and body as a slug another organisation holds, so the answer
// never says which. Committed and reviewed like code: adding a name never
// takes a slug from an organisation that already holds it.
// Sorted, unique, every entry a valid slug (tested).

/**
 * The slug shape: the CHECK of directory.org_directory.org_slug and
 * bricx.organizations.slug (3-63 characters, lower-case letters, digits
 * and inner hyphens).
 */
export const ORGANIZATION_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/;

/** The reserved slugs, sorted. */
export const RESERVED_SLUGS: readonly string[] = Object.freeze([
  "about",
  "account",
  "accounts",
  "admin",
  "administrator",
  "api",
  "app",
  "assets",
  "auth",
  "billing",
  "blog",
  "bricx",
  "cdn",
  "dashboard",
  "dev",
  "directory",
  "docs",
  "download",
  "email",
  "files",
  "ftp",
  "graphql",
  "health",
  "help",
  "identity",
  "imap",
  "internal",
  "invite",
  "keycloak",
  "legal",
  "login",
  "logout",
  "mail",
  "media",
  "metrics",
  "new",
  "null",
  "oauth",
  "org",
  "organization",
  "organizations",
  "pop",
  "privacy",
  "register",
  "root",
  "security",
  "settings",
  "signin",
  "signout",
  "signup",
  "smtp",
  "sso",
  "staging",
  "static",
  "status",
  "support",
  "system",
  "terms",
  "test",
  "undefined",
  "update",
  "upload",
  "webhook",
  "webhooks",
  "www",
]);

const RESERVED: ReadonlySet<string> = new Set(RESERVED_SLUGS);

/** Whether `slug` is reserved (never a prototype name or a non-string). */
export const isReservedSlug = (slug: unknown): boolean =>
  typeof slug === "string" && RESERVED.has(slug);
