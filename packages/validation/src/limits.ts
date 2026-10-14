// Input bounds (architect item 4, P3 rule 9). Every string is length-checked
// against these before its format check, every array's length and every
// object's key count before any element or field is read.
import { LIMITS as I18N_LIMITS } from "@bricx/i18n/limits";

export const LIMITS = Object.freeze({
  /** Characters in an email address (RFC 5321 path limit less the brackets). */
  email: 254,
  /** Characters in an email local part (RFC 5321 section 4.5.3.1.1). */
  emailLocal: 64,
  /** Characters in an E.164 number: "+" and at most 15 digits. */
  phone: 16,
  /** Characters in an ISO 3166-1 alpha-2 code. */
  country: 2,
  /** Characters in an ISO 4217 alphabetic code. */
  currency: 3,
  /** Characters in an IANA time zone name (the longest in 2026e is 32). */
  timeZone: 64,
  /** Characters in a BCP 47 tag: @bricx/i18n's own limit. */
  languageTag: I18N_LIMITS.localeTag,
  /** Characters in a pagination cursor. */
  cursor: 512,
  /** Characters in a page size sent as a query string ("100"). */
  pageLimit: 3,
  /** Characters in a W3C trace id. */
  traceId: 32,
  /** Own keys of any object these schemas parse, checked before any field. */
  objectKeys: 16,
  /** Issues in one error envelope; more set `truncated`. */
  issues: 100,
  /** Segments in one issue path; a deeper path is cut. */
  pathDepth: 32,
  /** Characters in one path segment. */
  pathSegment: 128,
  /** Items in one page. */
  pageItems: 100,
});
