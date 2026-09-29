# Foundations: accountability, money and language

These rules apply to every feature built on BRICX IQ.

## Organisations, users and roles

- A user belongs to one or more organisations through `memberships`, each with one role:
  owner, admin, project manager, finance, site supervisor, worker or viewer.
- Code checks **permissions**, never role names: `assertCan(role, "expenses.approve")`.
  The role to permission map lives in `packages/shared/src/permissions.ts`.
- Only an owner can make someone an owner or change an owner's role (`canAssignRole`).

## Audit log

- Every insert, update and delete on an audited table is written to `audit_log` by a
  database trigger, with the before and after row, the table, the row id, the
  organisation and the acting user. Application code cannot forget to log.
- The API sets `app.actor_user_id` (the signed-in `users.id`) at the start of every
  write transaction, as `POST /sync/upload` does, so each change is attributed.
- A soft delete (setting `deleted_at`) is logged as `DELETE`.
- `audit_log` is append-only: UPDATE, DELETE and TRUNCATE are rejected.
- Rows are hash-chained (SHA-256). `SELECT audit_verify_chain()` returns the first
  tampered entry, or NULL when the log is intact.
- New business tables opt in with `SELECT audit_table('table_name');` in their migration
  and carry an `organisation_id` column so their audit rows are scoped.

## Money

- Store amounts as two columns: `<name>_minor BIGINT` (integer cents, fils, ...) and
  `<name>_currency currency_code`. Never floats, never NUMERIC for stored amounts.
- Currencies are the ISO 4217 list in `packages/shared/src/currencies.ts`, mirrored in the
  `currencies` table (a test keeps them identical).
- In TypeScript use `Money` from `@bricx/shared` (`bigint` minor units). Synced columns hold
  the same value as a safe integer; `toMinor()` parses user input for them. Arithmetic refuses
  to mix currencies; `multiply` and `convert` round half-to-even; `allocate` splits
  without losing a cent.
- Exchange rates are dated: a rate applies from `effective_date` until a newer one.
  Convert with the rate in force on the transaction date, and store the converted
  amount alongside the original rather than recomputing it later.
  An organisation's own rate wins over a global rate (`exchange_rate_on()` in SQL,
  `convert()` in TypeScript).

## Language

- No user-facing text in code. All strings live in `packages/shared/locales/<lang>.json`
  (i18next format, `{{placeholder}}` interpolation). English is the reference; tests
  fail if another language is missing a key or a placeholder.
- Add a language by adding a JSON file and registering it in `packages/shared/src/i18n.ts`.
- In the app, use `t()` from `apps/mobile/src/i18n.ts`, which follows the device language.

## Running the tests

`pnpm test` runs the shared unit tests and the API tests, which apply the migrations in
`apps/api/migrations` to PostgreSQL (`DATABASE_URL`) and check audit capture, append-only
enforcement, tamper detection, rate lookup and constraints.
