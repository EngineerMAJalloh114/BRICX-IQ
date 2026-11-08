# 0074. Adapter registry: server-only descriptors, Null adapters, boot validation and adapter-id checks

- Status: Accepted
- Date: 2026-11-07
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP P6-04 and its P6-03 Also line; P6 phase plan approved 2026-11-06 16:46Z (P6-04 D1–D5 as ★, rulings R11 and R12); P6-04 task plan approved 2026-11-07 14:19Z (D6–D15 as ★, owner conditions C1–C5); ADR 0073 (region configuration, D4 and D12), CLAUDE.md rules 1, 3, 5, 8 and 10

## Context

The countries BRICX IQ serves pay, file tax, keep books, send SMS and convert currency through different providers. Each provider will be an adapter, and an organisation picks its adapters in its region configuration. P6-03 stored those picks as ids it checked only for shape: `payment_adapters` and `accounting_adapter` matched `ADAPTER_ID_PATTERN`, and the P6-03 Also line left the real check to this task. No real adapter exists yet: the first SMS adapter comes with P12-03, the first FX provider with P9-02, payment adapters with P17 and accounting with P21.

## Decision

### D6. A server-only package

The adapters live in `@bricx/adapters` and are exported through three subpaths: `./types`, `./null` and `./registry`. There is no root barrel.

- **Server-only.** Adapters will hold provider calls and secrets, so `apps/client` may not import the package (owner condition C3). An `eslint-plugin-boundaries` policy refuses the import, and `tooling/eslint-smoke` proves it with a violation fixture under `apps/client` and an allowed control under `apps/api`.
- **Dependencies.** The package depends only on workspace packages:
  - `@bricx/domain`: `ADAPTER_ID_PATTERN` and `Result`;
  - `@bricx/money/currency`;
  - `@bricx/validation/country`.

  It also uses the Node built-in `node:crypto`. No npm package is added, so no 7-day check applies. `zod` arrives with the first adapter that parses a provider payload.

### D7. Descriptors and boot validation

Every adapter is a descriptor `{ id, kind, countries, currencies }`, where kind is `payment`, `tax`, `accounting`, `sms` or `fx`. A Null adapter also carries `nullAdapter: true`.

`buildRegistry(adapters, { nodeEnv })` validates the list and refuses it with an `AdapterRegistryError`. The error carries a code and the adapter's index in the list, and its message never holds the refused value. The codes are:

- `invalid_id`: the id does not match `ADAPTER_ID_PATTERN`.
- `duplicate_id`: the id is already used, by any kind.
- `no_capabilities`: the adapter declares no countries or no currencies.
- `unknown_country`: a country that is not ISO 3166-1 alpha-2.
- `unknown_currency`: a currency that is not a current ISO 4217 code with a minor unit.
- `null_in_production`: a Null adapter while `nodeEnv` is `production` (phase plan D1).

The first refusal stops the list. A built registry is frozen, including its lists, descriptors and capability lists, and later changes to the input list do not reach it (C5). It answers `has(kind, id)` and `list(kind)`.

### C2. The environment is an input

`buildRegistry()` takes the environment as an explicit argument and never reads `process.env`. The API's `createApp()` and the worker's `runWorker()` pass their validated config's `nodeEnv`.

The adapter list is `defaultAdapters(config.nodeEnv)`, unless a test passes the test-only `adapters` factory option. No environment variable or config key reaches that option, and `bootstrap.ts` and the worker's `main.ts` never set it.

### D8. The Null adapters and the registries

There are five Null adapters: `null_payment`, `null_tax`, `null_accounting`, `null_sms` and `null_fx`. Each declares every ISO 3166 country and every current ISO 4217 currency.

- **Outside production**, `defaultAdapters()` returns the five Null adapters.
- **In production** it returns nothing until P12-03, P17-03 and P21-02 add real adapters. An empty registry is valid, so production boots, and every adapter-id write answers 422 until then.

### D12, C4. What the interfaces hold

`PaymentAdapter`, `TaxAdapter` and `AccountingAdapter` are descriptors only, with no stub methods, because an unused stub would be an untested API. P17-01 and P21-01 add their contracts.

`SmsAdapter.send({ to, templateKey, params })` and `FxRateProvider.rate({ from, to, at })` are typed now. `rate()` returns `Result<decimal string, "unavailable">`.

