#!/usr/bin/env bash
# P2-02 (ADR 0035): database bootstrap roles, schemas, extensions and the
# empty `powersync` publication. Runs once, as the image's bootstrap
# superuser, on the first start of an empty postgres-data volume (an
# existing volume needs `pnpm dev:reset`; `pnpm dev:up` detects it).
#
# Passwords come from the container environment (compose.yml passes them
# from .env); psql receives each one as a variable and quotes it with
# :'name', so no password is ever a literal in SQL.
#
# The bootstrap superuser is used here and nowhere else.
set -euo pipefail

for var in POSTGRES_USER POSTGRES_DB BRICX_OWNER_PASSWORD BRICX_APP_PASSWORD \
  BRICX_READONLY_PASSWORD POWERSYNC_REPL_PASSWORD POWERSYNC_STORAGE_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    echo "01-bootstrap.sh: $var is empty; run pnpm dev:up to complete .env" >&2
    exit 1
  fi
done

psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set app_db="$POSTGRES_DB" \
  --set bricx_owner_password="$BRICX_OWNER_PASSWORD" \
  --set bricx_app_password="$BRICX_APP_PASSWORD" \
  --set bricx_readonly_password="$BRICX_READONLY_PASSWORD" \
  --set powersync_repl_password="$POWERSYNC_REPL_PASSWORD" \
  --set powersync_storage_password="$POWERSYNC_STORAGE_PASSWORD" <<'SQL'
BEGIN;

-- Roles. Every attribute is explicit, so a changed default can never
-- widen one.
-- bricx_owner: owns schema bricx and the publication; runs migrations.
CREATE ROLE bricx_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'bricx_owner_password';
-- bricx_app: the application. DML only, always subject to RLS.
CREATE ROLE bricx_app WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'bricx_app_password';
-- bricx_readonly: reporting. SELECT only, always subject to RLS.
CREATE ROLE bricx_readonly WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'bricx_readonly_password';
-- powersync_repl: PowerSync's replication source. BYPASSRLS because its
-- initial snapshot is a plain SELECT and every tenant table forces RLS;
-- it can only read tables a migration grants it (no default privileges).
-- RLS does not protect replication: sync streams and leak tests do. This
-- credential never leaves the sync service.
CREATE ROLE powersync_repl WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  REPLICATION BYPASSRLS PASSWORD :'powersync_repl_password';
-- powersync_storage_owner: owns PowerSync's bucket storage database only.
CREATE ROLE powersync_storage_owner WITH LOGIN NOSUPERUSER NOCREATEDB
  NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD :'powersync_storage_password';

-- Pinned search_path on every role; pg_temp last, so a temporary object
-- can never shadow ours.
ALTER ROLE bricx_owner SET search_path = bricx, extensions, pg_temp;
ALTER ROLE bricx_app SET search_path = bricx, extensions, pg_temp;
ALTER ROLE bricx_readonly SET search_path = bricx, extensions, pg_temp;
ALTER ROLE powersync_repl SET search_path = bricx, extensions, pg_temp;
ALTER ROLE powersync_storage_owner SET search_path = powersync, pg_temp;

-- Databases: nobody connects or creates temporary objects by default.
REVOKE ALL ON DATABASE :"app_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"app_db"
  TO bricx_owner, bricx_app, bricx_readonly, powersync_repl;
ALTER DATABASE powersync_storage OWNER TO powersync_storage_owner;
REVOKE ALL ON DATABASE powersync_storage FROM PUBLIC;

-- Schemas: public holds nothing and grants nothing.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

-- Extensions live in their own schema, owned by the bootstrap superuser.
CREATE SCHEMA extensions;
REVOKE ALL ON SCHEMA extensions FROM PUBLIC;
GRANT USAGE ON SCHEMA extensions
  TO bricx_owner, bricx_app, bricx_readonly, powersync_repl;
CREATE EXTENSION postgis SCHEMA extensions;
CREATE EXTENSION pg_trgm SCHEMA extensions;
CREATE EXTENSION btree_gist SCHEMA extensions;
CREATE EXTENSION pgcrypto SCHEMA extensions;

-- Application tables live in bricx, owned by bricx_owner.
CREATE SCHEMA bricx AUTHORIZATION bricx_owner;
REVOKE ALL ON SCHEMA bricx FROM PUBLIC;
GRANT USAGE ON SCHEMA bricx TO bricx_app, bricx_readonly, powersync_repl;
-- Tables bricx_owner creates later: DML for the app (no TRUNCATE,
-- REFERENCES or TRIGGER), SELECT for reporting, nothing for powersync_repl
-- (each migration that publishes a table grants it SELECT on that table).
ALTER DEFAULT PRIVILEGES FOR ROLE bricx_owner IN SCHEMA bricx
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bricx_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bricx_owner IN SCHEMA bricx
  GRANT USAGE, SELECT ON SEQUENCES TO bricx_app;
ALTER DEFAULT PRIVILEGES FOR ROLE bricx_owner IN SCHEMA bricx
  GRANT SELECT ON TABLES TO bricx_readonly;

-- PowerSync's publication, created EMPTY. Migrations add tables, paired
-- with GRANT SELECT ... TO powersync_repl; it is never dropped or
-- recreated (rows written while it is missing never replicate). Owned by
-- bricx_owner so migrations can ALTER it.
CREATE PUBLICATION powersync;
ALTER PUBLICATION powersync OWNER TO bricx_owner;

COMMIT;
SQL
