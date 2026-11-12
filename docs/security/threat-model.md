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
| Member lifecycle (E, S, I) | A suspended or expired member keeps access through a reader, a session, a site policy or a stream source; self-reactivation or self-renewal; a temporary or external owner; an external member reaching other projects or org-wide data; personal data in the activity history | One active predicate in the grants source, SoD, access grants, `sites_assigned_select` and the stream-source views, with a readers registry test and a database leak test; sessions closed in the suspending transaction and never restored; self guard with denial events, `holdsAll`, last active owner; guard triggers for every role; `EXTERNAL_ORG_KEYS` allowlist with completeness and subset tests, no org-scope elevation; activity with a fixed projection inside the org filter, reasons never logged (ADR 0084) | PowerSync leak test for suspended and expired members (P8-02); expiry notice delivery (P12-01) | P8-02, P12-01 |
| Public edge (D, I) | Abuse, scraping, header weaknesses | Helmet; CORS allowlist; 1 MiB body cap | Rate limiting (S1); CSP and HSTS for the PWA (S4) | P6-05d, P7-01, P13-01 |

## Extension points (ADR 0083; planned controls, to be confirmed with test evidence by the owner task)

| Surface | Threat | Planned control (ADR 0083) | Owner task |
|---|---|---|---|
| Custom fields (T, I, E) | Custom-field injection: HTML or script in labels and values, CSV or PDF formula text in exports, SQL or JSON-path metacharacters, oversized bodies; a value steering a permission, RLS, stream or money decision | Definitions with closed data types; validation and bounds before parsing; text-only rendering; export formula guard (ADR 0079 S5); parameters only; Semgrep rule keeps `custom_fields` out of RLS, permissions, SoD, stream scopes and money code and off append-only ledger and audit tables | P26-01 (shape at P8-01) |
| Entity links (I, E) | Cross-tenant links: a link whose ends are in two organisations or projects; a dangling link; a link revealing an entity the reader may not read; enumeration of ids through "what links here" | Allowlisted type registry as a SQL CHECK; same-organisation trigger at both ends; FORCE RLS; stream scope and leak test; placeholder with type and id only; update on the from entity and read on the target | P8-01, P8-02, P12-05 |
| Workflow configuration (E, T, R) | Configuration that weakens SoD (no approver, self-approval, delay-based approval); an author activating their own policy; editing an active policy; changing the rules of an approval in flight | SoD floor in code (`checkSod`); validator refuses weakening policies; author != activator with MFA step-up (`org.workflow_config.activate` in `MFA_ADMIN_PERMISSIONS`); append-only versions; in-flight work pinned to its version; audit event per change | P26-01, P26-02, P9 approvals |
| Outbound webhooks (I, T, D, S) | Webhook abuse: SSRF to internal, link-local or cloud-metadata addresses, DNS rebinding, redirects, slow or huge responses; forged or replayed deliveries; a leaked signing secret; a subscription delivering data its creator could not read; retry storms | Outbox-only delivery; HMAC-SHA256 over timestamp, delivery id and body; secret shown once and stored encrypted, rotation with two secrets; resolve once, pin the IP and re-check at connect; blocked ranges for IPv4 and IPv6; no redirects; timeout and response-size cap; payload limited to the subscription's scope; backoff, dead letter and auto-disable; delivery log and alerts | P26-04 |
| AI gateway (I, E, T) | AI prompt leakage: sensitive or cross-tenant data sent to a provider, kept in prompts, outputs, caches or embeddings, or written to the audit chain; retrieval beyond the user's permissions | Server-side gateway only; fail-closed redaction before any call; retrieval as the requesting user through CASL and `withTx()`; per-organisation stores and caches under FORCE RLS; configurable retention; metadata-only audit; no training on client data; off by default | P23 |
| AI gateway (T, E) | Prompt injection: instructions hidden in documents, OCR text, file names, custom fields or messages make the model reveal data or attempt an action; model output carrying HTML, script or a crafted value | Untrusted text passed as delimited data; no write tools; a person commits every consequential action and AI is never requester or approver; output schema-validated, rendered as text and never as HTML, never used as a query, path or permission input | P23 |

## Planned areas (fill in when the module is built)

Uploads and file pipeline (P8-06), sync upload and conflict engine (P8-03), money and ledger (P9), payments and webhooks (P17), notifications (P12), exports and reports, client portals (P20), offline data on devices (P8-04).
