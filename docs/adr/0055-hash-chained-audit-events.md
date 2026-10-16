# 0055. Hash-chained audit events: `audit_events`, `AuditService.record()` and `audit:verify`

- Status: Accepted
- Date: 2026-10-16
- Deciders: Mohamed Abass Jalloh
- Source: P4-05 (task plan approved 2026-10-16 10:20Z: decisions 1–10 as ★, including decision 8 and its P13 "Also" line, and conditions 1–5); CLAUDE.md rules 2, 3, 4, 6, 7 and 12; ADR 0017 (hash chaining, one chain per org, RFC 8785 via `canonicalize`), ADR 0023 (dependency policy), ADR 0035 (database roles), ADR 0052 (migrations), ADR 0053 (`withTx()`), ADR 0054 (`enableTenantRls()`, `TENANT_TABLES`).

## Context

ROADMAP P4-05 asks for an `audit_events` table (`id, org_id, occurred_at, actor_id, actor_type, device_id, ip, geo, action, entity_type, entity_id, before, after, correlation_id, prev_hash, hash`), `REVOKE UPDATE, DELETE … FROM bricx_app`, an `AuditService.record()` that runs in the caller's transaction under `pg_advisory_xact_lock(hashtext(org_id))` and computes `hash = sha256(prev_hash || canonical_json(row))`, and an `audit:verify` CLI that walks a chain. Done when tampering a row makes `audit:verify` fail at that row. The P4-02 review added: `migrations-immutable` also covers `meta/NNNN_snapshot.json`.

ADR 0017 already fixes one chain per org, appends serialised per org, append-only for `bricx_app`, and RFC 8785 through `canonicalize`. A hash chain is only as good as the byte form it hashes, so this ADR pins that form for every column.

## Decision

### The table (migration `0001_audit_events`)

Columns, in order: `id uuid`, `org_id uuid`, `seq bigint`, `hash_version smallint`, `occurred_at timestamptz`, `actor_type text`, `actor_id uuid`, `device_id uuid`, `ip inet`, `geo jsonb`, `correlation_id text`, `action text`, `entity_type text`, `entity_id uuid`, `before jsonb`, `after jsonb`, `prev_hash bytea`, `hash bytea`.

- `seq` (decision 1): 1, 2, 3, … per org, `UNIQUE (org_id, seq)`, `CHECK (seq >= 1)`. The chain's order, and what makes a deleted row visible as a gap.
- `hash_version` (decision 1): `CHECK (hash_version >= 1)`. `record()` writes 1. A new canonical form gets a new number; `audit:verify` refuses a version it does not know (`unknown_hash_version`).
- `occurred_at`: from the injected `Clock` (rule 7), `CHECK (occurred_at = date_trunc('milliseconds', occurred_at))`.
- `actor_type IN ('user', 'system')`, and `actor_id` is required when it is `user`. `record()` takes the actor from the transaction's `app.user_id`, never from the caller, and writes `user`. `system` is reserved for jobs (P4-06 onward).
- `ip` holds a host address only: `CHECK (masklen(ip) = 32 for IPv4, 128 for IPv6)`.
- `prev_hash` and `hash` are `bytea`, `CHECK (octet_length = 32)` each. drizzle-orm 0.45.4 has no bytea column, so `packages/db` defines one with `customType`.
- `id` is a UUIDv7 from `record()` (rule 6). It is hashed, so the API always supplies it; the column default only exists because of the shared `id()` helper.

The migration appends `pnpm db:rls bricx.audit_events org.audit` verbatim (ENABLE + FORCE RLS, the SELECT and INSERT policies, `REVOKE UPDATE, DELETE ON bricx.audit_events FROM bricx_app`), and `TENANT_TABLES` registers `"bricx.audit_events": "org.audit"`. A unit test checks that the production migration contains `enableTenantRls()`'s output for every registered table.

### Append-only for every role (decision 6, condition 1)

The REVOKE stops `bricx_app`. For `bricx_owner` (and a superuser), the function `bricx.append_only()` (plpgsql, SECURITY INVOKER) raises `append-only table: <op> is not allowed` with SQLSTATE 42501, from two triggers:

- `audit_events_no_update_delete`: `BEFORE UPDATE OR DELETE … FOR EACH STATEMENT`;
- `audit_events_no_truncate`: `BEFORE TRUNCATE … FOR EACH STATEMENT`.

They are statement-level on purpose. FORCE RLS gives `bricx_owner` no visible rows without a context, so a row-level trigger would never fire for it and its UPDATE or DELETE would quietly do nothing. A statement-level trigger fires whether or not any row matches. Tests run owner UPDATE, DELETE and TRUNCATE on an empty table and on a table with rows; every one raises 42501.

There is no trigger checking the chain link on INSERT: `record()` computes it under the lock, and `audit:verify` checks it. The trigger function lives in schema `bricx`, not `app`, because schema `app` holds only the three RLS functions (ADR 0054).

