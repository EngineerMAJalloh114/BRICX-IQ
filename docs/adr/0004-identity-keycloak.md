# 0004. Identity: Keycloak (self-hosted)

- Status: Accepted
- Date: 2026-09-30
- Deciders: Mohamed Abass Jalloh
- Source: docs/STACK.md v2, corrections log row C4

## Context

Stack v1 left identity open: Keycloak **or** Auth0/Cognito. The platform needs OIDC with PKCE, MFA, passkeys, and full session and device revocation, at a cost that works at emerging-market scale, under owner control.

## Decision

Use **Keycloak** (self-hosted), one per region cell: OIDC, PKCE, MFA/TOTP and passkeys/WebAuthn.

## Consequences

Positive:
- Owner control of identity data (spec 2.9).
- No per-user SaaS cost at emerging-market scale.
- Full session and device revocation.

Negative:
- We run, patch, back up and monitor Keycloak in every region cell; an identity outage is ours to fix. (proposed — needs review)
- Realm configuration must be versioned and imported per cell (`infrastructure/keycloak`), adding release steps. (proposed — needs review)
- Keycloak upgrades are a recurring operational task with their own migration risk. (proposed — needs review)

## Alternatives rejected

- **Auth0**: per-user SaaS cost; less owner control.
- **Amazon Cognito**: per-user SaaS cost; less owner control.
