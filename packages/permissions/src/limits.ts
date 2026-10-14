// Input bounds (P3 rule; design constraint 6). Every array's length and
// every object's key count is checked before any element or field is read.
export const LIMITS = Object.freeze({
  /** Grants given to one buildAbility call. */
  grants: 1_000,
  /** Project or site ids in one grant. */
  targetsPerGrant: 1_000,
  /** Project and site ids across all grants of one call. */
  targetsTotal: 10_000,
  /** Entries in one SoD history. */
  sodHistory: 1_000,
  /** Characters in a permission name (module.resource.action). */
  permissionName: 64,
  /** Own keys of a grant, a context, a record or an SoD entry. */
  objectKeys: 8,
});