### The hash (decision 3, conditions 2 and 3)

```
hash = sha256(prev_hash ‖ utf8(JCS(row)))
```

- JCS is RFC 8785, via `canonicalize` 5.1.0 (ADR 0017).
- `row` is a JSON object holding every column except `prev_hash` and `hash`, under its column name: `id, org_id, seq, hash_version, occurred_at, actor_type, actor_id, device_id, ip, geo, correlation_id, action, entity_type, entity_id, before, after` (`HASHED_COLUMNS`).
- The first row of each org links to 32 zero bytes (the genesis `prev_hash`).

Each column's serialisation is pinned. A column that is absent is JSON `null`.

| Column | Hashed as | How the verifier reads it back |
|---|---|---|
| `id`, `org_id`, `actor_id`, `device_id`, `entity_id` | lower-case canonical UUID string | `col::text` |
| `seq` | decimal string (a bigint can exceed 2^53) | `seq::text` |
| `hash_version` | JSON number | smallint (a JS number) |
| `occurred_at` | RFC 3339 UTC with exactly three fractional digits and `Z`, e.g. `2026-10-16T10:20:26.123Z` (`Date.prototype.toISOString`) | `to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')` |
| `actor_type`, `correlation_id`, `action`, `entity_type` | string | text |
| `ip` | Postgres's `inet::text` cast, which always carries the mask: `/32` for IPv4 and `/128` for IPv6, e.g. `203.0.113.7/32`, `2001:db8::1/128`, `::ffff:203.0.113.7/128`. The CHECK allows only those two masks. `record()` gets this form from Postgres (`$ip::inet::text`) in the same transaction, so the writer and the verifier hash the same text. | `ip::text` |
| `geo` | `{"lat_e6": <int>, "lon_e6": <int>}`: integer micro-degrees (degrees × 10^6), never floats, `|lat_e6| <= 90 000 000`, `|lon_e6| <= 180 000 000` | jsonb (round-trips integers exactly) |
| `before`, `after` | the JSON value | jsonb |

Why each rule:
- `inet::text` was chosen over the output form (which drops `/32` and `/128`) because it is one fixed rule for both families, and over parsing in Node because Postgres alone decides how a stored address is printed (upper-case hex, `::` compression and IPv4-mapped forms all normalise there). A test records `2001:DB8:0:0::1` and checks the stored text is `2001:db8::1/128`.
- jsonb normalises numbers and reorders keys, and JCS re-sorts keys anyway, so what matters is that a value comes back as the same JSON. Integers within 2^53 do; floats might not print the same way after a round trip, so `geo` and `before`/`after` refuse non-integers. A test writes geo, reads it back through a real jsonb round trip, and verifies the chain.

`before` and `after` (decision 4): JSON with no floats (money travels as strings, rule 1), no NUL character (jsonb refuses it), well-formed strings, plain objects and arrays only, depth ≤ 32, and ≤ 64 KiB each. They are checked before any database work, and an error names the field only (`audit.invalid_event`), never a value.

**What they may carry (condition 5).** `before` and `after` carry the change and nothing more: never a secret (no password, token, key or credential) and no personal data beyond what the change itself is about. A hash-chained row cannot be edited, so erasure of personal data inside an audit row is **deferred to P14-05** (data protection) and recorded in `pending.md`. The approaches it will choose between are: keep personal data out of audit payloads altogether (reference ids only), or encrypt each data subject's fields under a per-subject key and erase by destroying the key (crypto-shredding), with the hash taken over the ciphertext. Until then, callers record ids, not personal details.

### Recording (decision 5, condition 4)

`AuditService.record(tx, event, origin?)` lives in `apps/api` `modules/audit` and is exported through `public-api.ts` (rule 13). It runs inside the caller's transaction (`TxRunner` or `withTx()`), so the event commits or rolls back with the change it records. In order:

1. Validate the event and its origin; refuse a clock value outside what `toISOString()` can write.
2. Read `app.current_org()` and `app.current_user_id()`. Either missing → `AuditContextError` (`audit.no_tenant_context`). The org and the actor come from the transaction, never from the caller.
3. `pg_advisory_xact_lock(AUDIT_LOCK_NAMESPACE, hashtext(org))`, with `AUDIT_LOCK_NAMESPACE = 0x41554454` ("AUDT"). The two-key form never collides with the migrator's one-key lock, and P9's journal chain takes its own namespace.
4. After taking the lock, read `transaction_isolation`; anything but `read committed` → `AuditIsolationError` (`audit.isolation_not_read_committed`). Under REPEATABLE READ or SERIALIZABLE the snapshot is taken before the lock is granted, so the head read could be stale and two transactions could both write the same `seq`. Tests show both levels are refused.
5. Read the chain head (`seq`, `hash`), insert `seq + 1` with `prev_hash` = the head's hash (or genesis) and the new hash.

