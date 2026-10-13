# 0045. `@bricx/money`: bigint minor units, decimal.js rates, generated ISO 4217 data

- Status: Accepted
- Date: 2026-10-13
- Deciders: Mohamed Abass Jalloh
- Source: P3-02 (plan approved 2026-10-13 17:41Z: D1–D13 as recommended, with changes 1–9); the P3-02 rulings and the P3 standing rules (2026-10-13 02:30Z and 17:26Z); STACK.md money rules; ADR 0023 (dependency policy); ADR 0039 (Zod 4.6.5); ADR 0041 (`@bricx/ids`, the lint pattern this ADR extends). Numbered 0045 because 0044 is the Dependabot cooldown (#33).

## Context

CLAUDE.md rule 1 and STACK.md: money is `bigint` minor units plus an ISO 4217 code, never a float; FX rates are `NUMERIC(24,12)` handled with decimal.js; JSON carries amounts as strings. The ROADMAP P3-02 entry asks for a generated `iso4217.json` (SLE with exponent 2, SLL flagged historical), an immutable `Money`, `add`/`subtract` that throw on a currency mismatch, `multiply(ratio, rounding)`, `allocate(ratios)` by largest remainder, `convert(money, rate, target, rounding = HALF_EVEN)` returning `{ money, rateUsed }`, `format` through `Intl.NumberFormat`, a `MoneySchema` with a string amount, fast-check property tests and 95% coverage. The P3-02 rulings add: decimal.js for ratios and rates, an explicit rounding enum with no default except for `convert`, deterministic tie-breaks, zero and negative amounts, ratios summing to zero throw, JPY/BHD/SLE formatting tests, a schema that rejects floats, exponent notation and leading zeros, no public constructor that takes a JS number (proven by a type test), and errors that never include the input.

Evidence gathered 2026-10-13 17:27Z (npm registry; `pnpm install --config.minimumReleaseAge=10080` at 17:43:02Z, nothing committed for it):

- `decimal.js` `latest` is 10.6.0, published 2025-07-06T22:50:38.844Z (over a year old). No dependencies, no install scripts, an ESM entry (`decimal.mjs`) that imports nothing, bundled types. Integrity `sha512-YpgQiITW3JXGntzdUmyUR1V812Hn8T1YVXhCu+wO3OpS4eU9l4YdD3qjyiKdV6mvV29zapkMeD390UVEf2lkUg==`.
- `fast-check` `latest` is 4.10.2, published 2026-09-19T19:34:54.991Z (24 days old at install). Its one dependency is `pure-rand` `^8.0.0`, resolved to 8.4.2 (published 2026-07-10T07:55:10.896Z, no install scripts, integrity `sha512-vvuOGgcuPJAirlHvuQw1TrOiw7ptaIXXmIbNuiNOY6lNGJJH49PQ1Kj4nd783nPdQhQdicgOjVI2yI/9BD6/Ng==`). Integrity of fast-check `sha512-iK2f+YrcmoeGqk6fA0ea2bptcu/itMIm4NfEozq6N25+aG6h7s5HZbB/k1aV7b5w5sFLMCbbtRUsTVR+BgC3xw==`.
- `zod` stays at 4.6.5 (ADR 0039).
- **The official ISO 4217 lists were unreachable from the agent environment (the ruling's conditional fired):** `www.six-group.com` (list-one.xml, list-three.xml), `www.iso.org` and Wikipedia all answered with a proxy `403` (CONNECT refused). Reachable: `github.com/datasets/currency-codes`, a public-domain dataset (ODC-PDDL-1.0) whose own build script downloads those two SIX files and writes `data/codes-all.csv`.

## Decision

### ISO 4217 data: a pinned public-domain mirror of the SIX lists, cross-checked by the owner (D1, change 1)

- `packages/money/data/iso4217.json` is **generated** by `packages/money/scripts/generate-iso4217.mjs` from the committed snapshot `packages/money/data/source/codes-all.csv`, which is `datasets/currency-codes` at commit `ab9b0ae88e8bffd4ac1c468ce9c784738d3376ba` (committed 2026-02-01T02:10:25Z; SHA-256 `c4b6829a966f0564e77dc6c2d100d268cce61b30f7637bf3d5ec626b0393407f`), downloaded 2026-10-13 from `https://raw.githubusercontent.com/datasets/currency-codes/ab9b0ae88e8bffd4ac1c468ce9c784738d3376ba/data/codes-all.csv`. The JSON records the dataset, URL, commit, commit date, the two upstream SIX URLs, the licence, the retrieval date and the snapshot's SHA-256 (`data/source/source.json`, copied into the file's `source` block).
- **Staleness (for architect review):** the mirror's last automated refresh is 2026-02-01, so the committed data is the SIX list as of that date (SIX amendment 178, VED exponent fix, is included; anything SIX published after 2026-02-01 is not). The owner's cross-check before merge closes that gap: `pnpm --filter @bricx/money gen:iso4217 -- --source six` downloads list-one.xml and list-three.xml from SIX, parses them with the same transform, prints every difference from the committed file and exits 1 if there is any. A later task refreshes the snapshot when SIX publishes an amendment (bump `COMMIT` in the script, rerun, commit the CSV, `source.json` and JSON together).
- `test/iso4217-data.test.ts` reruns the pure transform on the snapshot and requires a **byte-identical** `iso4217.json`, and checks the snapshot's SHA-256 against `source.json`: a hand edit to any of the three files fails the test.
- Entries: one per alphabetic code, sorted. Several entities share a code (EUR, USD); rows for one current code must agree or the generator fails. A code that is only withdrawn keeps its latest withdrawal row. "No universal currency" rows (no code) are dropped.
- **Codes whose minor unit is N.A. (D2)** (XAU, XAG, XPT, XPD, XDR, XSU, XUA, XTS, XXX, XBA–XBD): listed with `exponent: null`, `historical: false`; `parseCurrencyCode` rejects them with `no_minor_unit`, so they cannot form `Money`.
- **Historical codes (D3):** listed with `historical: true`, `withdrawn` as published ("2023-12" for SLL) and `exponent: null`, because the source gives no minor unit for withdrawn codes and nothing is invented; `parseCurrencyCode` rejects them with `historical_currency`. SLE (925) is current with exponent 2. Tests assert SLE, SLL, USD, EUR, GBP, JPY (0), BHD (3) and CLF (4) (change 2).
- 307 entries, of which 165 can form `Money`.

### Money (D5, D6, D11)

- `Money` is a frozen, branded plain object `{ amount: bigint, currency: CurrencyCode }` made only by `fromMinor(bigint | string, currency)`, `fromMajor(string, currency)`, `zero(currency)` and the package's own operations. Nothing accepts a JS number for an amount: a type test (`test/types.test-d.ts`, compiled by `tsc`) proves it, and `test/types-sabotage.test.ts` compiles a copy of `money.ts` with `number` added to `fromMinor` and requires the `@ts-expect-error` to become unused. At run time a number also throws `invalid_amount`.
- `isMoney` recognises only values made here (a `WeakSet`); operations throw `not_money` on look-alike objects.
- **Range (D6):** every amount, input or result, must fit Postgres `bigint` (−2^63 … 2^63 − 1) or the operation throws `out_of_range`; nothing wraps.
- `fromMinor` string form: digits with an optional leading minus sign, no plus sign, no whitespace, no leading zeros, no negative zero, no exponent, no decimal point (change 3). `fromMajor` takes the same integer part plus an optional fraction; **more fraction digits than the exponent throws `too_many_fraction_digits`, nothing is rounded (D11)**.
- `add`, `subtract`, `compare` and `equals`' currency check throw `currency_mismatch`; `negate`, `isZero`, `isNegative`, `isPositive`, `toMajorString` (exact, for every exponent) and `toMoneyJson`.
- `multiply(money, factor, rounding)`: the factor is a `Decimal` or a plain decimal string (never a number); rounding is required.

### Rounding (D8)

`Rounding` is a string enum of seven modes: `HALF_EVEN`, `HALF_UP`, `HALF_DOWN`, `UP`, `DOWN`, `CEILING`, `FLOOR`, mapped to decimal.js's constants. No operation has a default except `convert` (HALF_EVEN). An unknown mode throws `invalid_rounding`.

### decimal.js use (D7)

- A private `Decimal.clone({ precision: 64, rounding: HALF_EVEN, toExpNeg: -1000, toExpPos: 1000 })` (`src/decimal.ts`, not exported); the global `Decimal` configuration is never read or changed. 64 digits hold a 19-digit amount times a 24-digit rate exactly, so the only rounding in any operation is the final one to a whole minor unit.
- Ratios, factors and rates are accepted as `Decimal` or a plain decimal string (optional sign where allowed, no exponent, no leading zeros); a JS number, `NaN`, `Infinity` or an exponent string throws.

### allocate (D9, change 5)

- Ratios are `bigint`, `Decimal` or decimal strings (at most 64 digits), scaled to integers `w_i` by a common power of ten; `W = Σ w_i`. For `A = |amount|`: `floor_i = A·w_i div W`, `rem_i = A·w_i mod W`, all in `bigint`. The `A − Σ floor_i` leftover units (fewer than the number of parts) go one each to the largest remainders; **equal remainders go to the lowest index** (a stable sort). A negative amount is split on its absolute value and every part negated (symmetric); a zero amount gives zeros; a zero ratio gets nothing.
- Throws: `no_ratios`, `invalid_ratio`, `negative_ratio`, `ratios_sum_zero`.
- Tests cover a zero total, a negative total, a single ratio, a zero ratio, equal ratios with a remainder, a total smaller than the number of parts, and a total above 2^53; properties cover 500 random cases per arbitrary.

### convert and the rate limits (change 4)

- `convert(money, rate, target, rounding = HALF_EVEN)` computes `amount · rate · 10^(e_target − e_source)` exactly and rounds once; `rateUsed` is the rate as a normalised plain decimal string.
- The rate is positive and finite and must fit `NUMERIC(24,12)`: at most 12 integer digits and at most 12 fraction digits (trailing fraction zeros carry no value and are not counted). More throws `rate_precision`; **nothing is rounded silently**, so the stored rate is exactly the rate used. Boundary tests: 12 + 12 digits pass, 13 fraction digits and 13 integer digits throw.

### Convert round-trip bound (change 7)

Let `m` be the source amount in minor units, `e_s`, `e_t` the exponents, `k = 10^(e_t − e_s)`, `r` the rate, `r'` the inverse rate as stored (so `r·r'` is close to but not necessarily 1). With `t = round₁(m·r·k)` and `b = round₂(t·r'/k)`:

```
t − m·r·k = ε₁            |ε₁| ≤ d₁
b − t·r'/k = ε₂           |ε₂| ≤ d₂
b − m = m·(r·r' − 1) + ε₁·r'/k + ε₂
|b − m| ≤ |m|·|r·r' − 1| + d₁·r'/k + d₂
```

where `d = 1/2` for `HALF_EVEN`, `HALF_UP`, `HALF_DOWN` (nearest) and `d = 1` for `UP`, `DOWN`, `CEILING`, `FLOOR`. The property test computes this bound from the generated `m`, `r`, `r'`, exponents and modes for 2,000 cases and asserts `|b − m|` is within it; nothing in the bound was fitted to test output. With `r·r' = 1` and `e_s = e_t`, the bound is `d₁·r' + d₂`, so an exactly invertible rate with `r' ≤ 1` round-trips within one minor unit (second property).

### format (D10, change 6)

`formatMoney(money, locale, { currencyDisplay? })` builds `Intl.NumberFormat` with `style: "currency"`, the code, and `minimumFractionDigits = maximumFractionDigits = exponent`, and passes the exact major-unit **decimal string** (ECMA-402 Intl.NumberFormat v3 formats strings exactly): no float anywhere, so `2^53 + 1` cents and the 64-bit extremes print every digit (tests in en-US, fr-FR, ja-JP for JPY, BHD, SLE, CLF, USD). An unknown locale throws `invalid_locale`. **For architect review:** TypeScript 5.9's `lib.es2020.intl` types `format` as `number | bigint`, so the string is passed through one cast in `format.ts`; P7 must confirm the client runtime (Hermes) accepts string input, else P7 formats the integer part as a bigint and joins the fraction.

### MoneySchema (change 3)

- `MoneyJsonSchema` is a Zod `strictObject` of `amount` (string) and `currency` (string); `MoneySchema` is a Zod codec: `parse` decodes JSON to `Money`, `encode` gives `{ amount: "<minor units>", currency }`.
- `amount` must be a string of minor units in the `fromMinor` form above, inside signed 64 bits; `currency` an ISO 4217 code with a non-null exponent. Rejected, one test each: a JSON number (float or integer), a decimal point, exponent notation, a leading zero, `-0`, a `+` sign, whitespace, an empty string, hex, separators, values above and below 64 bits, a 400-digit string, a lowercase or unknown code, a historical code, an N.A. code, a missing field, an extra key, a non-object.
- Issue messages are the `MoneyError` codes (`amount_not_string`, `invalid_amount`, `out_of_range`, `invalid_currency`, `historical_currency`, `no_minor_unit`, `unknown_key`, `not_an_object`) and the issues carry no input.

### Errors (P3 rule 9)

`MoneyError` holds `code` and a fixed message chosen by the code (18 codes), no `cause`. The messages contain no digit strings or sign characters that a test input could match, and every rejection test asserts the input is absent from the message; a sabotage mutant that echoes the input is caught.

### Exports and placement (P3 rule 5)

Eight subpaths, no root entry: `@bricx/money/currency`, `/rounding`, `/money`, `/allocate`, `/fx`, `/format`, `/schema`, `/errors`. `src/decimal.ts` is internal. `src/` imports only its own files, `../data/iso4217.json`, `decimal.js` and `zod` (static scan), and every module loads and computes with `globalThis.crypto` and `process` removed (runtime test). `data/iso4217.json` is imported directly (D13; `resolveJsonModule` is on in the base tsconfig and Metro reads JSON).

### Dependencies (D12)

`decimal.js` 10.6.0 and `zod` 4.6.5 as `dependencies` of `packages/money`; `fast-check` 4.10.2 as its `devDependency` (not a root dev dependency: only money uses it until P4's ledger). DEPENDENCIES.md rows updated. No money → ids edge (D4): money imports nothing from `@bricx/ids`, so no workspace dependency and no pnpm-link proof is added; the boundaries policy allows that edge for when one appears.

### Lint (extends ADR 0041)

- New boundaries element `money` (`packages/money/src/**`, anchored like `ids`) and policy: money source may import `@bricx/ids`, its own `data/`, `decimal.js` and `zod`, and nothing else (no other workspace package, no other npm module, no Node built-in). The ids policy now also rejects the `money` element. `bricx/domain-clock` (no `Date.now()`, zero-argument `new Date()`, `Math.random`) covers `packages/money/src`.
- `tooling/eslint-smoke`: 8 money fixtures (money → db, → domain, → npm, → `node:crypto`, `Date.now()`, `new Date()`, `Math.random()`; the allowed control imports `@bricx/ids`, its data and its own file; money tests allowed) plus the ids → money fixture re-pointed at the new element. They were red before the config change (21 problems). `check-real.mjs` lints probe text at the real `packages/money/src/money.ts` path (built-in, npm and `packages/config` imports, `Date.now()`, `Math.random()` rejected; `decimal.js` and `zod` pass through the real `node_modules`) and at `packages/money/test/money.test.ts` (nothing).
- Semgrep rules `bricx-clock-in-money-permissions` and `bricx-money-float-coercion` (ADR 0043) scan the package in CI; the scan is clean.

### Coverage and tests (P3 rules 1–3)

`packages/money` was already in `STRICT_PATHS` (95% lines). 224 tests in 12 files were written first and failed before any source existed (12 of 12 files red). Lines 100%, functions 100%. Sabotage: 11 mutants (allocate drops the remainder, ties to the highest index, leftover to the first part, signed floors; add ignores the currency; convert ignores exponents, defaults to HALF_UP, rounds an over-precise rate; format through a float; an error echoing its input; `fromMinor` accepting `number` at the type level), each caught by the same checks the real tests run.

## Consequences

- Money arithmetic needs no float anywhere; the only `number` in the package is a currency exponent.
- A `Money` cannot hold a value Postgres `bigint` cannot store; the API's ledger (P4) stores `amount` as `bigint` and `currency` as `char(3)` without conversion.
- Callers must choose a rounding mode for `multiply` and `allocate` uses none; FX conversions default to HALF_EVEN.
- The ISO 4217 snapshot is a dated file: a currency change published by SIX after 2026-02-01 is not in it until the snapshot is refreshed, and the owner's `--source six` cross-check is the gate before this merge.

## Negatives (for architect review)

- The committed ISO data comes through a mirror, not from SIX directly, because of the agent proxy; the owner's cross-check is manual until a task adds a scheduled job or an allow-listed fetch.
- `format.ts` relies on Intl.NumberFormat's string input (ECMA-402 v3) through a cast; older engines would coerce the string to a float. P7 verifies Hermes.
- The 64-bit range is enforced in every operation (an extra comparison per result).
- Withdrawn codes carry no exponent in this data, so a historical amount (an old SLL ledger line) cannot be built as `Money`; a migration of historical records will need its own table of past exponents.
