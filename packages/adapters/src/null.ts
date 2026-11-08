// The Null adapters (P6-04, ADR 0074, D8): one of each kind for
// development and tests, refused in production by buildRegistry() (D1).
// Each declares every ISO 3166 country and every current ISO 4217 currency
// with a minor unit.
// - nullPayment, nullTax, nullAccounting: descriptors only (D12). The Null
//   payment adapter has no method, so it can never report a payment
//   verified or paid (CLAUDE.md rule 10, owner condition C4).
// - createNullSms(): records each send in memory and logs only
//   { templateKey, recipientHash }. recipientHash is an HMAC-SHA-256 of the
//   E.164 number under a random key drawn per instance, cut to 8 hex
//   characters (owner condition C1): never the number, the text, or an
//   unkeyed hash a reader could look a number up by.
// - createNullFx(): every rate is `unavailable`, never an invented number
//   (D2, CLAUDE.md rule 1).
import { createHmac, randomBytes } from "node:crypto";
import { err } from "@bricx/domain/result";
import { listCurrencies } from "@bricx/money/currency";
import { COUNTRY_CODES } from "@bricx/validation/country";
import type {
  AccountingAdapter,
  FxRateProvider,
  PaymentAdapter,
  SmsAdapter,
  SmsMessage,
  TaxAdapter,
} from "./types.ts";

const ALL_COUNTRIES: readonly string[] = COUNTRY_CODES;
const ALL_CURRENCIES: readonly string[] = Object.freeze(
  listCurrencies().map((c) => c.code),
);

const everywhere = {
  countries: ALL_COUNTRIES,
  currencies: ALL_CURRENCIES,
  nullAdapter: true,
} as const;

export const nullPayment: PaymentAdapter = Object.freeze({
  id: "null_payment",
  kind: "payment",
  ...everywhere,
});

export const nullTax: TaxAdapter = Object.freeze({
  id: "null_tax",
  kind: "tax",
  ...everywhere,
});

export const nullAccounting: AccountingAdapter = Object.freeze({
  id: "null_accounting",
  kind: "accounting",
  ...everywhere,
});

/** The bytes of the per-instance HMAC key (C1). */
export const RECIPIENT_KEY_BYTES = 32;
/** recipientHash's length in hex characters (C1). */
export const RECIPIENT_HASH_HEX = 8;

/** What the Null SMS adapter logs and records: never the number or text. */
export interface NullSmsEntry {
  readonly templateKey: string;
  readonly recipientHash: string;
}

export interface NullSmsAdapter extends SmsAdapter {
  /** Every send so far, oldest first. */
  readonly sent: readonly NullSmsEntry[];
}

export interface NullSmsOptions {
  /** Receives one entry per send; nothing else is ever logged. */
  readonly log?: (entry: NullSmsEntry) => void;
}

export function createNullSms(options: NullSmsOptions = {}): NullSmsAdapter {
  const key = randomBytes(RECIPIENT_KEY_BYTES);
  const sent: NullSmsEntry[] = [];
  const hashOf = (to: string) =>
    createHmac("sha256", key)
      .update(to, "utf8")
      .digest("hex")
      .slice(0, RECIPIENT_HASH_HEX);
  return Object.freeze({
    id: "null_sms",
    kind: "sms" as const,
    ...everywhere,
    get sent(): readonly NullSmsEntry[] {
      return Object.freeze(sent.slice());
    },
    send(message: SmsMessage): Promise<void> {
      const entry: NullSmsEntry = Object.freeze({
        templateKey: message.templateKey,
        recipientHash: hashOf(message.to),
      });
      sent.push(entry);
      options.log?.(entry);
      return Promise.resolve();
    },
  });
}

export function createNullFx(): FxRateProvider {
  return Object.freeze({
    id: "null_fx",
    kind: "fx" as const,
    ...everywhere,
    rate: () => Promise.resolve(err("unavailable" as const)),
  });
}
