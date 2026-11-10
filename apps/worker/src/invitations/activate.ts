// An invitation's account activation (P6-06, ADR 0077, D6): the API wrote
// invitations.activate {invitationId, invitedBy} when someone opened the
// link and asked to activate (POST /v1/invitations/activate, at most three
// times per invitation, C7 S19). Here:
// 1. ONE withTx() as bricx_app in the invitation's org, as its inviter:
//    the address of a still pending, unexpired invitation (a settled one:
//    "settled", nothing in Keycloak);
// 2. Keycloak, as the bricx-worker service account: ensureInvitedAccount()
//    (create the account, or e-mail its pending actions again, or nothing
//    for a verified or disabled one). Keycloak's link lasts until the
//    invitation ends, at least an hour and at most seven days.
// The membership is never made here: only accept (a signed-in person whose
// verified e-mail matches) makes one. Nothing here logs.
import type { Tx, TxContext } from "@bricx/db/database";
import { pendingInvitationAddress } from "@bricx/db/invitations";
import type {
  AccountOutcome,
  AccountProvisioner,
} from "../revocation/keycloak.js";

export interface InvitationActivateJob {
  readonly invitationId: string;
  readonly orgId: string;
  readonly invitedBy: string;
}

export type ActivateOutcome = AccountOutcome | "settled";

/** Shortest and longest life of Keycloak's action link (seconds). */
export const ACTION_LINK_MIN_SECONDS = 3_600;
export const ACTION_LINK_MAX_SECONDS = 604_800;

/** The action link's life: until the invitation ends, within the bounds. */
export function actionLinkSeconds(expiresAt: string, now: number): number {
  const left = Math.floor((Date.parse(expiresAt) - now) / 1000);
  return Math.min(
    ACTION_LINK_MAX_SECONDS,
    Math.max(ACTION_LINK_MIN_SECONDS, Number.isFinite(left) ? left : 0),
  );
}

export interface InvitationActivator {
  activate(job: InvitationActivateJob): Promise<ActivateOutcome>;
}

export interface InvitationActivatorOptions {
  readonly database: {
    withTx<T>(context: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  };
  readonly clock: { now(): number };
  readonly accounts: AccountProvisioner;
  readonly read?: typeof pendingInvitationAddress | undefined;
}

export function createInvitationActivator(
  options: InvitationActivatorOptions,
): InvitationActivator {
  const { database, clock, accounts } = options;
  const read = options.read ?? pendingInvitationAddress;
  return {
    async activate(job) {
      const now = clock.now();
      const pending = await database.withTx(
        { orgId: job.orgId, userId: job.invitedBy, projectIds: [] },
        (tx) => read(tx, job.invitationId, new Date(now).toISOString()),
      );
      if (pending === undefined) return "settled";
      return accounts.ensureInvitedAccount(
        pending.email,
        actionLinkSeconds(pending.expiresAt, now),
      );
    },
  };
}
