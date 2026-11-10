// An invitation's send (P6-06, ADR 0077, D4, D5; owner condition C7, S20):
// the API wrote invitations.send {invitationId, sendSeq, invitedBy} in the
// creating or resending transaction; the token is minted HERE, never in the
// API and never in the outbox (S7).
// 1. ONE withTx() as bricx_app in the invitation's org, as its inviter:
//    a fresh 32-byte secret, its SHA-256 stored by mintInvitationToken()
//    only while the row is pending, unexpired and still on send `sendSeq`
//    (a stale job, a resend's older send or a settled row mints nothing:
//    "stale"), and the org's language and time zone. The transaction
//    commits before anything is sent, so a link that arrives always
//    matches a stored hash.
// 2. The e-mail, written in the org's language (createTranslator over the
//    bundled catalogs: subject, body with the link, the end of the
//    invitation in the org's time zone) and sent through the e-mail
//    adapter. The link is `<INVITE_LINK_BASE>/invite#<cellId>.<secret>`:
//    the token is in the fragment, which browsers never send to a server.
//    A failed send throws: BullMQ retries the job, which mints a NEW
//    token (the unsent one is overwritten and never usable).
// No adapter (production until P12's SES, ADR 0077 launch blocker): the
// job throws before minting and is retried, never dropped. Nothing here
// logs; the token, the secret and the address never leave this module
// except in the message handed to the adapter.
import type { EmailAdapter, EmailMessage } from "@bricx/adapters/types";
import type { Tx, TxContext } from "@bricx/db/database";
import {
  type InvitationMessageSettings,
  type MintedInvitation,
  hashInvitationSecret,
  invitationMessageSettings,
  invitationTokenOf,
  mintInvitationToken,
  newInvitationSecret,
} from "@bricx/db/invitations";
import { formattingLocale, resolveLocale } from "@bricx/i18n/locale";
import { createTranslator } from "@bricx/i18n/translate";

/** An invitations.send job's payload, checked, with the row's org. */
export interface InvitationSendJob {
  readonly invitationId: string;
  readonly orgId: string;
  readonly invitedBy: string;
  readonly sendSeq: number;
}

export type SendOutcome = "sent" | "stale";

/** Thrown when the worker has no e-mail adapter (production until P12). */
export class EmailUnavailableError extends Error {
  readonly code = "invitation.email_unavailable";

  constructor() {
    super("invitation send: no e-mail adapter");
  }
}
Object.defineProperty(EmailUnavailableError.prototype, "name", {
  value: "EmailUnavailableError",
});

export interface InvitationSender {
  send(job: InvitationSendJob): Promise<SendOutcome>;
}

/** The statements of one send; the production ones unless a test says otherwise. */
export interface SendStatements {
  mint: typeof mintInvitationToken;
  settings: typeof invitationMessageSettings;
}

const PRODUCTION: SendStatements = {
  mint: mintInvitationToken,
  settings: invitationMessageSettings,
};

export interface InvitationSenderOptions {
  /** The bricx_app pool (DATABASE_URL). */
  readonly database: {
    withTx<T>(context: TxContext, fn: (tx: Tx) => Promise<T>): Promise<T>;
  };
  readonly clock: { now(): number };
  /** The e-mail adapter, or undefined (every send then throws). */
  readonly email: EmailAdapter | undefined;
  /** INVITE_LINK_BASE: an exact origin. */
  readonly linkBase: string;
  /** CELL_ID: the token's prefix (D3). */
  readonly cellId: string;
  readonly statements?: SendStatements | undefined;
}

/** The invitation e-mail in the org's language: subject, link, end. */
export function invitationEmail(
  settings: InvitationMessageSettings,
  link: string,
  expiresAt: string,
): Omit<EmailMessage, "to"> {
  const locale = resolveLocale([settings.language]);
  const { t } = createTranslator(locale);
  const at = new Date(expiresAt);
  let when: string;
  try {
    when = new Intl.DateTimeFormat(formattingLocale(locale), {
      dateStyle: "long",
      timeStyle: "short",
      timeZone: settings.timezone,
    }).format(at);
  } catch {
    // A zone this runtime's tzdb lacks: UTC, named by the format.
    when = new Intl.DateTimeFormat(formattingLocale(locale), {
      dateStyle: "long",
      timeStyle: "long",
      timeZone: "UTC",
    }).format(at);
  }
  return {
    locale,
    subject: t("common:invitation.email.subject"),
    text: [
      t("common:invitation.email.body", { link }),
      t("common:invitation.email.expires", { expiresAt: when }),
    ].join("\n\n"),
  };
}

export function createInvitationSender(
  options: InvitationSenderOptions,
): InvitationSender {
  const { database, clock, email, linkBase, cellId } = options;
  const statements = options.statements ?? PRODUCTION;
  return {
    async send(job) {
      if (email === undefined) throw new EmailUnavailableError();
      const secret = newInvitationSecret();
      const minted = await database.withTx(
        { orgId: job.orgId, userId: job.invitedBy, projectIds: [] },
        async (
          tx,
        ): Promise<
          | {
              invitation: MintedInvitation;
              settings: InvitationMessageSettings;
            }
          | undefined
        > => {
          const invitation = await statements.mint(tx, {
            id: job.invitationId,
            sendSeq: job.sendSeq,
            hash: hashInvitationSecret(secret),
            now: new Date(clock.now()).toISOString(),
          });
          if (invitation === undefined) return undefined;
          const settings = await statements.settings(tx, job.orgId);
          if (settings === undefined) throw new Error("org row missing");
          return { invitation, settings };
        },
      );
      if (minted === undefined) return "stale";
      const link = `${linkBase}/invite#${invitationTokenOf(cellId, secret)}`;
      await email.send({
        to: minted.invitation.email,
        ...invitationEmail(minted.settings, link, minted.invitation.expiresAt),
      });
      return "sent";
    },
  };
}
