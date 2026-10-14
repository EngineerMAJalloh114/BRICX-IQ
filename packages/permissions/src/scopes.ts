// The four grant scopes (ROADMAP P3-05 step 1). Narrowest first.
//   own     records the user created (created_by = user)
//   site    records of the grant's sites
//   project records of the grant's projects (their sites included)
//   org     every record of the user's organisation
// A scope never widens another: each grant matches only its own condition
// (ADR 0048 D4).
export const SCOPES = Object.freeze(["own", "site", "project", "org"] as const);
export type Scope = (typeof SCOPES)[number];

export const isScope = (value: unknown): value is Scope =>
  typeof value === "string" && (SCOPES as readonly string[]).includes(value);