**Design rule (C4, CLAUDE.md rule 10):** the Null payment adapter can never report a payment verified or paid. Today it has no method that could. When P17-01 adds the payment contract, the Null adapter's `verify` and `status` must answer that the payment is not verified and not paid, whatever the input, and its contract test kit pins this.

### D2. The Null FX provider

`rate()` always answers `unavailable` and never returns an invented number (CLAUDE.md rule 1).

### D3, D13, C1. The Null SMS adapter

`send()` records `{ templateKey, recipientHash }` in memory, and an injected log callback receives the same two fields and nothing else.

`recipientHash` is an HMAC-SHA-256 of the E.164 number. Its key is 32 random bytes from `node:crypto`'s `randomBytes`, drawn once per adapter instance, and the result is cut to 8 hex characters (C1). One instance hashes a number the same way every time, so its sends can be correlated. A plain SHA-256 is never used, because a reader could look a number up from it. A test checks that no number, no message text and no unkeyed hash reaches the callback, the console, stdout or stderr.

### D9. Adapter ids on write (the P6-03 Also line)

`RegionConfigService` checks every PATCH against the registry, which it receives under `ADAPTER_REGISTRY`. The `AdaptersModule` global provider supplies that token.

- **A changed `paymentAdapters` list is checked in full.** Every id must be a registered payment adapter, so a stale id must be removed before the list can be changed.
- **A changed `accountingAdapter`** must be a registered accounting adapter.
- **An unknown id, or an id of the wrong kind**, answers 422 `validation_failed`. The issue code is `unknown_adapter` (`validation:unknown_adapter`, in en, fr and ar) at the field's path, and the value is never included.
  - For the list, the issue names the field without an index. The DTO has already sorted the list (ADR 0073 D12), so an index would point at the wrong entry of the client's list (architect-reviewed 2026-11-08).
  - The check runs before the write, so nothing is written and no audit event is recorded.
- **A field equal to its stored value is not re-checked.** A no-change body that repeats a stale id stays 200 and writes nothing (ADR 0073 C1).
- **Null and an empty list** always pass.

### D10. Adapter ids on read

A stored id that the registry does not know, such as an adapter that has since been removed, is returned unchanged. Both GET routes and `/effective` return it, with no filter and no flag.

### D11. Boot

The API's `createApp()` builds the registry first, before any pool opens, and a broken list makes it throw `AdapterRegistryError`.

The worker's `runWorker()` builds it before any connection. A broken list logs `worker.boot_failed` with the code `adapter_registry`, the registry's code and the index, then exits 1.

There is no config key.

## Consequences

- Organisations in production cannot set adapter ids until the first real adapters ship. This is intended, because no provider is integrated yet.
- The P6-03 integration suite registers its test ids (`orange_money`, `mpesa`, `stripe` and `xero`) through the test-only `adapters` option. Its assertions are unchanged.
- The new issue code changes the OpenAPI issue-code enum. The api-client is regenerated.
- A Null adapter must always set `nullAdapter: true`. That flag is what `null_in_production` checks, so a Null adapter without it would boot in production. Every task that adds a real adapter keeps this rule: a stand-in, fake or development adapter carries the flag, and a real one never does.
- Also lines:
  - P17-01: the payment contract replaces the descriptor-only `PaymentAdapter`. The Null payment adapter must never report a payment verified or paid (C4), and the contract kit pins it.
  - P21-01: the same for `AccountingAdapter`, and the tax adapter contract (architect-reviewed 2026-11-08: no task names a tax adapter contract).
  - P12-03: the first SMS adapter in the production registry.
  - P9-02: the first FX provider, behind `FxRateProvider`.
  - P7-01: once `apps/client` exists, the `@bricx/adapters` boundary smoke test also runs on its real path, not only on the fixture layout (C3).

## Alternatives rejected

- **Checking adapter ids in the DTO.** A no-change body that repeats a stale id would be refused, against ADR 0073 C1.
- **A `known: false` flag on read.** It changes the API shape for a case only an operator causes.
- **Typed method stubs for payment, tax and accounting.** That would be an untested API before its contract exists.
- **Fixed development FX rates.** They are invented numbers (CLAUDE.md rule 1).
- **Delivering Null SMS to Mailpit.** It would put recipients and text where logs and inboxes keep them.
- **A plain SHA-256 recipient hash.** It can be reversed by enumerating phone numbers (C1).
