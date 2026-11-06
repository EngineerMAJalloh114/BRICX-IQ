#!/usr/bin/env bash
# P6-01 (ADR 0071, owner conditions C1 and C7): the global directory's
# database, bricx_directory, and its three roles. In production the
# directory is one global instance; in development it shares this
# container with the cell database but nothing else:
# - directory_owner: owns schemas directory and directory_migrations and
#   runs the directory migrations;
# - directory_reader: SELECT only (the public resolve route and the global
#   deployment); its table grants come from the directory migrations;
# - directory_writer: INSERT on directory.org_directory only, plus the
#   SELECT its conflict check needs (registerOrganization), from the same
#   migrations.
# Only these three roles may connect to bricx_directory, and none of them
# may connect to the cell database (01-bootstrap.sh revoked CONNECT there
# from PUBLIC) or powersync_storage. Runs once, as the image's bootstrap
# superuser, on the first start of an empty postgres-data volume, after
# 01-bootstrap.sh (an existing volume needs `pnpm dev:reset`; `pnpm dev:up`
# detects it).
#
# Passwords come from the container environment (compose.yml passes them
# from .env); psql receives each one as a variable and quotes it with
# :'name', so no password is ever a literal in SQL.
set -euo pipefail

for var in POSTGRES_USER POSTGRES_DB DIRECTORY_OWNER_PASSWORD \
  DIRECTORY_READER_PASSWORD DIRECTORY_WRITER_PASSWORD; do
  if [ -z "${!var:-}" ]; then
    echo "02-directory.sh: $var is empty; run pnpm dev:up to complete .env" >&2
    exit 1
  fi
done

directory_db=bricx_directory

# CREATE DATABASE cannot run inside a transaction block.
psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set directory_db="$directory_db" <<'SQL'
CREATE DATABASE :"directory_db";
SQL

psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  --set directory_db="$directory_db" \
  --set directory_owner_password="$DIRECTORY_OWNER_PASSWORD" \
  --set directory_reader_password="$DIRECTORY_READER_PASSWORD" \
  --set directory_writer_password="$DIRECTORY_WRITER_PASSWORD" <<'SQL'
BEGIN;
-- Every attribute explicit, as in 01-bootstrap.sh.
CREATE ROLE directory_owner WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'directory_owner_password';
CREATE ROLE directory_reader WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'directory_reader_password';
CREATE ROLE directory_writer WITH LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS PASSWORD :'directory_writer_password';
-- Pinned search_path; pg_temp last.
ALTER ROLE directory_owner SET search_path = directory, pg_temp;
ALTER ROLE directory_reader SET search_path = directory, pg_temp;
ALTER ROLE directory_writer SET search_path = directory, pg_temp;
-- Nobody connects or creates temporary objects by default; only the
-- directory roles connect, and only here.
REVOKE ALL ON DATABASE :"directory_db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"directory_db"
  TO directory_owner, directory_reader, directory_writer;
COMMIT;
SQL

psql --no-psqlrc --set ON_ERROR_STOP=1 \
  --username "$POSTGRES_USER" --dbname "$directory_db" <<'SQL'
BEGIN;
-- Schema public holds nothing and grants nothing.
REVOKE ALL ON SCHEMA public FROM PUBLIC;
-- The directory's tables, owned by directory_owner. No default table
-- privileges: each migration grants exactly what each role needs.
CREATE SCHEMA directory AUTHORIZATION directory_owner;
REVOKE ALL ON SCHEMA directory FROM PUBLIC;
GRANT USAGE ON SCHEMA directory TO directory_reader, directory_writer;
-- Migration history: directory_owner's alone (ADR 0052's pattern).
CREATE SCHEMA directory_migrations AUTHORIZATION directory_owner;
REVOKE ALL ON SCHEMA directory_migrations FROM PUBLIC;
-- No function directory_owner creates is executable by PUBLIC.
ALTER DEFAULT PRIVILEGES FOR ROLE directory_owner
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
COMMIT;
SQL
