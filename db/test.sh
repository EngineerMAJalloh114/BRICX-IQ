#!/usr/bin/env bash
# Apply every migration to a fresh throwaway database, then run db/test/*.sql.
# Uses the usual libpq env vars (PGHOST, PGPORT, PGUSER, PGPASSWORD).
set -euo pipefail
cd "$(dirname "$0")"
DB="bricx_test_$$"
createdb "$DB"
trap 'dropdb --if-exists "$DB"' EXIT
for f in migrations/*.sql; do
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done
for f in test/*.sql; do
  echo "== $f"
  psql -X -q -v ON_ERROR_STOP=1 -d "$DB" -f "$f"
done
