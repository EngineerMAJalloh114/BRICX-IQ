// The e-mail adapters (P6-06, ADR 0077, D5), with no new package:
// - createNullEmail(): development and tests. Records each send in memory
//   as { locale, recipientHash } (the per-instance keyed HMAC of the null
//   SMS adapter, owner condition C1 of P6-04), never the address, the
//   subject or the text, which can hold an invitation link. A test may
//   pass `capture` to receive the whole message; nothing else ever sees it.
// - createMailpitEmail(): development only. Posts the message to the dev
//   stack's Mailpit through its HTTP send API (POST <url>/api/v1/send) with
//   the platform fetch and a timeout. It is marked nullAdapter, so the
//   registry refuses it in production (null_in_production), and the
//   worker's config refuses MAILPIT_URL in production too (two locks).
//   A refusal is an EmailSendError with the HTTP status only: never the
//   address, the body or Mailpit's answer.
// Production has no e-mail adapter until P12 adds SES (ADR 0077 launch
// blocker): invitation sends then fail and retry, and are never dropped.
import { createHmac, randomBytes } from "node:crypto";
import { listCurrencies } from "@bricx/money/currency";
import { COUNTRY_CODES } from "@bricx/validation/country";
import { RECIPIENT_HASH_HEX, RECIPIENT_KEY_BYTES } from "./null.ts";
import type { EmailAdapter, EmailMessage } from "./types.ts";

const everywhere = {
  countries: COUNTRY_CODES,
  currencies: Object.freeze(listCurrencies().map((c) => c.code)),
  nullAdapter: true,
} as const;

/** What the Null e-mail adapter logs and records. */
export interface NullEmailEntry {
  readonly locale: string;
  readonly recipientHash: string;
}

export interface NullEmailAdapter extends EmailAdapter {
  /** Every send so far, oldest first: no address, subject or text. */
  readonly sent: readonly NullEmailEntry[];
}

export interface NullEmailOptions {
  /** Receives one entry per send; nothing else is ever logged. */
  readonly log?: (entry: NullEmailEntry) => void;
  /** Tests only: receives the whole message (it may hold a token). */
  readonly capture?: (message: EmailMessage) => void;
  /** Tests only: the next sends reject with this error, in order. */
  readonly failures?: readonly Error[];
}

export function createNullEmail(
  options: NullEmailOptions = {},
): NullEmailAdapter {
  const key = randomBytes(RECIPIENT_KEY_BYTES);
  const sent: NullEmailEntry[] = [];
  const failures = [...(options.failures ?? [])];
  const hashOf = (to: string) =>
    createHmac("sha256", key)
      .update(to, "utf8")
      .digest("hex")
      .slice(0, RECIPIENT_HASH_HEX);
  return Object.freeze({
    id: "null_email",
    kind: "email" as const,
    ...everywhere,
    get sent(): readonly NullEmailEntry[] {
      return Object.freeze(sent.slice());
    },
    send(message: EmailMessage): Promise<void> {
      const failure = failures.shift();
      if (failure !== undefined) return Promise.reject(failure);
      const entry: NullEmailEntry = Object.freeze({
        locale: message.locale,
        recipientHash: hashOf(message.to),
      });
      sent.push(entry);
      options.log?.(entry);
      options.capture?.(message);
      return Promise.resolve();
    },
  });
}

/** A provider refused or did not answer: the HTTP status at most. */
export class EmailSendError extends Error {
  readonly status: number | undefined;

  constructor(status: number | undefined) {
    super(
      status === undefined
        ? "email send failed: no answer"
        : `email send failed: HTTP ${String(status)}`,
    );
    this.status = status;
  }
}
Object.defineProperty(EmailSendError.prototype, "name", {
  value: "EmailSendError",
});

/** How long one Mailpit call may take. */
export const MAILPIT_TIMEOUT_MS = 5_000;

export interface MailpitEmailOptions {
  /** Mailpit's HTTP origin, for example http://127.0.0.1:8025. */
  readonly url: string;
  /** The From address. */
  readonly from: string;
  /** Tests only: a stand-in for the platform fetch. */
  readonly fetch?: typeof fetch;
}

export function createMailpitEmail(options: MailpitEmailOptions): EmailAdapter {
  const endpoint = new URL("/api/v1/send", options.url).toString();
  const doFetch = options.fetch ?? fetch;
  return Object.freeze({
    id: "mailpit_email",
    kind: "email" as const,
    ...everywhere,
    async send(message: EmailMessage): Promise<void> {
      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            From: { Email: options.from },
            To: [{ Email: message.to }],
            Subject: message.subject,
            Text: message.text,
            Headers: { "Content-Language": message.locale },
          }),
          redirect: "error",
          signal: AbortSignal.timeout(MAILPIT_TIMEOUT_MS),
        });
      } catch {
        throw new EmailSendError(undefined);
      }
      // Drain the body: an unread body holds the connection.
      await response.arrayBuffer().catch(() => undefined);
      if (!response.ok) throw new EmailSendError(response.status);
    },
  });
}
