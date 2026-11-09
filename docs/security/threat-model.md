# Threat model (STRIDE) — living document

Status: first pass from a read-only review of `main` at `f3c940a` (ADR 0079). Each row is a claim to be confirmed with test evidence by the task that owns it. "Planned" means a roadmap task, not an existing control. Update this file in the same PR as any change to a trust boundary, a module's authorization or a data flow.

STRIDE: **S**poofing, **T**ampering, **R**epudiation, **I**nformation disclosure, **D**enial of service, **E**levation of privilege.

## Trust boundaries

1. Client (device, browser) to API: untrusted input; bearer token.
2. API to Postgres: `bricx_app` role under FORCE RLS; `withTx()` sets `app.org_id`, `app.user_id`, `app.project_ids`.
3. Postgres to PowerSync (logical replication): bypasses RLS; scoped by sync streams (P8-02).
4. API and worker to Keycloak (admin client); worker service account.
5. API and worker to Valkey (revocation, queues, rate limits).
6. Worker to adapters (payments, SMS, e-mail, FX) and webhooks in.
7. Cell to global directory.
8. CI and supply chain to production.

## Existing modules

| Module / boundary | Threat | Existing control | Gap or planned control | Owner task |
|---|---|---|---|---|
| Token validation (S) | Forged or replayed bearer token | RS256 only, issuer, audience, `exp` (ADR 0061); 5 min access token; revocation by sid and user (ADR 0065) | Per-IP and per-user throttling (S1) | P6-05d |
| Sign-in (S, D) | Credential stuffing, weak passwords | Keycloak brute-force lockout; TOTP and WebAuthn policy | Password policy and breached-list check; MFA for owners and admins (S2) | P6-05e |
| Sessions and devices (S, E) | Stolen device keeps access | Device and session rows, idle limit, immediate revocation | Remote wipe of local data on revoke (S7); new-device alerts (S11) | P8-04, P12-01 |
| Authorization guard (E) | Acting beyond granted scope | CASL from `@bricx/permissions`; grants, project overrides, elevations expire; `@Can` | Per-key MFA flag beyond `finance.*` (planned in P13-01 line from P6-02) | P6-05e, P13-01 |
| Segregation of duties (E, R) | Requester approves own request | Server-side SoD; no override in a single-member org (ADR 0068, D2) | Detection of repeated failed approvals (S11) | P12-01 |
| Tenancy (I, E) | Cross-tenant read or write | FORCE RLS; `withTx()` only; leak tests; raw pool not importable | Sync stream leak tests (P8-02) | P8-02 |
| Audit (T, R) | Altered or deleted history | Hash chain; append-only triggers; `audit:verify` | Tail truncation detectable only after the P13 anchor (S3) | P13 |
| Outbox and worker (T, D) | Lost or duplicated side effects | Same-transaction outbox; idempotent `jobId` | Worker runs as `bricx_app` until P13-01 (accepted risk, ADR 0067) | P13-01 |
| Organisations and directory (I, E) | Org archive, directory tampering | Archive restricted to `bricx_owner`; separate `bricx_directory` DB and roles (ADR 0071, 0072) | MFA on `org.organization.archive` (planned, P13-01 line from P6-02) | P13-01 |
| Region config and adapters (T, E) | Null adapter in production; config tampering | Null adapters refused in production; registry frozen; idle limits bounded (ADR 0073, 0074) | None known | — |
| Projects and sites (I, T) | Contract value disclosure; boundary tampering | Contract value gated by `project.project.update`; CHECK constraints; membership per site (ADR 0075) | None known | — |
| Public edge (D, I) | Abuse, scraping, header weaknesses | Helmet; CORS allowlist; 1 MiB body cap | Rate limiting (S1); CSP and HSTS for the PWA (S4) | P6-05d, P7-01, P13-01 |

## Planned areas (fill in when the module is built)

Uploads and file pipeline (P8-06), sync upload and conflict engine (P8-03), money and ledger (P9), payments and webhooks (P17), notifications (P12), exports and reports, client portals (P20), offline data on devices (P8-04).
