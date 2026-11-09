# 0080. Rate limiting and abuse controls

- Status: Accepted
- Date: 2026-11-09
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP P6-05d (ADR 0079, finding S1); P6-05d task plan approved 2026-11-09 11:33Z with owner conditions C1–C8; ADR 0023 (dependency policy), 0039 (config), 0051 (Nest skeleton), 0057 (error model), 0062 (authentication), 0065 (immediate revocation), 0071 (global directory), 0078 (scale target)

## Context

ADR 0079 found the API had no rate limit (S1): any client could send an unbounded number of requests, of bad tokens, of device registrations or of directory lookups. The deployed topology (STACK: CloudFront and WAF, then an ALB, then ECS) also meant `request.ip` was the load balancer's address, because Fastify trusted no proxy, so a per-address limit would have put every client in one bucket.

## Decision

### Package and store

`@nestjs/throttler` 6.7.1, exact pin in `apps/api` (published 2026-09-24, MIT, no dependencies, no install scripts; peers `@nestjs/common` and `@nestjs/core` `^7 … ^12`, `reflect-metadata`). Its guard resolves the named throttlers (`ip`, `user`, `org`), their limits and windows per route; the store is in-repo (`apps/api/src/common/rate-limit/store.ts`), no storage package:

- `ValkeyRateLimitStore` runs one Lua script per hit: `INCR`, then `PEXPIRE` with the window whenever the key has no expiry (`PTTL` -1), on any hit and not only the first, so a key that lost its expiry gets it back (owner condition C4). A fixed window per key.
- It runs on the API's one Valkey client (`common/valkey.ts`), which the revocation store (ADR 0065) now shares (C5). The client keeps the options the revocation store had: lazy connect, no offline queue, no retries per request, 500 ms to connect and per command. Sharing changes neither revocation's 500 ms bound nor its fail-closed 503 (`rate-limit.int.test.ts` proves both with limiter commands in flight). `createApp` opens the client; `AppModule` closes it on shutdown; a revocation store built from a URL (tests) still opens and closes its own.

### Guard order

Global guards: `RateLimitIpGuard` → `AuthGuard` → `RateLimitPrincipalGuard` → `CanGuard`. The IP stage runs before any token work (a flood of bad tokens is counted before verification: the 429 comes before the 401); the user and org stage runs after the identity is known and before the authorization guard reads grants. `RateLimitModule` is imported before `AuthModule`; `AuthModule` registers the principal guard between its two guards. A test pins the order.

### Classes and limits (C1)

Five classes: `default`, `auth_adjacent`, `invitation`, `upload`, `export`. Each has an ip, a user and an org limit per window. The defaults are a frozen table in `@bricx/config/rate-limits` (no limit literal in `apps/api`); `RATE_LIMIT_<CLASS>` overrides one class with `ip=N,user=N,org=N,window=S` (every field once, limits 1–1,000,000, window 1–86,400 s; anything else is a `ConfigError` naming the key).

| class | window | ip | user | org |
|---|---|---|---|---|
| default | 60 s | 6000 | 600 | 30000 |
| auth_adjacent | 600 s | 30 | 20 | 600 |
| invitation | 3600 s | 60 | 50 | 200 |
| upload | 60 s | 120 | 60 | 1200 |
| export | 3600 s | 30 | 10 | 100 |

C1: the class's ip limit applies only to `@Public` routes. Every other route is counted once at the IP stage against the default class's ip limit, 6000 per 60 s, so a site of 200 workers behind one NAT is never throttled by its address; their user and org limits do the work. `auth_adjacent` org is 600 per 600 s because device registration at shift start is a burst. Tests: 200 authenticated users behind one address are not throttled; 200 `POST /v1/devices` across one organisation in one window are all registered; a `@Public` route is limited by its class's ip limit.

Routes are classed with `@RateLimit(cls)`; unmarked routes are `default`. `createApp` refuses a route naming an unknown class (`assertRateLimitClasses`, like `assertEveryRouteMarked`). Today:

- `auth_adjacent`: `POST /v1/organizations`, `GET /v1/directory/resolve`, `POST /v1/devices`, `POST /v1/users/{userId}/sessions/revoke`, `DELETE /v1/sessions/{id}`, `POST /v1/access-grants`;
- `invitation`: `POST /v1/members`, `POST /v1/projects/{projectId}/members`;
- `upload`, `export`: no route yet (P8-06, P9 and later opt in);
- exempt (`@RateLimitExempt()`): `GET /health/live`, `GET /health/ready`. Load-balancer probes come from a few addresses at a fixed rate, and a 429 would mark healthy tasks unhealthy. The edge does not route `/health/*` publicly (runbook; P13-01).

### Keys

`rl:v1:<class>:<dim>:<id>`. The id is a user or org UUID, or the first 32 hex characters of SHA-256 of the client address (IPv6 by its /64). Never a token, a sid, an e-mail or an address. Every key carries the window as its TTL (C3; tested: every `rl:v1:*` key the app writes has `PTTL` > 0).

