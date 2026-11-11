# 0083. Extension points: entity links, custom fields, workflow configuration, units, AI gateway and integration principles

- Status: Accepted on merge of this PR (owner review 2026-11-10)
- Date: 2026-11-10
- Deciders: Mohamed Abass Jalloh
- Source: ROADMAP P6-07 (docs only); ADR 0082 (founder-approved capability map and its conditions, 2026-11-09); P6-07 plan approved 2026-11-10 17:06Z with answers Q1–Q4 and owner conditions 1–6; ADR 0048 (permissions), 0049 (domain kernel, exact quantities), 0054 (RLS), 0055 (audit), 0056 (outbox), 0067 and 0068 (SoD), 0074 (adapter registry), 0079 (security programme), 0080 (rate limiting), 0081 (MFA admin keys); CLAUDE.md rules 1 to 13.

## Context

P8-01 freezes the sync schema. Six extension points are used by many later modules (P8, P10 to P12, P18, P23, P25 to P27), and two of them (entity links and custom fields) change the shape of synced rows. ADR 0082 requires that they are decided once, before P8-01, with the founder's safeguards. This ADR decides them at design level only: there is no code, migration or dependency change in P6-07. Each implementing task still needs its own plan, and a 🔒 task its own task plan and architect review (ADR 0082, condition 5).

Rules that hold for every topic below:

- No second authentication, authorization, logging or permission system (ADR 0079, rule 2). Every topic extends `@bricx/permissions`, `withTx()`, the audit chain and the outbox.
- Nothing here can weaken segregation of duties (rule 10) or any CLAUDE.md rule. Where configuration and a rule disagree, the rule wins and the configuration is refused.
- Every new tenant table has `org_id` and FORCE RLS; if it is synced it also has a PowerSync stream scope and a leak test (rule 3). RLS does not protect replication.
- The permission keys named here are sketches in the catalogue's `<area>.<resource>.<action>.<scope>` form. The catalogue itself changes only in the implementing task, with the completeness tests of ADR 0048 and ADR 0081.
- Data shapes are sketches. Column names and types are fixed by the implementing task's migration, hand-reviewed (rule 12).

## Decision

### 1. Entity links

**Decision.** One table, `bricx.entity_links`, holds every link between two entities (a comment thread on a task, minutes on a milestone, a document on a delivery). The entity types at both ends come from **one allowlisted registry** with a single source of truth in code, generated into a SQL CHECK so the database refuses a type that is not registered. A type is added to the registry only by a task that also adds its integrity lookup and its leak test.

