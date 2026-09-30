# 0007. Money: own `@bricx/money` package with bigint minor units

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C7

## Context

Stack v1 suggested Dinero.js or a generic decimal library. Dinero.js v2 has sat in pre-release for years. Money is core to the platform and must be owned. Currencies have different minor-unit exponents (JPY 0, BHD 3, SLE 2), so "2 decimals" can never be hard-coded.

## Decision

Build our own `@bricx/money` package:
- Amounts are **`bigint` minor units** (Postgres `BIGINT`) plus an ISO 4217 currency code.
- FX rates are **`NUMERIC(24,12)`**, handled with **decimal.js**.
- Minor-unit exponents come from the ISO 4217 table, committed as a JSON file rather than a package.
- Floating point is never used for money.

## Consequences

Positive:
- Money handling is owned and does not depend on a pre-release library.
- Exact integer arithmetic with correct exponents for every currency.

Negative:
- We own correctness of allocation, rounding, conversion and formatting, which needs strong property tests and high coverage. (architect-reviewed 2026-09-30)
- `bigint` is not JSON-serialisable, so amounts must be carried as strings across the API and handled carefully in every client. (architect-reviewed 2026-09-30)
- The ISO 4217 table must be kept current by us when currencies change (for example SLL to SLE). (architect-reviewed 2026-09-30)

## Alternatives rejected

- **Dinero.js**: v2 has sat in pre-release for years. Banned in DEPENDENCIES.md.
- **big.js, bignumber.js, currency.js**: banned in DEPENDENCIES.md; use `@bricx/money` + `decimal.js`.