Sizing (ADR 0078: about 1,000,000 accounts and 50,000 peak concurrent users per cell): about 50k user keys, up to 50k org keys and up to 50k address keys per window, times about 1.2 for classes, is about 180k keys, about 22 MB per cell at about 120 bytes per key. An address flood of 1,000,000 addresses in one window adds about 120 MB; the WAF is the first line against that.

### The trusted proxy

`TRUST_PROXY`: unset or `off` (the socket peer is the client), `hops:N` (1–3) or a list of CIDRs. `true` and a `/0` are refused; production refuses it unset or `off`. `createApp` passes it to Fastify, so `X-Forwarded-For` is read only for the hops or networks it names; a spoofed header from an untrusted peer changes nothing (tested). Deployed: `hops:2` (CloudFront, then the ALB, each append the address they saw). This assumes the ALB admits only CloudFront (its security group allows only the CloudFront origin-facing prefix list); if the API is ever reached without CloudFront, the value must change (runbook). With a trusted proxy, `request.ip`, and with it the request log's `remoteAddress`, the request context's ip and the audit log's ip, become the client's address instead of the load balancer's.

### Over a limit

429 `rate_limited`, the existing code (ADR 0057; `errors:rate_limited` already in en, fr and ar; C8), as problem+json in the standard envelope (status, code, key, traceId), with `Retry-After` in whole seconds, at least 1. Nothing about buckets, classes, limits, addresses or another tenant. The `X-RateLimit-*` headers are off. One info line `rate_limit.exceeded` {class, dim}. The OpenAPI document lists a 429 response with `Retry-After` on every operation that is not exempt; the api-client is regenerated.

### Valkey down

Per class, with a per-route override (C2):

- `default`: falls back to an in-process store (an LRU of at most 10,000 keys per process) at the same limits (fail open, bounded).
- `auth_adjacent`, `invitation`, `upload`, `export`: fail closed, 503 `server_unavailable` (the existing code, C8) with `Retry-After: 5`.
- `GET /v1/directory/resolve` is marked `storeDown: "fallback"` (C2): sign-in routing keeps working during an outage, limited in-process at the `auth_adjacent` limits.

The mode belongs to the bucket's class: the IP stage of an authenticated route counts in the default class and falls back; that route's own class decides at the user and org stage. Authenticated routes answer 503 anyway while Valkey is down, because revocation fails closed (ADR 0065). One warn line `rate_limit.store_unavailable` {class, mode} per class and mode at most every 10 s per process, with no address, id or key; P13-05 alarms on it.

### Valkey memory (C3)

One Valkey instance, `noeviction` (compose, P13-01). Logical databases share one `maxmemory`, so a separate database is no protection. The risk: a key flood could fill memory, and then writes fail, including the worker's revocation writes. Mitigations: every rate-limit key carries a TTL (tested), the WAF rate rule in front (P13-01) and an ElastiCache memory alarm at 70% (P13-01). A separate instance is revisited only if the P14 load tests show pressure.

### Logging

No token, sid, sub, e-mail, key or forwarded header in any log line; the rate-limit lines carry no address and no id. `req.headers["x-forwarded-for"]` is added to the redaction paths (Fastify's request serializer does not log headers today).

## Residuals (C6, accepted, not built)

- Unrouted paths (404s) pass no Nest guard, so they are not limited here; the WAF rate rule handles them (P13-01).
- A fixed window allows up to twice a limit across a window boundary; a sliding window costs more per request.
- The address hash is unsalted, so an IPv4 key can be reversed by brute force; keys live at most one window, and no new secret key is added for it.
- The default numbers are estimates until the P14 load tests; they are config, not code.

## Consequences

- New config keys `TRUST_PROXY` (required in production) and `RATE_LIMIT_DEFAULT`, `RATE_LIMIT_AUTH_ADJACENT`, `RATE_LIMIT_INVITATION`, `RATE_LIMIT_UPLOAD`, `RATE_LIMIT_EXPORT`; `.env.example` documents them.
- `ApiError` may carry `Retry-After`, which the problem filter sends as a header.
- `createApp` has a test-only `rateLimitStore` option (the in-process store, or one that is always down); suites without Valkey that reach a fail-closed route pass the in-process store, keeping the real limits.
- New routes choose a class when they are added: P6-06 (invitations: `invitation`; the public accept route also its class's ip limit), P8-06 (presign and upload: `upload`), P9 and any CSV or PDF export (`export`), P7-05 if the API gains authentication endpoints.
- P13-01: a WAF rate rule (also covering unrouted paths), the ALB admitting only CloudFront for `hops:2`, `/health/*` not routed publicly, and an ElastiCache memory alarm at 70%. P13-05: an alarm on `rate_limit.store_unavailable`.
