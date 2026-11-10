# ADR 0082: Capability alignment and release placement

Status: Accepted (founder decisions, 2026-11-09)
Task: P6-05f (docs only)

## Context

The enterprise directive of 2026-11-09 asked for an audit of 13 capability areas (AI, site intelligence, finance, procurement and inventory, workforce and equipment, offline, documents, collaboration, integrations and APIs, configurable workflows, internationalisation, executive reporting, advanced technology) and of the engineering foundation. The assessment compared the directive with `main` at `f3c7d58` (P0 to P6-05d merged). It is a static review of the roadmap, STACK, the product concept, the decision register and the merged code and tests. The client, sync, ledger and all field, commercial and Release 2 and 3 modules do not exist yet, so most areas are planned, not implemented.

## Decision

The founder approved the proposed capability map in full, without striking any item, on the conditions below. No existing task is renumbered, removed or ticked.

### New roadmap items

| Item | Release | Notes |
|---|---|---|
| P6-07 Capability alignment and extensibility ADR | Foundation | Docs only. The owner accepts it before P8-01 starts. |
| P12-05 Project messaging and task discussions | MVP | Lightweight comment threads on linked entities. Not a chat platform. |
| P25 Plant and equipment (P25-01 to P25-04) | R2 | TrackerAdapter (P25-04) replaces the unscheduled item. GPS provider stays pending. |
| P26 Platform extensibility and open integrations (P26-01 to P26-06) | R2 | Public API, webhooks, custom fields, M365 and Google adapters, e-signature contract. |
| P27 Document management (P27-01 to P27-05) | R2 | Register, versions and approvals, drawing revisions, closeout. |
| P15-06, P16-06, P18-04, P19-05, P20-05 | R2 | Receivables, supplier invoices and performance, minutes and actions, skills and certifications, executive dashboards. |
| P22-05, P23-05 to P23-08 | R3 | Digital twin foundations, prediction, assistant, extraction, computer vision. |

Items marked as release 2 or 3 are not moved earlier. Their architectural foundations, interfaces and security controls are laid at the earlier stages named in the Also lines (P6-07, P8-01, P8-06, P10-03, P11-03, P13-01 and others).

### Founder conditions, as recorded in the roadmap

1. P6-07: entity links use an allowlisted entity-type registry with tenant validation and integrity checks; custom fields never feed RLS or financial calculations; workflow configuration is versioned, permission-controlled, audited and cannot weaken SoD; original measurement values and units are kept beside normalised SI values where accuracy or traceability needs it; AI processing has sensitive-data redaction, configurable retention, tenant isolation and access controls; integration adapters support signed webhooks, retries, outbox-based delivery and monitoring.
2. P25: equipment location data has access, privacy and retention controls. P26: public APIs enforce scoped credentials, authentication, rate limits, tenant isolation, revocation and audit logging. P27: e-signature stays subject to legal review.
3. P12-05 stays lightweight.
4. Additions to existing tasks: accessibility from the first component; video size, duration and offline-storage limits; historical tax rates preserved with jurisdiction review; workforce allocation respects employee and project permissions; delivery verification keeps its evidence; budget alerts do not duplicate and respect permissions; productivity metrics are contextual and are not individual performance assessments; caching cannot leak across tenants; geospatial data and photo EXIF have privacy, access and retention controls.
5. Roadmap approval does not authorise bypassing any implementation approval gate (plan approval, 🔒 architect review, owner merge).

### Decisions recorded in the register

| Question | Decision |
|---|---|
| Continuous worker GPS tracking | Accepted proposal: no continuous tracking; event-based locations only (check-in and out, photos). The consent wording is a P10-04 Done-when item. |
| E-signature | Audit-trail signature only (who, when, device, what was signed) with no claim of legal-grade validity. Legal-grade signing, its provider and its jurisdictions stay pending a legal review per country. |
| AI provider and data residency | Pending; decided at P23 kickoff. P6-07 fixes the principles first. |
| Integration build order (Microsoft 365, Google Workspace, accounting) | Pending; decided at P26 kickoff. |
| Equipment tracker provider; map tile provider; scanner and OCR packages | Pending, unchanged. |

## Consequences

- The roadmap and `docs/STACK.md` describe the same intended system, including future stages.
- P8-01 cannot start until the P6-07 ADR is accepted, because custom fields and entity links shape the sync schema.
- New tasks that touch money, permissions, personal data or approvals (P15-06, P19-05, P25-04, P26-01, P26-03, P26-04) are 🔒.
- No dependency, migration or code changes in this task.
- The scale target (ADR 0078) and the security programme (ADR 0079) are unchanged. New public surfaces (P26-03, P26-04) must meet the same controls: rate limits (ADR 0080), tenant isolation, audit logging and ASVS tracker rows.
