// The escalation rule (P5-05, ADR 0066, plan 3.2; owner condition 3 reuses
// it): an editor may grant, or touch, only keys they hold at ORG scope,
// since a role bundle or a membership applies to rows the editor may not
// see. holdsAll() answers the first key of `keys` the ability does not hold
// org-wide, or undefined. A key is held org-wide when the checked can()
// path allows its permission on a record of the org whose project, site
// and creator are a sentinel no grant can name (SENTINEL_ID: version 7,
// all-zero time, never generated), so only an org-scoped rule matches:
// project, site and own grants never do. With a `projectId` (a project
// membership, plan 3.2) the record names that project instead, so an
// org-scoped rule or a project rule on that project matches (site and own
// grants still never do). A key the catalogue does not know is refused,
// never a throw.
import type { Ability } from "@bricx/permissions/ability";
import { canPermission } from "@bricx/permissions/ability";
import { parseCatalogueKey } from "@bricx/permissions/catalogue";
import { PermissionError } from "@bricx/permissions/errors";

/** A UUIDv7-shaped id no row carries (the zero timestamp). */
export const SENTINEL_ID = "00000000-0000-7000-8000-000000000000";

/** The first key of `keys` not held at org scope (or on `projectId`), or undefined. */
export function holdsAll(
  ability: Ability,
  orgId: string,
  keys: readonly string[],
  projectId: string = SENTINEL_ID,
): string | undefined {
  for (const key of keys) {
    const parsed = parseCatalogueKey(key);
    if (parsed === undefined) return key;
    let held: boolean;
    try {
      held = canPermission(ability, parsed.permission, {
        orgId,
        projectId,
        siteId: SENTINEL_ID,
        createdBy: SENTINEL_ID,
      });
    } catch (error) {
      if (error instanceof PermissionError) return key;
      throw error;
    }
    if (!held) return key;
  }
  return undefined;
}
