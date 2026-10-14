// An independent oracle for can(): plain loops over the grants, written
// without CASL, conditions or the catalogue's helpers. properties.test.ts
// compares the two on random grants and records.
export interface OracleGrant {
  readonly permission: string;
  readonly scope: "org" | "project" | "site" | "own";
  readonly projectIds?: readonly string[];
  readonly siteIds?: readonly string[];
}

export interface OracleRecord {
  readonly orgId: string;
  readonly projectId?: string;
  readonly siteId?: string;
  readonly createdBy?: string;
}

export function oracleCan(
  grants: readonly OracleGrant[],
  context: { readonly orgId: string; readonly userId: string },
  permission: string,
  record: OracleRecord,
): boolean {
  for (const grant of grants) {
    if (grant.permission !== permission) continue;
    if (record.orgId !== context.orgId) continue;
    if (grant.scope === "org") return true;
    if (
      grant.scope === "project" &&
      record.projectId !== undefined &&
      (grant.projectIds ?? []).includes(record.projectId)
    ) {
      return true;
    }
    if (
      grant.scope === "site" &&
      record.siteId !== undefined &&
      (grant.siteIds ?? []).includes(record.siteId)
    ) {
      return true;
    }
    if (grant.scope === "own" && record.createdBy === context.userId) {
      return true;
    }
  }
  return false;
}
