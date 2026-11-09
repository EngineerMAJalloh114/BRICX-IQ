# Security policy

BRICX IQ handles financial and site data for construction organisations. We take security reports seriously.

## Reporting a vulnerability

Do not open a public issue for a security problem.

- Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"), once the owner has enabled it (ADR 0079, S13).
- Security contact: TODO (owner to add a monitored address before the public launch).

Include what you found, how to reproduce it, and the affected version or commit. Do not include real customer data.

## What to expect

Target times, to be confirmed by the owner before launch: acknowledgement within 3 working days, an assessment within 10 working days, and a fix or mitigation plan communicated after that. We credit reporters who want credit.

## Scope

In scope: the API, worker, client apps, sync service configuration, infrastructure code and the Keycloak realm in this repository.
Out of scope: social engineering, physical attacks, denial of service by volume against shared infrastructure, and third-party services we only integrate with.

## Rules for researchers

Test only against your own accounts and organisations. Do not access, change or delete other people's data. Stop and report as soon as you reach real data.

## How security is run here

The programme, its findings and its open items are in `docs/adr/0079-security-enhancement-programme.md`. The threat model is `docs/security/threat-model.md` and the control tracker is `docs/security/asvs-l2.md`.