The origin defaults to the current request's correlation id, ip, device id and geo; outside a request, to a fresh UUIDv7 correlation id and nothing else.

**`record()` is the last statement of the request transaction.** The lock is held until COMMIT, so every statement after `record()` makes the org's other writers wait longer.

**Events with no org are out of scope.** Every row has an `org_id` and belongs to that org's chain. Events before an org is known (a failed sign-in, for example) are decided in P5 and recorded in `pending.md`.

### `audit:verify` (decision 7)

`pnpm audit:verify --org <uuid>` from the root builds `apps/api` and runs `dist/audit-verify.js` with the dev `.env`. With the environment already set, it is `pnpm --filter @bricx/api audit:verify --org <uuid>`.

- It reads `DATABASE_URL` like the API (`bricx_app`, under RLS) and verifies in one `withTx()` as that org. The user id is the nil UUID: verifying only reads, and `org.audit`'s policies check the org alone (for architect review).
- It reads in batches of 1000 by `seq`. For each row, in this order, it reports the first of: `seq_gap` (the seq is not the next one: a row deleted, or its `seq` or `org_id` changed), `unknown_hash_version`, `prev_hash_mismatch`, `hash_mismatch`.
- Exit 0: intact, printing the event count and the head (`seq`, `hash`), so the head can be recorded elsewhere. Exit 1: broken, printing the seq, the id of the row found there and the reason. Exit 2: usage, config or database error, printed as a code or key name only, never a URL or password.

A parametrised test edits each hashed column alone as superuser (triggers off with `session_replication_role = replica`) and checks the exit code and the message for that row. It also edits `prev_hash` and `hash`, deletes a row, and swaps two rows' contents.

### Tail truncation (decision 8)

Deleting the newest rows leaves a valid, shorter chain, which no check inside the database can tell from a chain that was never longer. Only a copy of the head kept outside the database shows it. ROADMAP P13 gets an "Also" line: anchor each org's head (`seq`, `hash`) outside the database (for example the object-locked audit exports bucket) and run `audit:verify` as a scheduled job that compares against the anchor.

### `canonicalize` 5.1.0 (decision 9, ADR 0023)

The registry's raw data, as of 2026-10-16:
- published 2026-09-18T20:46:44.100Z (more than 7 days earlier), installed with `--config.minimumReleaseAge=10080`;
- Apache-2.0;
- no dependencies and no install scripts (`hasInstallScript` false);
- integrity `sha512-bab9+WefZljqQ8jT0qRwVmTyzAUU63K97QIQD3agynIBrb6sa5M2eAy8Hv8K3p4V9+ONVYZKtGYl4Dg+/5Gumw==`;
- it ships a `bin` (`canonicalize`), which nothing here uses.

It is an exact-pinned runtime dependency of `apps/api`. Tests check it against RFC 8785's own examples (sections 3.2.2 and 3.2.3) and against an independent serialiser in the tests. `drizzle-orm` moves from a devDependency of `apps/api` to a dependency, because `record()` uses it at run time.

### Tooling (decision 10, and the P4-02 carry-forward)

- The RLS integration seeder knows `bytea` and `inet` columns and takes per-table overrides (`seq`, `hash_version`, `actor_type` for `audit_events`), so its parametrised cross-tenant tests cover the new table.
- `migrations-immutable` also refuses an edit, delete or rename of a merged `meta/NNNN_snapshot.json`, with guard fixtures and self-test cases.

## Consequences

Positive:
- Any edit of any hashed column, a deleted row and a reordered row each make `audit:verify` fail at the row concerned.
- `bricx_owner` and a superuser cannot UPDATE, DELETE or TRUNCATE the table without first disabling triggers.
- The ip, time and geo forms are fixed, so a verifier in another language can recompute every hash.

Negative:
- Appends in one org are serialised for the rest of the writing transaction (ADR 0017), so `record()` must come last.
- Changing any serialisation rule needs a new `hash_version` and verifier support for both.
- Tail truncation is detectable only once the P13 anchor exists.
- Erasure of personal data in `before`/`after` waits for P14-05; until then callers must keep personal data out.

## Alternatives rejected

- **Row-level append-only triggers**: they never fire for `bricx_owner` under FORCE RLS (condition 1).
- **`inet` output form or Node-side normalisation for `ip`**: two mask rules or a second normaliser that could drift from Postgres's.
- **Floats for `geo`**: a float's text form can differ after a jsonb round trip.
- **Hashing with `JSON.stringify`**: key order follows insertion order, so the same row can hash two ways.
- **A linkage trigger on INSERT**: duplicates `record()`'s logic in plpgsql; `audit:verify` already checks every link.
- **REPEATABLE READ for `record()`**: the snapshot predates the lock, so the head can be stale.
