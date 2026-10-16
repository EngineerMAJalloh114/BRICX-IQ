# Audit log (P4-05, ADR 0055)

`bricx.audit_events` holds one hash chain per organisation. Rows are never updated or deleted: `bricx_app` has no UPDATE or DELETE grant, and statement-level triggers refuse UPDATE, DELETE and TRUNCATE for every role (SQLSTATE 42501). A wrong event is corrected by recording a new one.

## Recording an event

Call `AuditService.record(tx, { action, entityType, entityId?, before?, after? })` from `modules/audit/public-api.ts`, inside the transaction that makes the change, as its **last statement**: it holds the org's audit lock until COMMIT. The transaction must be READ COMMITTED (the default). `before` and `after` carry the change only: no secrets, no personal details (ids instead), no floats (money as strings).

## Checking a chain

```bash
pnpm audit:verify --org <org uuid>   # builds the api, reads DATABASE_URL from .env
```

| Exit | Output | Meaning |
|---|---|---|
| 0 | `org <uuid>: intact, N events, head seq S hash H` | every row links and hashes correctly; keep the head if you need to detect later truncation |
| 1 | `org <uuid>: broken at seq S (id ID): reason` | the first bad row: `seq_gap` (a row deleted or moved), `unknown_hash_version`, `prev_hash_mismatch` (rows reordered or a link edited), `hash_mismatch` (a column edited) |
| 2 | `usage …`, a config key, `database_unavailable` or `database_error <SQLSTATE>` | the check could not run |

Deleting the newest rows leaves a valid, shorter chain. Only an external copy of the head shows it (P13).
