# 0064. `@keycloak/keycloak-admin-client` 26.8.1 in the worker

- Status: Accepted
- Date: 2026-10-21
- Deciders: Mohamed Abass Jalloh
- Source: P5-04 (task plan approved 2026-10-21 with decisions 1–3 and 5–8 as proposed, decisions 4 and 9 changed, and owner conditions 1–8; this ADR answers condition 6); the P5 phase plan (`@keycloak/keycloak-admin-client` 26.8.1 named for P5-04, seven-day rule cleared on 2026-10-20); ADR 0023 (dependency policy: exact pins, a seven-day release age, no install scripts); ADR 0056 (the worker and its relay); ADR 0060 (the `bricx` realm); ADR 0063 (`sessions.revoked`); ADR 0065 (immediate revocation, the consumer that uses this package).

## Context

P5-04 ends a user's Keycloak session when BRICX revokes it, so that the refresh token dies with the API session. That is an Admin REST API call (`DELETE /admin/realms/bricx/sessions/{id}`) authenticated with a service account's client-credentials token. The call is made by the worker, which consumes the `sessions.revoked` outbox topic (ADR 0065): the request writes outbox rows only (rule 5), and the API never talks to Keycloak's admin API. DEPENDENCIES.md listed the package under `apps/api` for "session revocation, user provisioning"; provisioning turned out to need no admin call (ADR 0062), and revocation runs in the worker, so the row moves.

P5-05 will use the same client to set and clear the `bricx-mfa` realm role (ADR 0060).

## Decision

- `@keycloak/keycloak-admin-client` **26.8.1**, an exact pin in `apps/worker` only. Published 2026-10-13T08:59:25.658Z (eight days before this task started; installed with `--config.minimumReleaseAge=10080`), Apache-2.0, no install scripts, integrity `sha512-1l69rXFuMOw0nQ98u2sZLrVqrSugb0QSx+Pan9cqL0b1xfWBWfVt9MjXqCSpv0BEBvig/NUz7TJm6/ugiW3r4A==`. It is the client Keycloak publishes from its own repository, versioned with the server (the dev stack runs 26.7.5; the admin API is stable across 26.x).
- Its dependency closure, every package checked against the registry (publish date, licence, install scripts) and listed here because 26.8.x generates its client with Microsoft Kiota and pulls a **preview** line of Kiota packages:

  | Package | Version | Published | Licence | Install scripts |
  |---|---|---|---|---|
  | `@microsoft/kiota-abstractions` | 1.0.0-preview.103 | 2026-06-17 | MIT | none |
  | `@microsoft/kiota-http-fetchlibrary` | 1.0.0-preview.103 | 2026-06-17 | MIT | none |
  | `@microsoft/kiota-serialization-form` | 1.0.0-preview.103 | 2026-06-17 | MIT | none |
  | `@microsoft/kiota-serialization-json` | 1.0.0-preview.103 | 2026-06-17 | MIT | none |
  | `@microsoft/kiota-serialization-multipart` | 1.0.0-preview.103 | 2026-06-17 | MIT | none |
  | `@microsoft/kiota-serialization-text` | 1.0.0-preview.103 | 2026-06-17 | MIT | none |
  | `@std-uritemplate/std-uritemplate` | 2.0.12 | 2026-07-16 | Apache-2.0 | none |
  | `camelize-ts` | 3.0.0 | 2023-04-24 | MIT | none |
  | `tinyduration` | 3.4.1 | 2025-01-18 | MIT | none |
  | `url-template` | 3.1.1 | 2023-12-13 | BSD-3-Clause | none |

  `tslib` and `@opentelemetry/api` 1.9.1 were already in the lockfile (`drizzle-orm`, `vitest`). Twelve new lockfile entries in all, none younger than seven days at install, none with an install script (`pnpm ignored-builds` lists nothing new). `pnpm why -r` shows the one version, depended on by `@bricx/worker` only; `pnpm audit --prod` is unchanged (the one high is `braces`, ignored under ADR 0037).
- The Kiota packages are pinned exactly by the client (`1.0.0-preview.103`, not a range), so a Dependabot bump of the client is the only way they move, under the cooldown (ADR 0044).
- The worker uses it for one thing in P5-04: `realms.deleteSession({ realm, session })` with a client-credentials token for `bricx-worker` (ADR 0060, amended; ADR 0065 has the consumer's rules, the boot check and the retries). No other new dependency: the API's revocation check uses `ioredis` 6.0.0, already an `apps/api` dependency since P4-01 (ADR 0051, the Valkey readiness probe), and the worker's Valkey connection is the same package since P4-06.

## Consequences

- Positive: Keycloak's own client, typed against the admin API the server ships, reused by P5-05 (`bricx-mfa`), with token handling (client credentials, refresh) that is not hand-written.
- Negative: a preview dependency line (six Kiota packages) in the worker's production closure, pinned by the client. Any security advisory on them reaches the worker through Dependabot (ADR 0033).
- Negative: the client's closure is larger than a plain `fetch` call would be (ten packages for one DELETE). Accepted because P5-05 needs the role endpoints too.

## Alternatives rejected

- Two `fetch` calls (client-credentials token, then `DELETE sessions/{id}`): no new package, but a hand-written OAuth client-credentials flow with token caching and refresh, repeated for the role calls at P5-05.
- 26.7.5 (the dev stack's server version): the client's 26.7.x line was published before the seven-day rule mattered, but the owner named 26.8.1, which is current and compatible with 26.7.5's admin API; the next server bump follows the client.
- Keycloak's `users/{id}/logout` (every session of a user): needs the Keycloak user id, which the outbox payload does not carry (ids only, and the API knows the `sub` only inside the request); the per-session delete is exact and idempotent.
