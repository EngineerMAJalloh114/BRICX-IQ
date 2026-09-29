-- Run by db/test.sh against a fresh database after all migrations.
-- Each block raises an exception on failure.

BEGIN;
SET LOCAL app.actor_user_id = '00000000-0000-0000-0000-0000000000a1';
INSERT INTO organisations (id, name, base_currency)
  VALUES ('00000000-0000-0000-0000-00000000000a', 'Acme Build', 'USD');
INSERT INTO users (id, email, display_name)
  VALUES ('00000000-0000-0000-0000-0000000000a1', 'owner@acme.test', 'Owner');
INSERT INTO memberships (organisation_id, user_id, role)
  VALUES ('00000000-0000-0000-0000-00000000000a', '00000000-0000-0000-0000-0000000000a1', 'owner');
UPDATE memberships SET role = 'admin';
UPDATE memberships SET role = 'admin';  -- no-op update, must not be logged
INSERT INTO exchange_rates (base_currency, quote_currency, rate, effective_date)
  VALUES ('USD', 'SLE', '22.50', '2026-01-01'), ('USD', 'SLE', '23.10', '2026-06-01');
INSERT INTO exchange_rates (organisation_id, base_currency, quote_currency, rate, effective_date)
  VALUES ('00000000-0000-0000-0000-00000000000a', 'USD', 'SLE', '22.80', '2026-01-01');
COMMIT;

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM audit_log;
  IF n <> 7 THEN RAISE EXCEPTION 'expected 7 audit rows, got %', n; END IF;

  IF EXISTS (SELECT 1 FROM audit_log
             WHERE actor_user_id IS DISTINCT FROM '00000000-0000-0000-0000-0000000000a1') THEN
    RAISE EXCEPTION 'every audit row must carry the acting user';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM audit_log WHERE table_name = 'memberships' AND action = 'UPDATE'
                 AND old_data ->> 'role' = 'owner' AND new_data ->> 'role' = 'admin'
                 AND organisation_id = '00000000-0000-0000-0000-00000000000a'
                 AND row_id = '00000000-0000-0000-0000-00000000000a:00000000-0000-0000-0000-0000000000a1') THEN
    RAISE EXCEPTION 'membership role change was not audited with before/after';
  END IF;

  IF audit_verify_chain() IS NOT NULL THEN
    RAISE EXCEPTION 'fresh audit chain should verify';
  END IF;
END $$;

-- Append-only: UPDATE, DELETE and TRUNCATE must all fail.
DO $$
DECLARE op TEXT;
BEGIN
  FOREACH op IN ARRAY ARRAY['UPDATE audit_log SET row_id = ''x''', 'DELETE FROM audit_log', 'TRUNCATE audit_log'] LOOP
    BEGIN
      EXECUTE op;
      RAISE EXCEPTION 'audit_log allowed: %', op;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
END $$;

-- Exchange rates: date in force, organisation override, no rate before start.
DO $$
BEGIN
  IF exchange_rate_on(NULL, 'USD', 'SLE', '2026-03-01') <> 22.50 THEN RAISE EXCEPTION 'global rate'; END IF;
  IF exchange_rate_on(NULL, 'USD', 'SLE', '2026-07-01') <> 23.10 THEN RAISE EXCEPTION 'newer rate'; END IF;
  IF exchange_rate_on('00000000-0000-0000-0000-00000000000a', 'USD', 'SLE', '2026-03-01') <> 22.80 THEN
    RAISE EXCEPTION 'org override';
  END IF;
  IF exchange_rate_on(NULL, 'USD', 'SLE', '2025-12-31') IS NOT NULL THEN RAISE EXCEPTION 'rate before start'; END IF;
END $$;

-- Constraints on money and rates.
DO $$
BEGIN
  BEGIN
    INSERT INTO exchange_rates (base_currency, quote_currency, rate, effective_date) VALUES ('USD', 'SLE', 0, '2026-01-02');
    RAISE EXCEPTION 'zero rate accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO exchange_rates (base_currency, quote_currency, rate, effective_date) VALUES ('USD', 'SLE', 1, '2026-01-01');
    RAISE EXCEPTION 'duplicate global rate accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO organisations (name, base_currency) VALUES ('Bad', 'usd');
    RAISE EXCEPTION 'lowercase currency accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO users (email, display_name) VALUES ('OWNER@acme.test', 'Dup');
    RAISE EXCEPTION 'case-insensitive duplicate email accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END $$;

-- Tampering is detected. Simulate a superuser bypassing the trigger.
ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update;
UPDATE audit_log SET new_data = jsonb_set(new_data, '{role}', '"owner"')
  WHERE table_name = 'memberships' AND action = 'UPDATE';
ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update;
DO $$
DECLARE broken BIGINT := audit_verify_chain();
BEGIN
  IF broken IS NULL OR broken <> (SELECT id FROM audit_log WHERE table_name = 'memberships' AND action = 'UPDATE') THEN
    RAISE EXCEPTION 'tampering not detected at the right row (got %)', broken;
  END IF;
END $$;

SELECT 'db foundations: all checks passed' AS result;
