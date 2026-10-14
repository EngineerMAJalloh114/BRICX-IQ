# @bricx/money

Money as `bigint` minor units plus an ISO 4217 code (P3-02, ADR 0045). Immutable values, explicit rounding, largest-remainder allocation, decimal.js FX, `Intl.NumberFormat` output, and a Zod schema whose JSON amount is a string. Runs on the API, the worker and devices: the source imports only its own files, its data, `decimal.js` and `zod`.

```ts
import { fromMinor, fromMajor, add, multiply } from "@bricx/money/money";
import { Rounding } from "@bricx/money/rounding";
import { allocate } from "@bricx/money/allocate";
import { convert } from "@bricx/money/fx";
import { formatMoney } from "@bricx/money/format";
import { MoneySchema } from "@bricx/money/schema";

const price = fromMajor("12.34", "USD");            // { amount: 1234n, currency: "USD" }, frozen
const total = add(price, fromMinor(66n, "USD"));     // 1300n; a different currency throws currency_mismatch
const vat = multiply(total, "0.15", Rounding.HALF_EVEN);   // rounding is required
const [a, b, c] = allocate(total, [1n, 1n, 1n]);     // 434n, 433n, 433n: parts sum exactly, ties to the lowest index
const { money: eur, rateUsed } = convert(total, "0.92", "EUR");   // HALF_EVEN by default; rate must fit NUMERIC(24,12)
formatMoney(total, "en-US");                         // "$13.00"; JPY 0, BHD 3, SLE 2 fraction digits
MoneySchema.encode(total);                           // { amount: "1300", currency: "USD" }
MoneySchema.parse({ amount: "1300", currency: "USD" });
```

- **Amounts are never JS numbers.** `fromMinor` takes a `bigint` or a canonical string; `fromMajor` takes a decimal string and throws (`too_many_fraction_digits`) rather than round. A type test proves no factory accepts `number`.
- **Range:** every result must fit Postgres `bigint` (signed 64 bits) or the operation throws `out_of_range`.
- **Rounding:** `Rounding.HALF_EVEN | HALF_UP | HALF_DOWN | UP | DOWN | CEILING | FLOOR`. No default anywhere except `convert`.
- **Ratios, factors and rates:** a `Decimal` or a plain decimal string (no exponent, at most 80 characters), checked before any conversion. Factors are signed with at most 12 integer and 12 fraction digits (`factor_precision` otherwise), so `multiply` rounds exactly once. Rates are positive and must fit `NUMERIC(24,12)` (`rate_precision` otherwise; nothing is rounded silently). Ratios have at most 64 digits.
- **Boundaries:** `isMoney` is a per-module `WeakSet`, so a Money that crosses `structuredClone`, a worker boundary or a duplicate copy of the package is not Money; re-parse with `MoneySchema` at every boundary.
- **JSON (`MoneySchema`):** `amount` is a string of **minor** units: an integer with an optional leading `-`, no `+`, no whitespace, no leading zeros, no `-0`, no exponent, no decimal point, inside signed 64 bits. `currency` is a current ISO 4217 code with a minor unit. Issue messages are codes and never contain the input.
- **Currencies:** `data/iso4217.json` is generated (see below). `parseCurrencyCode` rejects unknown codes, withdrawn codes (`SLL`, `historical_currency`) and codes without a minor unit (`XAU`, `no_minor_unit`). `currencyInfo` reads any entry; `listCurrencies` lists the usable ones.
- **Errors:** `MoneyError` with a `code`; messages are fixed per code and never include the input. `MONEY_ERROR_CODES` lists every code (frozen; a compile-time check keeps it equal to the `MoneyErrorCode` union); `@bricx/validation` maps each to the i18n key `errors:money.<code>` (P3-04, ADR 0047).

## ISO 4217 data

`data/iso4217.json` is written by `scripts/generate-iso4217.mjs` from `data/source/codes-all.csv`, a snapshot of [datasets/currency-codes](https://github.com/datasets/currency-codes) (ODC-PDDL-1.0, built from the SIX list-one.xml and list-three.xml files) pinned by commit and SHA-256 in `data/source/source.json`. The file records its source, commit, retrieval date and hash; `test/iso4217-data.test.ts` regenerates it offline and requires a byte-identical result, so it cannot be hand-edited.

```bash
pnpm --filter @bricx/money gen:iso4217 -- --offline        # regenerate from the committed snapshot
pnpm --filter @bricx/money gen:iso4217 -- --source six     # diff the committed file against SIX (exit 1 on any difference)
pnpm --filter @bricx/money gen:iso4217                     # re-download the pinned snapshot, then regenerate
```

To refresh: bump `COMMIT` in the script, run it, and commit the CSV, `source.json` and JSON together.

## Tests

```bash
pnpm --filter @bricx/money test                                                   # 95% line coverage required
pnpm --filter @bricx/money exec vitest run test/sabotage.test.ts test/types-sabotage.test.ts --reporter=verbose   # 11 mutants caught
pnpm --filter @bricx/money typecheck                                              # includes test/types.test-d.ts
```