- **Tenant validation at both ends.** A trigger on insert resolves each end through a per-type lookup and requires that the row exists and has the link's `org_id` (and, when the link carries a `project_id`, that both ends belong to that project or to the organisation level). A link whose ends are in two organisations is refused in the database, not only in the API.
- **Integrity.** No dangling link: an entity that is the target or source of a link cannot be hard-deleted while the link is open (the registered types are soft-deleted or archived, and the per-type lookup treats a removed row as absent for new links). A scheduled integrity check (`links:verify`, with the worker's scheduler) reports any link whose end is missing; it must always report zero.
- **`entity_links` is a synced tenant table (owner condition 1).** It has `org_id`, FORCE RLS, a PowerSync stream scope and a leak test (rule 3). A link syncs in the stream of its **from** entity: whoever can sync the from entity receives the link row.
- **Placeholder for an unreadable target (owner condition 1).** When the reader may not read the target, the client and the API show a placeholder that carries **only the target's type and id**: no title, status, amount, author or date. The link row itself never carries a copy of any field of the target.
- **Financial entities.** A ledger or payment row may be the *target* of a link (for example a document attached to an expense), but links never carry amounts and are never read by a financial calculation. No financial entity syncs before P8-02/P9 (binding permissions rule), so a link to one shows as a placeholder until then.

**Rejected alternatives.**

- A join table per pair of types: the number of tables grows with the square of the entity types and each needs its own stream and leak test.
- Arrays of ids in a JSONB column on the entity: no integrity, no index by target, and every edit rewrites the parent row (sync conflicts).
- A generic table with no integrity trigger ("polymorphic association" checked only in the API): one missed code path gives a cross-tenant or dangling link.
- A graph database: a second store that RLS and `withTx()` do not cover.

**Data shape (sketch).**

```
entity_links
  id            uuid (v7, generated on device when created offline)
  org_id        uuid   -- RLS; equals both ends' org
  project_id    uuid?  -- null for organisation-level links
  from_type     text   -- CHECK (from_type IN <registry>)
  from_id       uuid
  to_type       text   -- CHECK (to_type IN <registry>)
  to_id         uuid
  relation      text   -- closed enum per (from_type, to_type): 'attachment', 'discussion', 'reference', ...
  created_by    uuid, created_at timestamptz
  removed_at    timestamptz?, removed_by uuid?
  UNIQUE (org_id, from_type, from_id, to_type, to_id, relation) WHERE removed_at IS NULL
  INDEX (org_id, to_type, to_id)   -- "what links here"
```

**Permission keys.** None new. Creating or removing a link needs the **update** permission on the from entity and the **read** permission on the target; reading a link needs read on the from entity. The checked `can()` helper is used for both ends (fail closed).

**Test strategy.**

- Database: an insert with an unregistered type, a missing end, an end in another organisation or an end in another project is refused (SQLSTATE asserted); FORCE RLS and the app's grants as in `rls.int.test.ts`.
- Registry completeness: every registered type has a lookup, a leak-test entry and a relation enum; a type present in SQL but not in code (or the reverse) fails the test.
- API: linking without update on the from entity or read on the target is 403 or the uniform 404; the placeholder body is compared byte for byte and contains type and id only.
- Sync (P8-02): the leak test proves a user outside the from entity's scope never receives the link row, and a user who receives it learns nothing about an unreadable target beyond type and id.
- Sabotages: drop the same-org check; widen the placeholder with one extra field; remove the type from the registry but not from SQL.

### 2. Custom fields

**Decision.** An organisation defines custom fields per entity type; the values are stored **in a `custom_fields` JSONB column on the entity row** (owner answer Q2), so they sync with the entity and need no second stream.

- **Definitions** live in `bricx.custom_field_definitions` (tenant table, FORCE RLS, synced read-only to members so the client can render and validate offline). A definition has a stable machine key, a data type from a closed list (`text`, `decimal` as a decimal string, `date`, `boolean`, `select`, `multi_select`), options for the select types, a required flag and an archive timestamp. A definition's key and data type never change; a change of meaning is a new definition. Archiving hides the field and keeps the stored values.
- **Validation.** The API validates every write against the organisation's definitions (unknown key, wrong type, an option that does not exist, a required field missing: 422). Bounds are enforced before parsing: at most 50 active definitions per entity type, a text value at most 2,000 characters, the whole column at most 16 KB. The database adds a backstop CHECK (`jsonb_typeof = 'object'` and a size bound), never a 500.
- **Never an input to decisions (founder condition).** Custom-field values are never read by an RLS policy, a permission check, an SoD check, a sync stream scope or a financial calculation. There is **no money data type**: an amount belongs in a typed money column (rule 1), and a `decimal` custom field is a labelled number with no currency.
- **Forbidden tables (owner condition 2).** A `custom_fields` column is forbidden on every append-only ledger and audit table and beside or inside any money column: ledger entries, payments, audit events and the outbox are never in the custom-field entity allowlist. The allowlist is a subset of the entity-link registry chosen per task.
- **Enforcement.** An original Semgrep rule (ADR 0043) refuses any reference to `custom_fields` in `packages/db/src/rls.ts`, policy SQL, `@bricx/permissions`, `@bricx/money`, the SoD module and ledger code, and refuses a `custom_fields` column in a migration for a table on the append-only list (owner condition 2). The rule has known-bad and known-good fixtures in the self-test.
- **Content is untrusted.** Labels, option names and values are user text: stored as data, rendered as text only (never HTML), exported with the CSV and PDF formula-injection guard of ADR 0079 (S5), never interpolated into SQL (parameters only) and never used as a JSON path or column name. Definition labels are organisation data, not i18n keys; rule 8 still applies to every string the product itself ships.
- **Sync conflicts.** The column merges per field key under the entity's own conflict rule; a financial record never auto-merges (rule 9), and it has no custom fields anyway.

**Rejected alternatives.**

- A separate values table (entity–attribute–value): one row per value multiplies sync volume, needs its own stream and leak test, and makes "the entity with its fields" a join on every read.
- Free JSONB without definitions: no validation, no stable keys for reports, and nothing to render offline.
- Real columns added per organisation (DDL at run time): breaks hand-reviewed forward-only migrations (rule 12) and the sync schema.
- A money or formula field type: it would put financial values outside the ledger and `@bricx/money`.

**Data shape (sketch).**

```
custom_field_definitions
  id uuid, org_id uuid, entity_type text  -- CHECK (entity_type IN <custom-field allowlist>)
  key text            -- ^[a-z][a-z0-9_]{0,39}$, immutable, unique per (org_id, entity_type)
  label text          -- organisation's own text, <= 80 chars
  data_type text      -- closed enum above, immutable
  options jsonb?      -- [{ "key": "...", "label": "..." }] for select types, <= 50
  required boolean, position int
  created_by, created_at, archived_at?, archived_by?

<entity>.custom_fields jsonb NOT NULL DEFAULT '{}'
  -- { "<definition key>": <string | boolean | [string]> }, CHECK object and size
```

**Permission keys.** `org.custom_field.manage.org` (create, edit the label, reorder, archive definitions; an admin-class key under the ADR 0081 completeness test). Reading definitions follows membership; reading and writing values follow the entity's own read and update keys.

**Test strategy.**

- Validation matrix per data type, the bounds (work-done tests: an oversized body is refused before parsing) and the 422 codes.
- Injection fixtures stored and returned inert: HTML and script text, `=cmd()` formula text in exports, SQL metacharacters, JSON-path-like keys.
- The "never an input" proof: the Semgrep self-test, plus a logged repo-wide grep in the implementing PR; a test that changing any custom-field value changes no permission result, no stream membership and no ledger total.
- Database: a migration adding `custom_fields` to an append-only table fails the check; RLS and grants on the definitions table.
- Sync: a definition archived on the server while a device is offline does not lose the device's value.
- Sabotages: read a custom field inside a policy; add the column to a ledger table; drop the size bound.

### 3. Workflow configuration

**Decision.** Approval policies, project stage sets, notification rules, templates and budget categories are **versioned data**, never code per organisation and never a script.

- **Append-only versions.** Each kind is a tenant table of immutable version rows with a status (`draft`, `active`, `retired`). Editing creates a new draft; activating a draft retires the previous active version in the same transaction. A row that has been active is never updated or deleted (triggers, as for other append-only tables).
- **Schema-validated.** The body of a version is validated by a closed schema per kind (`@bricx/validation`): a fixed vocabulary of steps, thresholds, roles and events. There is no expression language, no user-supplied code and no free-form condition.
- **Pinned in flight.** A request, approval chain or stage transition records the version id it started under and finishes under that version. Activating a new policy never changes who may approve something already submitted.
- **SoD cannot be configured away.** `requester != approver` and the second-approver rule of ADR 0067 stay in code (`checkSod`), checked on every approval regardless of the policy. A policy may add steps, approvers or lower thresholds; the validator refuses a policy that leaves a money action with no approval step, names the requester's own role as the only approver without a second person, or sets a self-approval or delay-based approval. There is no override flag and no "emergency bypass" setting.
- **Activation needs a second person (owner answer Q3).** The member who authored a draft approval policy cannot activate it: author != activator, enforced server-side as an SoD pair on the configuration chain. In a single-member organisation the draft stays pending until a second holder of the activate key exists (consistent with D2, ADR 0067).
- **Audited.** Create, activate and retire each write one audit event with the version id and a content hash of the body (the body is configuration, not personal data).
- **Notification rules** may only choose among events and recipients a member could already see; a rule never reveals an entity to someone who cannot read it (the P12 rule), and delivery still goes through the outbox (rule 5).
- **Budget categories** are labels for grouping; they are never an input to a ledger calculation other than as a foreign key on a budget line, and retiring one never rewrites posted entries.

**Rejected alternatives.**

- Mutable configuration rows: no history, and an edit would change the rules of an approval in flight.
- A rules or expression engine, or scripts per organisation: a place to hide an SoD bypass, and a remote-code surface.
- Configuration in region config (ADR 0073): that is for bounded scalar settings, not for structured, versioned policy.
- Feature flags per organisation in code: needs a deploy for a customer's change and cannot be audited as data.

**Data shape (sketch).**

```
workflow_config_versions            -- one table per kind, or one with a kind column (the task decides)
  id uuid, org_id uuid, kind text   -- 'approval_policy' | 'stage_set' | 'notification_rules' | 'template' | 'budget_categories'
  project_id uuid?                  -- null = organisation default
  version int                       -- per (org_id, kind, project_id), gapless
  status text                       -- 'draft' | 'active' | 'retired'
  body jsonb                        -- validated by the kind's schema; bounded size
  body_hash bytea
  created_by, created_at, activated_by?, activated_at?, retired_at?
  UNIQUE (org_id, kind, project_id) WHERE status = 'active'
  CHECK (activated_by IS NULL OR activated_by <> created_by)  -- approval policies
```

**Permission keys.** `org.workflow_config.read.org`, `org.workflow_config.manage.org` (drafts), `org.workflow_config.activate.org` (activate and retire). Per owner condition 3, `org.workflow_config.activate` joins `MFA_ADMIN_PERMISSIONS` and the SQL list `app.mfa_admin_keys()` **in a migration of the implementing task** (ROADMAP Also line on P26-01 and P26-02), so activation needs `acr` step-up like the other admin keys of ADR 0081.

**Test strategy.**

- Validator: a table of refused policies (no approval step on a money action, self-approval, a delay-based approval, an unknown step or role, an oversized body), each with its error code.
- SoD: with every valid policy the existing SoD suites still pass unchanged; a policy cannot make `checkSod` return allowed where the code floor refuses (property test over generated policies).
- Activation: the author's own activation is 403 with one denied event; a single-member organisation stays pending; step-up is required.
- Immutability: UPDATE or DELETE of an activated version is refused in the database; one active version per scope under 20 concurrent activations.
- In flight: a chain started under version n completes under n after n+1 is active.
- Sabotages: drop the author != activator check; let the validator accept a policy with no approver; update an active row.

### 4. Units

**Decision.** Wherever accuracy or traceability needs it, a measured quantity keeps **the original value and unit as entered** beside **the normalised SI value**. Both use the exact `Quantity` of ADR 0049 (decimal strings and bigint, never floats).

- **Where.** Deliveries and goods receipts, material requests and inventory movements, progress and daily-log measurements, drawing and site dimensions, equipment meter readings. A quantity that is only ever a count (`ea`) stores one value.
- **Direction.** The SI value is derived from the original with the exact factors of `@bricx/domain/units` at write time, with an explicit scale and rounding mode recorded by the column's definition. The original is never recomputed from SI and is never overwritten by a display conversion. A correction is a new record or a reversing movement, not an edit of the original.
- **Use.** Aggregation, comparison and stock arithmetic use the SI value; documents, audit and disputes show the original. Money is never derived from a converted quantity without the rounding mode of `@bricx/money` (rule 1).
- **Display.** Region configuration (ADR 0073) chooses the display system per organisation and project; display conversion happens at render time and is labelled with the unit's i18n key (rule 8).
- **Sync.** The original value and unit are generated on the device and sync unchanged; the server recomputes the SI value and refuses a row whose SI value does not match (a device cannot inject a different normalised value).

**Rejected alternatives.**

- SI only: the document a supplier signed said "40 bags" or "12 ft"; converting loses what was actually agreed and measured.
- Original only: totals across units need conversion on every read, and reports disagree when rounding differs.
- Floating-point storage: forbidden for quantities by ADR 0049.
- A per-organisation unit table with custom factors: factors are exact reference data re-derived by test; material-specific counts (bags, rolls) are handled by P11-01 as materials, not as units.

**Data shape (sketch).**

```
<entity>.qty_value   numeric(21,9)   -- as entered
<entity>.qty_unit    text            -- CHECK (qty_unit IN <34 unit codes of ADR 0049>)
<entity>.qty_si      numeric(27,9)   -- derived; SI base of the unit's dimension (m, m2, m3, kg, 1)
-- API and sync JSON: { "value": "12.500", "unit": "ft" } plus read-only "si": { "value": "3.810", "unit": "m" }
```

**Permission keys.** None. Units follow the entity's own keys; the display system is a region-config setting under its existing key.

**Test strategy.**

- Exactness: fast-check round trips against the ADR 0049 bigint oracle; no `number` reaches a quantity (compiler sabotage).
- Server recomputation: a synced row with a wrong SI value is refused.
- Aggregation: a total over mixed units equals the oracle's total of SI values; the original values are unchanged after any report or display conversion.
- Region display: changing the display system changes no stored value.
- Sabotages: overwrite the original on display conversion; trust the client's SI value.

### 5. AI gateway principles

Provider and data residency stay pending (decision register; decided at the P23 kickoff). These principles bind whatever provider is chosen.

**Decision.**

1. **Server-side only.** Every model call goes through one API-side gateway module behind an `ai` adapter kind in the ADR 0074 registry (contract kit, null adapter; the null adapter is refused in production only when the feature is enabled). No client holds a provider key or calls a provider.
2. **Off by default, per organisation.** An organisation's administrator turns AI features on; turning them off stops every call at once.
3. **Redaction before any call.** A redaction step removes or tokenises sensitive data (identity numbers, bank details, phone numbers, e-mail addresses, tokens, secrets and fields marked sensitive in the schema) before a prompt leaves the cell. Redaction is fail-closed: if it cannot run, no call is made.
4. **Access control before retrieval.** Retrieval runs **as the requesting user**, inside `withTx()`, through the same CASL-filtered queries a normal request uses. The model never receives a row the user could not read, and there is no service-level "read everything" path for AI.
5. **Tenant isolation.** No prompt, embedding, cache entry or stored output is shared between organisations; every store is keyed by `org_id` under FORCE RLS; caches are per organisation (ADR 0082, condition 4).
6. **Configurable retention.** Prompts and outputs are kept for a period the organisation sets (default: the minimum the feature needs; zero is allowed), then deleted. Audit events record metadata only: who, when, which feature, model, token counts and cost. Never the prompt or the output (personal data stays out of audit payloads, ADR 0055).
7. **No training on client data.** Contractually and technically: the provider must not train on prompts or outputs; this is a selection criterion for the pending provider decision.
8. **Human approval for consequential actions.** The model proposes; a person commits. The gateway has **no write tools** (owner condition 4): it cannot create, change, approve, pay or send anything. An AI suggestion is never a requester or an approver in any SoD chain.
9. **AI output is untrusted input (owner condition 4).** Output is validated against a schema before use, rendered as plain text and **never as HTML**, never executed, never used as a query, path or permission input, and goes through the same DTO validation as user input if a person accepts it.
10. **Prompt injection.** Document text, OCR text, file names, custom-field values and messages are data that may contain instructions to the model: they are a **prompt-injection vector** (owner condition 4). They are passed as delimited, labelled data; the gateway holds no tools that a successful injection could use; retrieval is already limited to what the user may read, so an injection cannot widen access.
11. **Cost caps.** Per-organisation and per-user limits (requests and spend per period), enforced before the call; over the cap is a 429 problem+json (ADR 0080 pattern). The `ai` routes get their own rate-limit class.

**Rejected alternatives.**

- Client-side calls to a provider: keys on devices, no redaction, no access control.
- A privileged retrieval service account for AI: bypasses CASL and makes every prompt a cross-permission leak.
- Giving the model write tools with "confirmation by the model": consequential actions without a human, and an SoD bypass.
- Storing prompts and outputs in the audit chain: personal data that cannot be erased (pending erasure decision).
- One shared vector index across organisations with a filter: a filter bug is a cross-tenant leak.

**Data shape (sketch).**

```
ai_settings        org_id, enabled boolean, retention_days int, monthly_cap_minor bigint + currency, updated_by/at
ai_interactions    id, org_id, user_id, feature, model, input_tokens, output_tokens, cost_minor + currency,
                   created_at, expires_at          -- metadata; FORCE RLS; not synced
ai_payloads        interaction_id, org_id, prompt_redacted, output, expires_at   -- deleted at expires_at; FORCE RLS; not synced
```

**Permission keys.** `org.ai.use.org` (use AI features; each feature also needs the read keys of the data it retrieves), `org.ai.configure.org` (enable, retention, caps; admin-class, so it falls under the ADR 0081 completeness test).

**Test strategy.**

- Redaction fixtures per sensitive class, including values inside free text and custom fields; redaction unavailable means no call.
- Retrieval leak test: two organisations and two users with different scopes; the recorded prompt never contains a row the user could not read.
- Injection fixtures: documents and OCR text carrying instructions ("ignore previous…", requests to reveal other data or to act); the output cannot trigger a write because no write path exists (asserted by a route and tool inventory test).
- Output handling: HTML and script in output rendered inert; schema-invalid output refused.
- Caps: over-cap is 429 before any provider call (the adapter records zero calls).
- Retention: payload rows are gone after `expires_at`; the audit event holds no prompt or output text (scan).
- Contract kit for the `ai` adapter kind (ADR 0074), run against the null adapter and any real one.

### 6. Integration platform principles

**Decision.**

1. **Adapters behind contract kits.** Every outside system (payments, SMS, e-mail, FX, accounting, calendars, storage, trackers, e-signature) is an adapter kind in the ADR 0074 registry with a contract kit and a null adapter. A module depends on the kind, never on a vendor SDK.
2. **Outbound webhooks through the outbox only (rule 5).** A request never calls a customer's endpoint. The domain change and its outbox row commit in one transaction; the worker delivers.
3. **Signed.** Each delivery carries an HMAC-SHA256 signature over the timestamp, the delivery id and the exact body, with a per-endpoint secret; the receiver can reject a replay by timestamp and delivery id. Two secrets may be active during rotation.
4. **Secrets (owner condition 5).** An endpoint secret is **shown once**, at creation or rotation, and never again; it is **stored encrypted** with the shared field-encryption helper (ADR 0079, S9), never logged, never in audit payloads and never returned by a read.
5. **Retries.** Exponential backoff with jitter and a bounded number of attempts; then a dead-letter state the administrator can inspect and replay. Deliveries are at-least-once with a stable delivery id for the receiver's idempotency. An endpoint that keeps failing is disabled automatically and its administrators are notified.
6. **SSRF guard (owner condition 5).** `https` only, on the default port unless allowlisted; the host is **resolved once and the IP pinned** for the connection, and the address is **re-checked at connect** so a DNS answer that changes between the check and the connection (DNS rebinding) cannot reach an internal address; private, loopback, **link-local and cloud-metadata ranges** (for example `169.254.0.0/16`, `fe80::/10`, `169.254.169.254` and `fd00:ec2::254`) and the cell's own networks are blocked for IPv4 and IPv6; redirects are not followed; there is a connect and total **timeout** and a **response-size cap**, and the response body is never stored beyond a bounded status snippet.
7. **Payload minimisation.** An event carries ids, the event type and the fields the subscription's scope allows. No secret, token or financial detail beyond that scope. A subscription is created by a member and can never deliver what that member's organisation role could not read.
8. **Monitoring per integration.** A delivery log (status, attempts, latency, last error class), per-integration health, and alerts on failure rate and dead letters (P13-05). Log lines carry ids and codes, never bodies.
9. **Inbound webhooks.** Verified by signature or by a server-to-server check before any state change; a payment is confirmed only that way (rule 10). Inbound routes are rate limited (ADR 0080) and idempotent.
10. **Public API (P26-03).** Scoped credentials, per-credential rate limits, tenant isolation, revocation and audit logging of every use, as ADR 0082 requires; it reuses the existing guard and catalogue, not a second permission system.

**Rejected alternatives.**

- Calling the receiver from the request: lost events on a crash, slow requests, and a rule 5 breach.
- Unsigned webhooks or a static bearer token in a header: the receiver cannot detect tampering or replay.
- Trusting the URL check alone (resolve, check, then let the HTTP client resolve again): open to DNS rebinding.
- Vendor SDKs imported directly by modules: no contract test, no null adapter, vendor lock in every module.
- Storing endpoint secrets in plain text or showing them on every read: a database read or a screen share leaks every customer's signing key.

**Data shape (sketch).**

```
webhook_endpoints    id, org_id, url, event_types text[], status ('active'|'disabled'), failure_count,
                     secret_ciphertext, secret_prev_ciphertext?, secret_rotated_at, created_by/at
webhook_deliveries   id, org_id, endpoint_id, event_id, event_type, attempt, status, http_status?,
                     error_class?, latency_ms?, next_attempt_at?, created_at        -- append-only log
integration_connections  id, org_id, adapter_kind, adapter_id, status, credentials_ciphertext, last_ok_at, last_error_class
-- all three: FORCE RLS, not synced
```

**Permission keys.** `org.integration.read.org` (see connections, endpoints without secrets, and the delivery log), `org.integration.manage.org` (create, rotate, disable, replay; admin-class under the ADR 0081 completeness test). Public API credentials (P26-03) get their own keys in that task.

**Test strategy.**

- Signature: a known-answer test; a tampered body, an old timestamp and a replayed delivery id are rejected by the reference verifier shipped in the docs.
- Outbox: the delivery row exists if and only if the domain transaction committed; a crash between commit and send delivers after restart; no BullMQ enqueue from a request (existing Semgrep rule).
- Retry and dead letter: the backoff schedule with an injected Clock; auto-disable at the threshold; replay delivers once.
- SSRF fixtures: private, loopback, link-local and metadata addresses in IPv4 and IPv6, decimal and hex host forms, a redirect to an internal address, a host whose DNS answer changes between check and connect, an oversized response and a slow response.
- Secrets: the secret appears in exactly one response, in no log line, audit payload or later read (scan); the stored value is ciphertext.
- Tenant isolation: organisation B never sees, replays or receives organisation A's deliveries; RLS and grants on the three tables.
- Contract kits per adapter kind (ADR 0074).

## Owner conditions (2026-11-10) and where they are met

| # | Condition | Where |
|---|---|---|
| Q1 | Tick P6-07; status "Accepted on merge of this PR (owner review 2026-11-10)" | Status line; ROADMAP |
| Q2 | Custom-field values in JSONB on the entity | Topic 2 |
| Q3 | Author != activator for approval policies | Topic 3 |
| Q4 | Typeface option B = IBM Plex Sans + IBM Plex Sans Arabic | `docs/adr/pending.md` (not decided by this ADR) |
| 1 | Placeholder carries only type and id; `entity_links` is a synced tenant table with a stream scope and a leak test | Topic 1 |
| 2 | Custom fields forbidden on append-only ledger and audit tables and money columns; Semgrep rule | Topic 2 |
| 3 | `org.workflow_config.activate` joins `MFA_ADMIN_PERMISSIONS` and `app.mfa_admin_keys()` in a migration | Topic 3; ROADMAP Also lines on P26-01 and P26-02 |
| 4 | AI output is untrusted input, never HTML, no write tools; document and OCR text is a prompt-injection vector; threat-model row | Topic 5, points 8 to 10; `docs/security/threat-model.md` |
| 5 | Webhook SSRF guard: resolve once and pin, re-check at connect, link-local and metadata ranges, timeout and size cap; secrets shown once and stored encrypted | Topic 6, points 4 and 6 |
| 6 | Typeface row names both families; the P7-02 spike verifies variable builds for both and records the trade-off if the Arabic family is static-only | `docs/adr/pending.md` |

## Amendment 2026-11-11 (architect review of PR #91, owner-approved)

These refine the accepted decisions; none reverses one.

1. **Topic 3, activation chain.** "Author != activator" compares the activator with **every author of the draft chain since the last active version** (the creator of the version and of each draft it descends from), not only the creator of the version being activated. Otherwise member A drafts a policy, member B saves a trivial edit as a new draft, and A activates B's version. The CHECK in the sketch applies to `kind = 'approval_policy'` only, and the chain rule is enforced in the service and by a trigger over the draft lineage (`derived_from` on each draft). Test: A drafts, B edits, A activates is 403 with one denied event; sabotage: compare with the last author only.
2. **Topic 2, no field-level permission.** A member who can read an entity reads every custom field on it. Custom fields are for non-secret business data; secrets, identity numbers and bank details never go in a custom field (the redaction step of topic 5 also treats them as sensitive).
3. **Topic 4, SI recomputation.** `qty_si` is a synced column, but the server's upload handler **ignores the value a device sends and recomputes it** from the original value and unit; a device row whose original is invalid is refused. The API JSON `si` is read-only.
4. **Topic 6, endpoint URLs.** A webhook URL with embedded credentials (`user:pass@host`) or a fragment is refused at creation. Network-level egress control is added as defence in depth (ROADMAP P13-01): the worker's subnet has no route to internal ranges or the metadata address except through an egress proxy that denies them, so a bug in the application guard cannot reach them.

## Consequences

- P8-01 may start once this ADR is accepted: the sync schema carries `entity_links` (with its stream scope and leak test), the `custom_fields` column on the allowlisted entities, the read-only `custom_field_definitions`, and original-plus-SI quantity columns.
- Implementing tasks: entity links at P8-01 and P12-05; custom fields and project stages at P26-01; templates and notification rules at P26-02; approval policies with the P9 approvals work; units from the first measuring module (P10, P11); the AI gateway at P23; webhooks and the integration monitor at P26-04; the public API at P26-03. Each keeps its own approval gates.
- New Semgrep rules (custom fields out of RLS, permissions, money and append-only tables) are written in the implementing task with self-test fixtures.
- New admin-class permission keys must pass the ADR 0081 completeness test; `org.workflow_config.activate` needs MFA through a migration of the implementing task.
- The threat model gains rows for these surfaces; the ASVS tracker rows are added by the implementing tasks.
- No dependency, migration or code change in P6-07. Provider, residency, legal and build-order decisions stay in `docs/adr/pending.md`.
