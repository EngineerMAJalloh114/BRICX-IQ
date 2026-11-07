# @bricx/adapters

The adapter registry (P6-04, ADR 0074). Every provider integration (payment, tax, accounting, SMS, FX) is an adapter: a descriptor with an id, a kind and the ISO 3166 countries and ISO 4217 currencies it serves. The API and the worker build the registry at boot from code and refuse to start when it is broken.

**Server-only.** Adapters will hold provider calls and secrets: `apps/client` may not import this package (an ESLint boundary). `apps/api` and `apps/worker` do.

```ts
import { buildRegistry, defaultAdapters } from "@bricx/adapters/registry";
import { createNullSms } from "@bricx/adapters/null";

// The environment is an input; the registry never reads process.env.
const registry = buildRegistry(defaultAdapters(config.nodeEnv), {
  nodeEnv: config.nodeEnv,
});
registry.has("payment", "null_payment"); // true outside production
registry.list("sms"); // frozen descriptors

const sms = createNullSms({ log: (entry) => logger.info(entry) });
await sms.send({ to: "+23276123456", templateKey: "k", params: {} });
// logs { templateKey: "k", recipientHash: "3f9a0c1e" }: an HMAC under a per-instance key, never the number
```

- `buildRegistry()` refuses `invalid_id`, `duplicate_id`, `no_capabilities`, `unknown_country`, `unknown_currency` and `null_in_production` with an `AdapterRegistryError` carrying the code and the adapter's index, never a value.
- `defaultAdapters(nodeEnv)`: the five Null adapters (`null_payment`, `null_tax`, `null_accounting`, `null_sms`, `null_fx`) outside production; nothing in production until the first real adapters (P12-03, P17-03, P21-02).
- Payment, tax and accounting adapters are descriptors only until P17-01 and P21-01 add their contracts. The Null payment adapter can never report a payment verified or paid. The Null FX provider answers `unavailable` for every rate.
