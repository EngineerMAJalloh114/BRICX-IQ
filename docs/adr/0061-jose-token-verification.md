# 0061. `jose` 6.2.12 for bearer-token verification

- Status: Accepted
- Date: 2026-10-21
- Deciders: Mohamed Abass Jalloh
- Source: P5-02 (task plan approved 2026-10-21 with conditions 1–8; plan item f); the P5 phase plan (`jose` named for P5-02); ADR 0023 (dependency policy: exact pins, a seven-day release age, no install scripts); ADR 0060 (the `bricx` realm: issuer, audience `bricx-api`, RS256 realm keys); DEPENDENCIES.md (`jose` listed for P5)

## Context

P5-02 verifies the access tokens Keycloak issues for `bricx-api`: the signature against the realm's published keys (JWKS), the issuer, the audience, the expiry and the algorithm. DEPENDENCIES.md already names `jose` for this (and for PowerSync token signing later). Verification code is security-critical and easy to get subtly wrong (algorithm confusion, `alg: none`, key selection, clock handling), so it comes from a maintained library, not from hand-written crypto.

## Decision

- `jose` **6.2.12**, an exact pin in `apps/api` only. Published 2026-09-05T09:17:12Z (older than the seven-day rule; installed with `--config.minimumReleaseAge=10080`), MIT, no dependencies, no install scripts, integrity `sha512-9NiFmJEex0sy2Dk58j2UGBSHgUs2ypF9eZSu4L6vjOX3Dp96Sw1F3uL+H+D1sx02jZZdzUT0HgvCy59CuvXcWw==`. 6.2.13 (2026-10-20) is inside the seven-day window and is not taken; a later bump goes through Dependabot's cooldown (ADR 0044).
- Used through `jwtVerify()` with an explicit `algorithms` allow-list, `issuer`, `audience`, `typ`, `currentDate` (the injected `Clock`) and `clockTolerance`, and `createRemoteJWKSet()` with an explicit fetch timeout and refetch cooldown. ADR 0062 records the rules; this ADR records the package.
- Nothing else is added: Node's WebCrypto does the cryptography, `fetch` the JWKS request.

## Consequences

- Positive: one small, dependency-free, widely reviewed implementation of JWS/JWT/JWKS on Node's own WebCrypto; the same package later signs PowerSync tokens (P8), so no second JWT library is ever needed.
- Positive: algorithm confusion and `alg: none` are refused by the allow-list, which tests in `apps/api` pin.
- Negative: `jose` is ESM-only, which the API already is.
- Negative: JWKS caching is the library's (`createRemoteJWKSet`); its behaviour (one fetch per cooldown for an unknown `kid`) is pinned by tests rather than owned in code.

## Alternatives rejected

- `jsonwebtoken` + `jwks-rsa`: two packages, CommonJS, more transitive dependencies, and `jsonwebtoken` verifies with whatever algorithm the token names unless every call passes a list.
- `@nestjs/passport` with `passport-jwt`: adds Passport's strategy layer and its dependencies for one guard; the guard stays a plain Nest guard.
- Keycloak token introspection on every request: a network round trip per request and a hard dependency on Keycloak being up; local verification with cached keys is the standard for short-lived (5 min) access tokens. Revocation is P5-04's job.
