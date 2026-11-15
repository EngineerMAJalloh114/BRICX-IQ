// Bulk invitations' outbox event (P6-06c, ADR 0085; CLAUDE.md rule 5),
// registered in @bricx/db/outbox on queue `invitations`:
// - invitations.bulk {batchId, createdBy}, one per accepted batch, written in the
//   submit's transaction. The worker turns each pending row into an
//   invitation through @bricx/db/invitations' insertPendingInvitation, the
//   single invite's own statement, and its invitations.send job; the send
//   step is the only one that mints a token (C5). The batch id only: the
//   addresses stay in bricx.invitation_batch_rows.
export const INVITATIONS_BULK = "invitations.bulk";

export interface InvitationsBulk {
  readonly batchId: string;
  /** The author: the worker's transaction runs as them. */
  readonly createdBy: string;
}
