// Type tests (P3-04 D12): parsed values are branded, so a raw string cannot
// stand in for one, and the issue-code maps are exhaustive. `tsc --noEmit`
// (the package's typecheck) compiles this file: each @ts-expect-error must
// still be an error. types-sabotage.test.ts proves that by compiling
// sabotaged copies.
import type { MoneyErrorCode } from "@bricx/money/errors";
import type { MessageKey } from "@bricx/i18n/keys";
import type { z } from "zod";
import { MONEY_ERROR_KEYS, issueKey } from "../src/codes.ts";
import type { IssueCode } from "../src/codes.ts";
import { CountryCodeSchema } from "../src/country.ts";
import type { CountryCode } from "../src/country.ts";
import { EmailSchema } from "../src/email.ts";
import type { Email } from "../src/email.ts";
import type { GeoPoint } from "../src/geo.ts";
import type { LanguageTag, SupportedLocaleSchema } from "../src/locale.ts";
import type { Cursor } from "../src/pagination.ts";
import { PhoneE164Schema } from "../src/phone.ts";
import type { PhoneE164 } from "../src/phone.ts";
import type { TimeZone } from "../src/time-zone.ts";

// Parsed values carry their brand.
export const email: Email = EmailSchema.parse("a@example.com");
export const phone: PhoneE164 = PhoneE164Schema.parse("+23276123456");
export const country: CountryCode = CountryCodeSchema.parse("SL");

// @ts-expect-error a raw string is not an Email
export const rawEmail: Email = "a@example.com";
// @ts-expect-error a raw string is not a PhoneE164
export const rawPhone: PhoneE164 = "+23276123456";
// @ts-expect-error a raw string is not a CountryCode
export const rawCountry: CountryCode = "SL";
// @ts-expect-error a raw string is not a TimeZone
export const rawZone: TimeZone = "Etc/UTC";
// @ts-expect-error a raw string is not a LanguageTag
export const rawTag: LanguageTag = "en";
// @ts-expect-error a raw string is not a Cursor
export const rawCursor: Cursor = "abc";
// @ts-expect-error an Email is not a PhoneE164
export const crossed: PhoneE164 = email;

// The input types stay plain (what a caller hands in).
export const emailInput: z.input<typeof EmailSchema> = "a@example.com";
export const localeOut: z.output<typeof SupportedLocaleSchema> = "en";
// @ts-expect-error a supported locale is en, fr or ar only
export const localeBad: z.output<typeof SupportedLocaleSchema> = "de";

export const point: GeoPoint = { lat: 1, lng: 2 };
// @ts-expect-error a GeoPoint has no altitude
export const point3: GeoPoint = { lat: 1, lng: 2, alt: 3 };

// The money key map is exhaustive over MoneyErrorCode and its values are
// real message keys.
export const moneyKeys: Readonly<Record<MoneyErrorCode, MessageKey>> =
  MONEY_ERROR_KEYS;
export const key: MessageKey = issueKey("money.invalid_amount");
// @ts-expect-error not an issue code
export const badCode: IssueCode = "money.not_a_code";
