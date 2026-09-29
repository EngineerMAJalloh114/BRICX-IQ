-- BRICX IQ foundations: organisations, users and roles, money and exchange
-- rates, and an append-only, hash-chained audit log of every change.
-- Replaces the API-written audit_log from 0001 with one filled by database
-- triggers, so no code path can change data without leaving a record.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- Money conventions
-- Every monetary column is a pair: <name>_minor BIGINT (integer count of the
-- currency's minor unit) and <name>_currency currency_code. Never NUMERIC or
-- floating point for stored amounts.
-- ---------------------------------------------------------------------------

CREATE DOMAIN currency_code AS CHAR(3) CHECK (VALUE ~ '^[A-Z]{3}$');

-- Seeded from packages/shared/src/currencies.ts; a test keeps them in sync.
CREATE TABLE currencies (
  code        currency_code PRIMARY KEY,
  minor_units SMALLINT NOT NULL CHECK (minor_units BETWEEN 0 AND 4)
);

INSERT INTO currencies (code, minor_units) VALUES
  ('AED', 2), ('AFN', 2), ('ALL', 2), ('AMD', 2), ('ANG', 2), ('AOA', 2), ('ARS', 2),
  ('AUD', 2), ('AWG', 2), ('AZN', 2), ('BAM', 2), ('BBD', 2), ('BDT', 2), ('BGN', 2),
  ('BHD', 3), ('BIF', 0), ('BMD', 2), ('BND', 2), ('BOB', 2), ('BOV', 2), ('BRL', 2),
  ('BSD', 2), ('BTN', 2), ('BWP', 2), ('BYN', 2), ('BZD', 2), ('CAD', 2), ('CDF', 2),
  ('CHE', 2), ('CHF', 2), ('CHW', 2), ('CLF', 4), ('CLP', 0), ('CNY', 2), ('COP', 2),
  ('COU', 2), ('CRC', 2), ('CUC', 2), ('CUP', 2), ('CVE', 2), ('CZK', 2), ('DJF', 0),
  ('DKK', 2), ('DOP', 2), ('DZD', 2), ('EGP', 2), ('ERN', 2), ('ETB', 2), ('EUR', 2),
  ('FJD', 2), ('FKP', 2), ('GBP', 2), ('GEL', 2), ('GHS', 2), ('GIP', 2), ('GMD', 2),
  ('GNF', 0), ('GTQ', 2), ('GYD', 2), ('HKD', 2), ('HNL', 2), ('HTG', 2), ('HUF', 2),
  ('IDR', 2), ('ILS', 2), ('INR', 2), ('IQD', 3), ('IRR', 2), ('ISK', 0), ('JMD', 2),
  ('JOD', 3), ('JPY', 0), ('KES', 2), ('KGS', 2), ('KHR', 2), ('KMF', 0), ('KPW', 2),
  ('KRW', 0), ('KWD', 3), ('KYD', 2), ('KZT', 2), ('LAK', 2), ('LBP', 2), ('LKR', 2),
  ('LRD', 2), ('LSL', 2), ('LYD', 3), ('MAD', 2), ('MDL', 2), ('MGA', 2), ('MKD', 2),
  ('MMK', 2), ('MNT', 2), ('MOP', 2), ('MRU', 2), ('MUR', 2), ('MVR', 2), ('MWK', 2),
  ('MXN', 2), ('MXV', 2), ('MYR', 2), ('MZN', 2), ('NAD', 2), ('NGN', 2), ('NIO', 2),
  ('NOK', 2), ('NPR', 2), ('NZD', 2), ('OMR', 3), ('PAB', 2), ('PEN', 2), ('PGK', 2),
  ('PHP', 2), ('PKR', 2), ('PLN', 2), ('PYG', 0), ('QAR', 2), ('RON', 2), ('RSD', 2),
  ('RUB', 2), ('RWF', 0), ('SAR', 2), ('SBD', 2), ('SCR', 2), ('SDG', 2), ('SEK', 2),
  ('SGD', 2), ('SHP', 2), ('SLE', 2), ('SOS', 2), ('SRD', 2), ('SSP', 2), ('STN', 2),
  ('SVC', 2), ('SYP', 2), ('SZL', 2), ('THB', 2), ('TJS', 2), ('TMT', 2), ('TND', 3),
  ('TOP', 2), ('TRY', 2), ('TTD', 2), ('TWD', 2), ('TZS', 2), ('UAH', 2), ('UGX', 0),
  ('USD', 2), ('USN', 2), ('UYI', 0), ('UYU', 2), ('UYW', 4), ('UZS', 2), ('VED', 2),
  ('VES', 2), ('VND', 0), ('VUV', 0), ('WST', 2), ('XAF', 0), ('XCD', 2), ('XCG', 2),
  ('XOF', 0), ('XPF', 0), ('YER', 2), ('ZAR', 2), ('ZMW', 2), ('ZWG', 2);

-- ---------------------------------------------------------------------------
-- Organisations, users, memberships
-- ---------------------------------------------------------------------------

CREATE TABLE organisations (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           TEXT NOT NULL CHECK (length(trim(name)) > 0),
  base_currency  currency_code NOT NULL REFERENCES currencies (code),
  default_locale TEXT NOT NULL DEFAULT 'en',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email        TEXT NOT NULL CHECK (position('@' IN email) > 1),
  display_name TEXT NOT NULL,
  locale       TEXT NOT NULL DEFAULT 'en',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX users_email_key ON users (lower(email));

-- Keep in sync with ROLES in packages/shared/src/permissions.ts.
CREATE TYPE member_role AS ENUM (
  'owner', 'admin', 'project_manager', 'finance', 'site_supervisor', 'worker', 'viewer'
);

CREATE TABLE memberships (
  organisation_id UUID NOT NULL REFERENCES organisations (id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role            member_role NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (organisation_id, user_id)
);

CREATE INDEX memberships_user_idx ON memberships (user_id);

-- ---------------------------------------------------------------------------
-- Exchange rates: 1 base = rate quote, in force from effective_date until a
-- newer row for the same pair. organisation_id NULL means a global rate;
-- an organisation's own rate wins over the global one on the same date.
-- ---------------------------------------------------------------------------

CREATE TABLE exchange_rates (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  organisation_id UUID REFERENCES organisations (id) ON DELETE CASCADE,
  base_currency   currency_code NOT NULL REFERENCES currencies (code),
  quote_currency  currency_code NOT NULL REFERENCES currencies (code),
  rate            NUMERIC(24, 12) NOT NULL CHECK (rate > 0),
  effective_date  DATE NOT NULL,
  source          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (base_currency <> quote_currency),
  UNIQUE NULLS NOT DISTINCT (organisation_id, base_currency, quote_currency, effective_date)
);

CREATE INDEX exchange_rates_lookup_idx
  ON exchange_rates (base_currency, quote_currency, effective_date DESC);

-- The rate in force for a pair on a date, preferring the organisation's own.
CREATE FUNCTION exchange_rate_on(
  p_org UUID, p_base currency_code, p_quote currency_code, p_date DATE
) RETURNS NUMERIC LANGUAGE sql STABLE AS $$
  SELECT rate FROM exchange_rates
  WHERE base_currency = p_base AND quote_currency = p_quote
    AND effective_date <= p_date
    AND (organisation_id = p_org OR organisation_id IS NULL)
  ORDER BY effective_date DESC, (organisation_id IS NULL)
  LIMIT 1
$$;

-- ---------------------------------------------------------------------------
-- Audit log
-- Append-only: UPDATE, DELETE and TRUNCATE are rejected by triggers.
-- Tamper-evident: each row stores the SHA-256 of the previous row's hash plus
-- its own content, so editing or removing history breaks audit_verify_chain().
-- The acting user comes from the transaction setting app.actor_user_id, which
-- the API sets with SET LOCAL at the start of every request's transaction.
-- ---------------------------------------------------------------------------

-- 0001's API-written audit_log is superseded; no production data exists yet.
DROP TABLE audit_log;
DROP FUNCTION audit_log_is_append_only();

CREATE TABLE audit_log (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  organisation_id UUID,
  actor_user_id   UUID,
  action          TEXT NOT NULL CHECK (action IN ('INSERT', 'UPDATE', 'DELETE')),
  table_name      TEXT NOT NULL,
  row_id          TEXT,
  old_data        JSONB,
  new_data        JSONB,
  prev_hash       BYTEA,
  hash            BYTEA NOT NULL
);

CREATE INDEX audit_log_org_idx ON audit_log (organisation_id, occurred_at DESC);
CREATE INDEX audit_log_row_idx ON audit_log (table_name, row_id);

CREATE FUNCTION audit_hash(
  p_prev BYTEA, p_occurred_at TIMESTAMPTZ, p_org UUID, p_actor UUID, p_action TEXT,
  p_table TEXT, p_row TEXT, p_old JSONB, p_new JSONB
) RETURNS BYTEA LANGUAGE sql IMMUTABLE AS $$
  SELECT digest(
    coalesce(encode(p_prev, 'hex'), '') || '|' ||
    to_char(p_occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') || '|' ||
    coalesce(p_org::text, '') || '|' || coalesce(p_actor::text, '') || '|' ||
    p_action || '|' || p_table || '|' || coalesce(p_row, '') || '|' ||
    coalesce(p_old::text, '') || '|' || coalesce(p_new::text, ''),
    'sha256')
$$;

CREATE FUNCTION audit_log_chain() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  -- Serialise writers so the chain has exactly one successor per row.
  PERFORM pg_advisory_xact_lock(hashtext('audit_log_chain'));
  SELECT hash INTO NEW.prev_hash FROM audit_log ORDER BY id DESC LIMIT 1;
  NEW.hash := audit_hash(NEW.prev_hash, NEW.occurred_at, NEW.organisation_id,
    NEW.actor_user_id, NEW.action, NEW.table_name, NEW.row_id, NEW.old_data, NEW.new_data);
  RETURN NEW;
END $$;

CREATE TRIGGER audit_log_chain BEFORE INSERT ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_chain();

CREATE FUNCTION audit_log_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_immutable();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_immutable();

-- Returns the id of the first entry whose hash does not match, or NULL if
-- the whole chain is intact.
CREATE FUNCTION audit_verify_chain() RETURNS BIGINT LANGUAGE plpgsql STABLE AS $$
DECLARE
  r audit_log%ROWTYPE;
  expected_prev BYTEA := NULL;
BEGIN
  FOR r IN SELECT * FROM audit_log ORDER BY id LOOP
    IF r.prev_hash IS DISTINCT FROM expected_prev
       OR r.hash <> audit_hash(r.prev_hash, r.occurred_at, r.organisation_id,
            r.actor_user_id, r.action, r.table_name, r.row_id, r.old_data, r.new_data) THEN
      RETURN r.id;
    END IF;
    expected_prev := r.hash;
  END LOOP;
  RETURN NULL;
END $$;

-- Generic row-change trigger. Attach to every business table with
-- SELECT audit_table('table_name');
-- A soft delete (deleted_at going from NULL to a value) is logged as DELETE.
CREATE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql
SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_old JSONB := CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END;
  v_new JSONB := CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END;
  v_row JSONB := coalesce(v_new, v_old);
  v_org UUID;
  v_actor TEXT := nullif(current_setting('app.actor_user_id', true), '');
  v_action TEXT := TG_OP;
BEGIN
  IF TG_OP = 'UPDATE' AND v_old = v_new THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND v_old ? 'deleted_at'
     AND v_old ->> 'deleted_at' IS NULL AND v_new ->> 'deleted_at' IS NOT NULL THEN
    v_action := 'DELETE';
  END IF;
  v_org := CASE
    WHEN TG_TABLE_NAME = 'organisations' THEN (v_row ->> 'id')::uuid
    ELSE (v_row ->> 'organisation_id')::uuid
  END;
  INSERT INTO audit_log (organisation_id, actor_user_id, action, table_name, row_id, old_data, new_data)
  VALUES (
    v_org, v_actor::uuid, v_action, TG_TABLE_NAME,
    coalesce(v_row ->> 'id',
      -- Composite keys (e.g. memberships) fall back to the key columns.
      (SELECT string_agg(v_row ->> a.attname, ':' ORDER BY k.ord)
       FROM unnest((SELECT indkey FROM pg_index
                    WHERE indrelid = TG_RELID AND indisprimary)) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = TG_RELID AND a.attnum = k.attnum)),
    v_old, v_new);
  RETURN NULL;
END $$;

CREATE FUNCTION audit_table(p_table REGCLASS) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format(
    'CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON %s
       FOR EACH ROW EXECUTE FUNCTION audit_row_change()', p_table);
END $$;

DO $$
BEGIN
  PERFORM audit_table('organisations');
  PERFORM audit_table('users');
  PERFORM audit_table('memberships');
  PERFORM audit_table('exchange_rates');
  PERFORM audit_table('currencies');
  PERFORM audit_table('projects');
END $$;

-- Every stored amount names a known currency.
ALTER TABLE projects
  ADD CONSTRAINT projects_currency_fkey FOREIGN KEY (currency) REFERENCES currencies (code);
