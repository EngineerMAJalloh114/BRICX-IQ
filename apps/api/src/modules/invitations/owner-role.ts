// The one owner-role check of an invitation (P6-06c, ADR 0085; owner
// answer Q6; owner condition 3 of 2026-11-13): an owner comes only from an
// accepted ownership transfer, so an invitation naming the owner role, as
// its org role or its project role, is refused with the code owner_role.
// The single invite (InvitationsService.checkRow) and a bulk row
// (InvitationBatchesService) both call this function and no other code
// produces owner_role (apps/api/test/owner-role-check.test.ts);
// memberships_guard v2 is the database backstop.

/** A role as far as the owner check needs it. */
export interface SystemKeyed {
  readonly systemKey: string | null;
}

/** owner_role when any of `roles` is the system owner role. */
export function ownerRoleRefusal(
  ...roles: readonly (SystemKeyed | undefined)[]
): "owner_role" | undefined {
  return roles.some((role) => role?.systemKey === "owner")
    ? "owner_role"
    : undefined;
}
