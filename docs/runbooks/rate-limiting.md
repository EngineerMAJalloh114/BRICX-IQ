# Runbook: rate limiting

The API limits requests per client address, per user and per organisation (P6-05d, ADR 0080). Limits live in Valkey under `rl:v1:*` keys, on the same client and instance as the revocation keys.

## Classes and limits

Five classes; each has an ip, a user and an org limit per window. The defaults (estimates until the P14 load tests):

| class | window | ip | user | org | store down |
|---|---|---|---|---|---|
| default | 60 s | 6000 | 600 | 30000 | in-process fallback |
| auth_adjacent | 600 s | 30 | 20 | 600 | 503 (directory resolve: in-process fallback) |
| invitation | 3600 s | 60 | 50 | 200 | 503 |
| upload | 60 s | 120 | 60 | 1200 | 503 |
| export | 3600 s | 30 | 10 | 100 | 503 |

- A `@Public` route is counted against its class's ip limit. Every other route is counted once against the default class's ip limit (6000 per 60 s), so a site behind one NAT is limited per user and per organisation, not by its address.
- `GET /health/live` and `GET /health/ready` are never limited.
- Over a limit: 429 `rate_limited` with `Retry-After` (seconds). Store down on a fail-closed class: 503 `server_unavailable` with `Retry-After: 5`.

## Changing a limit

Set one key per class, every field once:

```
RATE_LIMIT_AUTH_ADJACENT=ip=30,user=20,org=600,window=600
```

Keys: `RATE_LIMIT_DEFAULT`, `RATE_LIMIT_AUTH_ADJACENT`, `RATE_LIMIT_INVITATION`, `RATE_LIMIT_UPLOAD`, `RATE_LIMIT_EXPORT`. Limits 1–1,000,000, window 1–86,400 s. A bad value stops the API at boot with a `ConfigError` naming the key. The change applies at the next deploy; a lowered limit counts against the current window's hits.

To see a caller's count (an operator with Valkey access):

```
SCAN 0 MATCH rl:v1:auth_adjacent:org:* COUNT 1000
GET rl:v1:auth_adjacent:org:<orgId>
PTTL rl:v1:auth_adjacent:org:<orgId>
```

To release a caller before the window ends, `DEL` the key. Address keys are a hash (`rl:v1:<class>:ip:<32 hex>`), not the address.

## TRUST_PROXY per topology

`TRUST_PROXY` says whose `X-Forwarded-For` the API believes. Production refuses it unset or `off`.

| topology | value |
|---|---|
| local dev, tests, a client talking to the API directly | `off` |
| CloudFront, then the ALB, then ECS (deployed) | `hops:2` |
| an ALB only, no CloudFront | `hops:1` |
| proxies on known private networks | their CIDRs, e.g. `10.0.0.0/16,10.1.0.0/16` |

`hops:2` assumes the ALB admits only CloudFront: its security group allows only the CloudFront origin-facing managed prefix list (P13-01). If anything else can reach the ALB, a client can choose its own address by sending `X-Forwarded-For`; then switch to the CIDR form or close the ALB. `true` and `/0` are refused.

With a trusted proxy, the request log's `remoteAddress`, the request context's ip and the audit log's ip are the client's address.

## Valkey down

- Signal: the warn line `rate_limit.store_unavailable` with `class` and `mode` (`fail_open` or `fail_closed`), at most once per class and mode every 10 s per process. P13-05 alarms on it. The revocation store's `auth.revocation_unavailable` usually fires at the same time.
- Effect: default routes keep working on an in-process limiter (at most 10,000 keys per process, the same limits per process, so N tasks allow up to N times a limit); the directory resolve route likewise; the other auth-adjacent, invitation, upload and export routes answer 503. Authenticated routes answer 503 anyway, because revocation fails closed (ADR 0065).
- Recovery is automatic when Valkey answers again; counting moves back to Valkey on the next request.

## Valkey memory

Valkey runs `noeviction`, one instance for revocation, the outbox queues and rate limits. Every `rl:v1:*` key has a TTL (at most one window), so the keys drain by themselves after a flood. If memory fills, writes fail, including the worker's revocation writes: watch the ElastiCache memory alarm (70%, P13-01) and the WAF rate rule in front. Check for keys without a TTL (there should be none):

```
SCAN 0 MATCH rl:v1:* COUNT 1000   # then PTTL each: -1 means no expiry
```

The next hit on such a key gives it the window again.

## The health probes at the edge

`/health/*` is exempt from rate limiting, so it must not be reachable from the public internet: the public CloudFront behaviours do not route `/health/*`; the ALB target group's health checks reach the tasks directly (P13-01).

## Residuals

Unrouted paths (404s) are not limited by the API (the WAF rate rule covers them); a fixed window allows up to twice a limit across a boundary; the address hash is unsalted. See ADR 0080.
