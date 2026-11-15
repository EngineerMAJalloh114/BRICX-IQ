// The ownership-transfer cascades' one entry point (P6-06c, ADR 0085): a
// party's removal, suspension or role change, and an organisation's
// archive, cancel the pending transfer in their own transaction through
// @bricx/db/ownership's cancelPendingTransfers, and record one
// org.ownership_transfer.cancel event with the cause plus the recipient's
// users.mfa_check. Each module provides it under this token, so none of
// them imports the ownership-transfers module (CLAUDE.md rule 13, no
// cycle).
import type { cancelPendingTransfers } from "@bricx/db/ownership";

export type OwnershipCanceller = typeof cancelPendingTransfers;
export const OWNERSHIP_CANCELLER = Symbol("OWNERSHIP_CANCELLER");

/** The ownership-transfers module's audit subject, spelled once for the cascades. */
export const OWNERSHIP_TRANSFER_SUBJECT = "org.ownership_transfer";
