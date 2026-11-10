// The adapter kinds and their interfaces (P6-04, ADR 0074, D12). Every
// adapter is first a descriptor: its id, its kind and the ISO 3166
// countries and ISO 4217 currencies it serves (D7). Only what P6 needs is
// typed beyond that:
// - SmsAdapter.send() and FxRateProvider.rate() are typed now;
// - PaymentAdapter, TaxAdapter and AccountingAdapter are descriptors only,
//   with no stub methods (an unused stub would be an untested API). P17-01
//   adds the payment contract and P21-01 the accounting and tax ones.
// - EmailAdapter.send() (P6-06, ADR 0077, D5): one pre-rendered message.
//   The caller renders it from i18n keys (rule 8); the adapter only
//   delivers it.
// A Null payment adapter can never report a payment verified or paid
// (CLAUDE.md rule 10, owner condition C4): it has no method that could.
import type { Result } from "@bricx/domain/result";
import type { CurrencyCode } from "@bricx/money/currency";

export const ADAPTER_KINDS = Object.freeze([
  "payment",
  "tax",
  "accounting",
  "sms",
  "fx",
  "email",
] as const);
export type AdapterKind = (typeof ADAPTER_KINDS)[number];

/** What every adapter declares (D7). */
export interface AdapterDescriptor<K extends AdapterKind = AdapterKind> {
  /** Unique across every kind; matches ADAPTER_ID_PATTERN. */
  readonly id: string;
  readonly kind: K;
  /** ISO 3166-1 alpha-2 codes; at least one. */
  readonly countries: readonly string[];
  /** Current ISO 4217 codes with a minor unit; at least one. */
  readonly currencies: readonly string[];
  /** A development and test stand-in, refused in production (D1). */
  readonly nullAdapter?: true;
}

export type PaymentAdapter = AdapterDescriptor<"payment">;
export type TaxAdapter = AdapterDescriptor<"tax">;
export type AccountingAdapter = AdapterDescriptor<"accounting">;

/** One SMS: a template key and its parameters, never free text (rule 8). */
export interface SmsMessage {
  /** E.164, for example +23276123456. */
  readonly to: string;
  readonly templateKey: string;
  readonly params: Readonly<Record<string, string>>;
}

export interface SmsAdapter extends AdapterDescriptor<"sms"> {
  send(message: SmsMessage): Promise<void>;
}

export interface FxRateQuery {
  readonly from: CurrencyCode;
  readonly to: CurrencyCode;
  /** The instant the rate applies to, ISO 8601 UTC. */
  readonly at: string;
}

/** No rate: a typed answer, never an invented number (D2, rule 1). */
export type FxUnavailable = "unavailable";

export interface FxRateProvider extends AdapterDescriptor<"fx"> {
  /** One `from` in `to`, as a decimal string (NUMERIC(24,12) later, P9-02). */
  rate(query: FxRateQuery): Promise<Result<string, FxUnavailable>>;
}

/**
 * One e-mail (P6-06, ADR 0077, D5): rendered by the caller from i18n keys
 * in `locale`, plain text only. It may hold a secret (an invitation link):
 * an adapter never logs `subject` or `text`, and never the address.
 */
export interface EmailMessage {
  /** One normalised address. */
  readonly to: string;
  /** The BCP 47 tag the text was rendered in. */
  readonly locale: string;
  readonly subject: string;
  readonly text: string;
}

export interface EmailAdapter extends AdapterDescriptor<"email"> {
  /** Resolves once the provider accepted the message; rejects otherwise (no value in the error). */
  send(message: EmailMessage): Promise<void>;
}

export type AnyAdapter =
  | PaymentAdapter
  | TaxAdapter
  | AccountingAdapter
  | SmsAdapter
  | FxRateProvider
  | EmailAdapter;
