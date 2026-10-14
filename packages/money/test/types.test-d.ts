// Type tests (P3-02 ruling: "no public constructor that accepts a JS number
// for the amount; prove with a type test"). `tsc --noEmit` (the package's
// typecheck) compiles this file: each @ts-expect-error must still be an
// error, or tsc fails with "Unused '@ts-expect-error' directive".
// types-sabotage.test.ts proves that by compiling a sabotaged copy.
import Decimal from "decimal.js";
import { allocate } from "../src/allocate.js";
import { parseCurrencyCode } from "../src/currency.js";
import type { CurrencyCode } from "../src/currency.js";
import { convert } from "../src/fx.js";
import { fromMajor, fromMinor, multiply } from "../src/money.js";
import type { Money } from "../src/money.js";
import { Rounding } from "../src/rounding.js";

const usd: CurrencyCode = parseCurrencyCode("USD");

// Allowed: bigint and string amounts.
export const ok1: Money = fromMinor(1n, usd);
export const ok2: Money = fromMinor("1", usd);
export const ok3: Money = fromMajor("1.00", usd);

// @ts-expect-error a JS number is not an amount
export const bad1 = fromMinor(1, usd);
// @ts-expect-error a JS number is not a major amount either
export const bad2 = fromMajor(1.5, usd);

// @ts-expect-error amount is readonly
ok1.amount = 2n;
// @ts-expect-error currency is readonly
ok1.currency = usd;

// @ts-expect-error a plain object is not Money (no brand)
export const bad3: Money = { amount: 1n, currency: usd };

// @ts-expect-error a plain string is not a CurrencyCode
export const bad4: CurrencyCode = "USD";

// @ts-expect-error rounding is required by multiply
export const bad5 = multiply(ok1, "0.5");
// @ts-expect-error a JS number is not a ratio
export const bad6 = multiply(ok1, 0.5, Rounding.HALF_EVEN);
export const ok4 = multiply(ok1, new Decimal("0.5"), Rounding.HALF_EVEN);

// @ts-expect-error a JS number is not a rate
export const bad7 = convert(ok1, 1.1, usd);
export const ok5 = convert(ok1, "1.1", usd);

// @ts-expect-error a JS number is not an allocation ratio
export const bad8 = allocate(ok1, [1, 2]);
export const ok6 = allocate(ok1, [1n, "2", new Decimal(3)]);

// @ts-expect-error the result list is readonly
export const bad9: Money[] = ok6;
