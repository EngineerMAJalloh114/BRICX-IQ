# @bricx/validation

Shared Zod schemas for every BRICX IQ boundary (P3-04, ADR 0047): email, phone (E.164), ISO 3166-1 country, ISO 4217 currency, IANA time zone, BCP 47 tag, GeoPoint, `Money` (from `@bricx/money`), pagination, and the standard error envelope. Runs on the API, the worker and devices: the source imports only its own files and data, `@bricx/ids`, `@bricx/money`, `@bricx/i18n` and `zod` (zod 4.6.5).

```ts
import { EmailSchema } from "@bricx/validation/email";
import { parseAtBoundary } from "@bricx/validation/error-envelope";

const result = parseAtBoundary(EmailSchema, body.email);
if (!result.success) return reply.status(result.envelope.status).send(result.envelope);
result.data; // Email (branded, lowercased)
```

## Rules

- **Re-parse at every boundary.** Every output type is branded (`Email`, `PhoneE164`, `CountryCode`, `TimeZone`, `LanguageTag`, `Cursor`, `TraceId`), so a raw string cannot stand in for a parsed value. `z.input`/`z.output` types are exported from each module.
- **Bounds before parsing.** Every string's length is checked before its format check runs, every array's length and every object's own-key count (16) before any element or field is read. Limits are in `./limits`.
- **Nothing is trimmed or coerced.** Callers normalise (whitespace, punctuation, `00` prefixes); the schemas reject anything that is not already in canonical form, except where a canonical form is documented below.
- **Errors carry codes, paths and i18n keys, never input values** and never message text from zod, `@bricx/money` or `@bricx/i18n`.

## Entry points

`./email`, `./phone`, `./country`, `./currency`, `./time-zone`, `./locale`, `./geo`, `./money`, `./pagination`, `./error-envelope`, `./codes`, `./limits`. No root barrel, no deep imports.

| Schema | Accepts | Output |
| --- | --- | --- |
| `EmailSchema` | zod's default email pattern (ASCII; punycode domains pass), at most 254 characters, local part at most 64; any whitespace rejected | lowercased in full (a Keycloak match, not an RFC guarantee) |
| `PhoneE164Schema` | `+`, a first digit 1–9, then 6 to 14 more digits (7 to 15 digits); nothing else | unchanged. **Format only**: no per-country length, no assignment check |
| `CountryCodeSchema` | an ISO 3166-1 alpha-2 code in `data/countries.json` (249), uppercase only; `XK`, `EU` and user-assigned codes rejected | unchanged |
| `CurrencySchema` | `@bricx/money`'s `parseCurrencyCode` (current ISO 4217 codes with a minor unit) | `CurrencyCode`; issues carry money's own code (`money.<code>`) |
| `TimeZoneSchema` | a Zone or Link name in tzdb 2026e (`data/time-zones.json`) | the canonical zone: `Asia/Calcutta` → `Asia/Kolkata`, `UTC` → `Etc/UTC`, `Africa/Freetown` → `Africa/Abidjan` |
| `LanguageTagSchema` | well-formed BCP 47 via `@bricx/i18n`'s `normalizeLocale`, at most 35 characters | the canonical tag (`EN-gb` → `en-GB`) |
| `SupportedLocaleSchema` | `en`, `fr` or `ar` after canonicalisation (no region) | `SupportedLocale` |
| `GeoPointSchema` | `{ lat, lng }`, finite numbers, lat −90..90, lng −180..180, no other key | `-0` becomes `0`. PostGIS stores (lng, lat): map explicitly |
| `MoneySchema`, `MoneyJsonSchema` | the **same objects** `@bricx/money/schema` exports, never redefined | `Money` |
| `CursorSchema` | opaque base64url, at most 512 characters; the API owns the content | `Cursor` |
| `PageLimitSchema` | an integer 1..100, as a number or a strict digit string (`"25"`); missing → 25 | number |
| `PageQuerySchema`, `pageOf(item)` | `{ cursor?, limit? }`; a page `{ items (≤ 100), nextCursor \| null }` | |

## Error envelope

Compatible with RFC 9457 (`application/problem+json`; every member is an extension, there is no `title` or `detail` text):

```json
{ "status": 422, "code": "validation_failed", "key": "errors:validation_failed", "traceId": "4bf9…",
  "issues": [{ "path": ["lines", 0, "amount"], "code": "money.invalid_amount", "key": "errors:money.invalid_amount" }] }
```

- `code` is one of `ERROR_CODES` (`validation_failed` 422, `session_expired` 401, `forbidden` 403, `not_found` 404, `conflict_financial` 409, `rate_limited` 429, `generic` 500, `server_unavailable` 503); `key` is `errors:<code>`. The client renders the key.
- Issue codes are `validation:<code>` keys (`VALIDATION_CODES`) or `errors:money.<code>` keys for every `MoneyError` code. `MONEY_ERROR_KEYS` is a `Record<MoneyErrorCode, MessageKey>`: a new money code without a key fails the build, and a drift test checks the key exists in en, fr and ar.
- Path segments are schema-declared property names or array indices only. A record key (user-controlled, may hold a secret) and anything else becomes `"*"`. At most 32 segments, 128 characters each; at most 100 issues (`truncated: true` beyond).
- `parseAtBoundary(schema, input, { traceId })` parses and builds the envelope; `validationEnvelope(schema, zodError)` builds it from an existing error; `errorEnvelope(code)` builds one without issues; `ErrorEnvelopeSchema` is what the client re-parses.

## Data

Both files are generated by a committed script from a committed, SHA-256-pinned snapshot (`data/source/source.json`); a test requires the committed file to be byte-identical to a fresh run.

- `data/countries.json`: `pnpm --filter @bricx/validation gen:countries` from `datasets/country-list` at `d214094` (ODC-PDDL-1.0).
- `data/time-zones.json`: `pnpm --filter @bricx/validation gen:time-zones` from the Zone and Link lines of tzdb 2026e (public domain). Links resolve transitively. To refresh: update the pinned commit and hashes, then `gen:time-zones --from-dir <tz checkout>` (or `--source tzdb`) must report 0 differences. A test checks Node's `Intl.DateTimeFormat` accepts every canonical zone, with exceptions listed explicitly.

**fr and ar text behind every key is machine-drafted** (ADR 0046): native review before production.
