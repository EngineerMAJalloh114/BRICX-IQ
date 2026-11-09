# OWASP ASVS Level 2 — control tracker

Status: created by ADR 0079 (2026-11-09). The ASVS version (4.0.3 or 5.0) is pinned in the first review (P14-01 or earlier) and this file is re-laid-out then if needed. Chapter level for now; per-requirement rows are added as each owning task closes. A requirement is "Met" only with a link to test evidence.

Statuses: Unassessed, Partial, Met (evidence linked), Planned (task named), N/A (reason).

| Chapter (4.0.3 names) | Status | Existing evidence | Owning tasks |
|---|---|---|---|
| V1 Architecture, design and threat modelling | Partial | ADRs; `threat-model.md` | P6-05c, each phase exit |
| V2 Authentication | Partial | Keycloak brute force, TOTP, WebAuthn policy; `acr` step-up | P6-05e, P7-05 |
| V3 Session management | Partial | Sessions, idle limit, immediate revocation (ADR 0063, 0065) | P7-05, P8-04 |
| V4 Access control | Partial | CASL, grants, SoD, RLS (ADR 0054, 0066, 0068) | P8-02, each module |
| V5 Validation, sanitization and encoding | Partial | Zod schemas (ADR 0047); problem+json | P8-06 (uploads), exports |
| V6 Stored cryptography | Planned | RDS KMS (P13) | P10-04, P16-01, P13-01 |
| V7 Error handling and logging | Partial | Log redaction, request id, audit chain | P12-01, P13-05 |
| V8 Data protection | Planned | None yet on devices | P8-01, P8-04, P14-05 |
| V9 Communications | Partial | `sslRequired: external`; TLS at the edge (P13) | P13-01 |
| V10 Malicious code | Partial | gitleaks, Semgrep, `audit:prod`, SHA-pinned actions | P13-02 |
| V11 Business logic | Partial | Idempotency, SoD, status machines | P9-05, each module |
| V12 Files and resources | Planned | ClamAV planned | P8-06 |
| V13 API and web service | Partial | OpenAPI-generated client; body cap | P6-05d (rate limits) |
| V14 Configuration | Partial | Config loading (ADR 0039); migrations immutable; rulesets | P13, owner S13 |
