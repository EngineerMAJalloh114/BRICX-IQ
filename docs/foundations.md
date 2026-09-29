# Foundations: accountability, money and language

These rules apply to every feature built on BRICX IQ.

## Organisations, users and roles

- A user belongs to one or more organisations through `memberships`, each with one role:
  owner, admin, project manager, finance, site supervisor, worker or viewer.
- Code checks **permissions**, never role names: `assertCan(role, "expenses.approve")`.
  The role to permission map lives in `packages/core/src/permissions.ts`.
- Only an owner can make someone an owner or change an owner's role (`canAssignRole`).

## Audit log

- Every insert, update and delete on an audited table is written to `audit_log` by a
  database trigger, with the before and after row, the table, the row id, the
  organisation and the acting user. Application code cannot forget to log.
- The API must run each request in a transaction that starts with
  `SET LOCAL app.actor_user_id = '<user uuid>'` so changes are attributed.
- `audit_log` is append-only: UPDATE, DELETE and TRUNCATE are rejected.
- Rows are hash-chained (SHA-256). `SELECT audit_verify_chain()` returns the first
  tampered entry, or NULL when the log is intact.
- New business tables opt in with `SELECT audit_table('table_name');` in their migration.

## Money

- Store amounts as two columns: `<name>_minor BIGINT` (integer cents, fils, ...) and
  `<name>_currency currency_code`. Never floats, never NUMERIC for stored amounts.
- In TypeScript use `Money` from `@bricx/core` (`bigint` minor units). Arithmetic refuses
  to mix currencies; `multiply` and `convert` round half-to-even; `allocate` splits
  without losing a cent.
- Exchange rates are dated: a rate applies from `effective_date` until a newer one.
  Convert with the rate in force on the transaction date, and store the converted
  amount alongside the original rather than recomputing it later.
  An organisation's own rate wins over a global rate (`exchange_rate_on()` in SQL,
  `convert()` in TypeScript).

## Language

- No user-facing text in code. All strings live in `packages/core/locales/<lang>.json`
  (i18next format, `{{placeholder}}` interpolation). English is the reference; tests
  fail if another language is missing a key or a placeholder.
- Add a language by adding a JSON file and registering it in `src/i18n.ts`.

## Running the tests

```sh
cd packages/core && npm install && npm test
PGHOST=... PGUSER=... db/test.sh   # needs PostgreSQL 16
```
