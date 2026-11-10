// P6-06 (ADR 0077, owner condition C9): POST /v1/members is retired, so a
// test that needs "a user who is a member of the org with this role"
// adds the membership here, as the test superuser: one open org
// membership row, exactly the row an accepted invitation leaves
// (insertOrgIfAbsent), and nothing else (no audit event, no outbox row:
// those are the invitation's, asserted in invitations*.int.test.ts). A
// user who already has an open membership in the org is refused (the
// accept path would answer already_member and change nothing).
import { type AdminRows, seedId } from "./auth.js";

export async function addMember(
  admin: AdminRows,
  member: {
    readonly orgId: string;
    readonly userId: string;
    readonly roleId: string;
  },
): Promise<string> {
  const open = await admin(
    "SELECT 1 FROM bricx.memberships WHERE org_id = $1 AND user_id = $2 AND removed_at IS NULL",
    [member.orgId, member.userId],
  );
  if (open.length > 0) throw new Error("addMember: already an open member");
  const id = seedId();
  await admin(
    `INSERT INTO bricx.memberships (id, org_id, user_id, role_id, created_at)
     VALUES ($1, $2, $3, $4, now())`,
    [id, member.orgId, member.userId, member.roleId],
  );
  return id;
}
