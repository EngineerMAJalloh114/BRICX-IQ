# 0079. Security enhancement programme

- Status: Accepted
- Date: 2026-11-09
- Deciders: Mohamed Abass Jalloh
- Source: owner directive 2026-11-09 (audit, enhance, complete and extend the existing security architecture; not a rebuild); architect read-only audit of `main` at `f3c940a` (P6-05) by static inspection of code, ADRs, CI and the Keycloak realm. No tests were run for the audit and GitHub repository settings were not visible to it.

## Context

BRICX IQ already has a security foundation. The directive is to preserve what works, enhance what is weak, finish what is partial and add what is missing, with every existing approval gate kept and nothing marked complete without test evidence, failure cases included. This ADR records what exists, what changes, what is new and what is outstanding, and maps each item to the roadmap.

## Decision

### Rules for the programme

1. Enhance, do not rebuild. A working control is kept; replacing one needs a documented technical justification.
2. No second authentication, authorization, logging or permission system. Every new control extends the existing one (`@bricx/permissions`, `withTx()`, the audit chain, the outbox, the problem+json error model).
3. No existing policy is weakened. No approval gate is skipped.
4. A security item is complete only with test evidence, including its failure scenarios.
5. The audit below was static. Each task re-verifies its own item against the code before changing anything and corrects this ADR if the audit was wrong.
6. Security is a standing gate: every phase exit checks the ASVS tracker (`docs/security/asvs-l2.md`) and the threat-model entries (`docs/security/threat-model.md`) for that phase.

### Existing and adequate (preserved)

| Control | Evidence |
|---|---|
| Bearer-token verification: RS256 only, issuer, audience `bricx-api`, `exp` required | ADR 0061, `common/auth/token-verifier.ts` |
| Keycloak: brute-force protection (5 failures, 60 s increments, 900 s cap), TOTP, WebAuthn policy, `bricx-mfa` role and `acr` step-up, access token 300 s, SSO idle 12 h and max 7 d, `sslRequired: external` | ADR 0060, `realm-bricx.json` |
| Devices, sessions, idle limit, immediate revocation (Valkey keys) | ADR 0063, 0065 |
| Authorization: CASL catalogue, grants, roles, project overrides, temporary elevation, server-side SoD | ADR 0048, 0066, 0067, 0068 |
| Tenancy: FORCE RLS on tenant tables, `withTx()`, append-only tables by `REVOKE UPDATE` and triggers | ADR 0053, 0054 |
| Hash-chained audit with `audit:verify` | ADR 0017, 0055 |
| Supply chain and process: SHA-pinned actions, gitleaks (staged and history), Semgrep, `audit:prod`, migrations-immutable check, Dependabot cooldown, 7-day dependency rule, CODEOWNERS, rulesets | ADR 0023, 0030, 0031, 0033, 0043, 0044 |
| API baseline: Helmet, CORS allowlist (wildcard refused in production), 1 MiB body cap, log redaction, request id, idempotency, problem+json | ADR 0051, 0057, 0062 |

### Findings and decisions

| ID | Class | Finding | Decision | Lands in |
|---|---|---|---|---|
| S1 | Incomplete | `@nestjs/throttler` is listed for P5 in DEPENDENCIES.md, but no code uses it; no `trustProxy` setting was found. | Rate limiting and abuse controls on the existing API: Valkey-backed store, correct client IP behind the ALB, buckets per IP, user and organisation, stricter limits on auth-adjacent, invitation, upload and export routes, 429 as problem+json with `Retry-After`. | **P6-05d** (before P6-06) |
| S2 | Incomplete | The realm has no `passwordPolicy`; `adminEventsEnabled` is false; MFA is required only for users with finance permissions. | Password policy (length, history, not username or e-mail, blacklist), admin events on, MFA extended to organisation owners and administrators. Because the realm is imported with `IGNORE_EXISTING`, the task states how a running realm receives the change. | **P6-05e** (before P6-06) |
| S3 | Incomplete | Tail truncation of the audit chain is undetectable until the P13 anchor (ADR 0055). | Keep the P13 anchor. Add a scheduled `audit:verify` run with an alert on a break, as soon as the worker has a scheduler. | P13-05, P13 anchor |
| S4 | Incomplete | Web security headers are Helmet defaults. | CSP, HSTS and Permissions-Policy for the PWA through the CloudFront response-headers policy; the API keeps Helmet. | P7-01, P13-01 |
| S5 | Incomplete | The P8-06 pipeline names ClamAV and thumbnails only. | Add a content-type and size allowlist, content sniffing, EXIF GPS stripping for non-evidence copies, a quarantine bucket, and CSV and PDF formula-injection guards for exports. | P8-06 |
| S6 | Incomplete | ASVS and ZAP appear only at P14-01. | A living ASVS L2 tracker from now; ZAP baseline nightly against staging from the first deploy. | This task, P13-03, P14-01 |
| S7 | Missing | No on-device encryption of the offline SQLite database and no remote wipe when a device is revoked. Whether PowerSync supports an encrypted SQLite database on React Native and web is **not verified** and needs an ADR before P8-01. | Encrypt the local database; wipe it on revocation at the next contact; state a limit for the data held on a device. | P8-01, P8-04 |
| S8 | Missing | No mobile hardening plan. | Tokens in secure storage; optional biometric app lock; jailbreak and root signal reported with the session; screenshot block on finance screens; a certificate-pinning decision recorded in an ADR. | P7-05, P8-04 |
| S9 | Missing | Only P16 plans a KMS-envelope field-encryption helper. | One shared field-level encryption helper, used first by worker identity numbers (P10-04) and then by supplier bank details (P16-01). No per-module copies. | P10-04, P16-01 |
| S10 | Missing | No threat model, `SECURITY.md` or disclosure policy. | Added by this task: `SECURITY.md`, `docs/security/threat-model.md` (STRIDE per module and per trust boundary), `docs/security/asvs-l2.md`. | This task |
| S11 | Missing | No detection of abnormal behaviour. | Security events (impossible travel, repeated failed approvals, mass export, new-device sign-in) as outbox events with notifications; audit-log export to a SIEM. | P12-01, P13-05 |
| S12 | Missing | Enterprise capabilities expected of a product at Procore's level. | SSO (SAML and OIDC through Keycloak), SCIM, per-organisation IP allowlist, data retention and legal hold, export controls (permission, MFA, audit), and a SOC 2 Type I readiness track. | P20, P24 |
| S13 | Unverified | GitHub settings were not visible: secret scanning, push protection, private vulnerability reporting, 2FA enforcement, signed commits. | The owner checks and records them in `docs/runbooks/github-settings.md`. | Owner action |

### Order change

P6-05d (rate limiting) and P6-05e (realm hardening) run before P6-06. Members and invitations create accounts and send messages: an unthrottled invitation route and a weak password policy would ship with it.

### Outstanding

S3 until the P13 anchor exists; S7 until the encrypted-SQLite ADR; S13 until the owner reports the settings. Everything else is assigned to a task above.

## Consequences

- ROADMAP gains P6-05c to P6-05e and "Also" lines in the tasks named above. STACK.md gains a short Security architecture section that points here; no existing decision changes.
- Each new security task is 🔒, so it needs its own plan approval and architect review of the PR before merge.
- The programme adds no dependency by itself. A task that needs a package follows ADR 0023 and the 7-day rule.
