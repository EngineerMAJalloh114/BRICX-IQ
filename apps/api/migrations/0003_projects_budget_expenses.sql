-- BRICX IQ: projects belong to an organisation, have a budget broken into
-- lines, and record expenses in any currency with the exchange rate locked
-- when the expense is entered.
--
-- Ids are generated on the device so rows can be created offline. Rows are
-- soft-deleted through deleted_at so deletions sync. All three tables are
-- audited by the foundation trigger and replicated to devices by PowerSync.

-- ---------------------------------------------------------------------------
-- Shared guards
-- ---------------------------------------------------------------------------

-- The acting user from app.actor_user_id, which the API sets per transaction.
CREATE FUNCTION app_actor() RETURNS UUID LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('app.actor_user_id', true), '')::uuid
$$;

-- Rows are removed by setting deleted_at, never by DELETE, so devices learn
-- about the deletion and the history stays in place.
CREATE FUNCTION forbid_hard_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% rows are soft-deleted: set deleted_at instead', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END $$;

-- Ownership never changes after creation, and a deleted row stays deleted.
CREATE FUNCTION keep_row_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION '% % is deleted and cannot be changed', TG_TABLE_NAME, OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  NEW.id := OLD.id;
  NEW.organisation_id := OLD.organisation_id;
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- Projects: now owned by an organisation. The project's currency is the
-- base currency its budget and spending are reported in; the budget itself
-- is the sum of its budget lines.
-- ---------------------------------------------------------------------------

ALTER TABLE projects
  ADD COLUMN organisation_id UUID NOT NULL REFERENCES organisations (id),
  ADD COLUMN client_name TEXT,
  ADD COLUMN location TEXT,
  ADD COLUMN start_date DATE,
  ADD COLUMN end_date DATE,
  DROP COLUMN budget_minor,
  ADD CONSTRAINT projects_name_not_blank CHECK (length(trim(name)) > 0),
  ADD CONSTRAINT projects_dates_ordered CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date),
  ADD CONSTRAINT projects_org_id_key UNIQUE (organisation_id, id);

ALTER TABLE projects ALTER COLUMN created_by TYPE UUID USING created_by::uuid;
ALTER TABLE projects ADD CONSTRAINT projects_created_by_fkey FOREIGN KEY (created_by) REFERENCES users (id);

-- Keep in sync with PROJECT_STATUSES in packages/shared/src/projects.ts.
ALTER TABLE projects DROP CONSTRAINT projects_status_check;
ALTER TABLE projects ADD CONSTRAINT projects_status_check
  CHECK (status IN ('planning', 'active', 'on_hold', 'completed', 'cancelled'));

CREATE UNIQUE INDEX projects_code_key ON projects (organisation_id, lower(code))
  WHERE deleted_at IS NULL AND code IS NOT NULL;
CREATE INDEX projects_org_idx ON projects (organisation_id);

-- The currency is fixed once the project has budget lines or expenses,
-- because every stored base amount was converted into it.
CREATE FUNCTION projects_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.currency <> OLD.currency AND (
       EXISTS (SELECT 1 FROM budget_lines WHERE project_id = OLD.id)
    OR EXISTS (SELECT 1 FROM expenses WHERE project_id = OLD.id)) THEN
    RAISE EXCEPTION 'project % already has budget lines or expenses; its currency cannot change', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER projects_identity BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION keep_row_identity();
CREATE TRIGGER projects_guard BEFORE UPDATE ON projects
  FOR EACH ROW EXECUTE FUNCTION projects_guard();
CREATE TRIGGER projects_no_delete BEFORE DELETE ON projects
  FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---------------------------------------------------------------------------
-- Budget lines, in the project's currency
-- ---------------------------------------------------------------------------

CREATE TABLE budget_lines (
  id              UUID PRIMARY KEY,
  -- Copied from the project on insert; clients never send it.
  organisation_id UUID NOT NULL,
  project_id      UUID NOT NULL,
  -- Keep in sync with COST_CATEGORIES in packages/shared/src/projects.ts.
  category        TEXT NOT NULL CHECK (category IN
    ('labour', 'materials', 'equipment', 'subcontract', 'overhead', 'contingency', 'other')),
  description     TEXT NOT NULL CHECK (length(trim(description)) > 0),
  amount_minor    BIGINT NOT NULL CHECK (amount_minor >= 0),
  amount_currency currency_code NOT NULL REFERENCES currencies (code),
  created_by      UUID NOT NULL REFERENCES users (id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at      TIMESTAMPTZ,
  -- The composite key stops a line pointing at another organisation's project.
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id),
  UNIQUE (organisation_id, project_id, id)
);

CREATE INDEX budget_lines_project_idx ON budget_lines (project_id);

-- Children take their organisation from their project.
CREATE FUNCTION inherit_project_organisation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  SELECT organisation_id INTO NEW.organisation_id FROM projects WHERE id = NEW.project_id;
  IF NEW.organisation_id IS NULL THEN
    RAISE EXCEPTION 'project % does not exist', NEW.project_id USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE FUNCTION budget_lines_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v_currency currency_code;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.project_id <> OLD.project_id THEN
    RAISE EXCEPTION 'a budget line cannot move to another project'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  SELECT currency INTO v_currency FROM projects WHERE id = NEW.project_id;
  IF NEW.amount_currency <> v_currency THEN
    RAISE EXCEPTION 'budget line must be in the project currency % (got %)', v_currency, NEW.amount_currency
      USING ERRCODE = 'check_violation';
  END IF;
  -- Removing a line that expenses are booked to would silently move that
  -- spending to "not booked to a line".
  IF TG_OP = 'UPDATE' AND NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL
     AND EXISTS (SELECT 1 FROM expenses WHERE budget_line_id = OLD.id AND deleted_at IS NULL) THEN
    RAISE EXCEPTION 'budget line % has expenses booked to it and cannot be deleted', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END $$;

-- BEFORE triggers fire in name order: a_ sets the organisation, b_ protects
-- identity, c_ validates.
CREATE TRIGGER a_budget_lines_org BEFORE INSERT ON budget_lines
  FOR EACH ROW EXECUTE FUNCTION inherit_project_organisation();
CREATE TRIGGER b_budget_lines_identity BEFORE UPDATE ON budget_lines
  FOR EACH ROW EXECUTE FUNCTION keep_row_identity();
CREATE TRIGGER c_budget_lines_guard BEFORE INSERT OR UPDATE ON budget_lines
  FOR EACH ROW EXECUTE FUNCTION budget_lines_guard();
CREATE TRIGGER budget_lines_no_delete BEFORE DELETE ON budget_lines
  FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---------------------------------------------------------------------------
-- Expenses
-- The original amount stays in the currency it was paid in. The rate to the
-- project currency is fixed when the expense is entered and the converted
-- amount is stored next to it, so reports never shift when rates change and
-- an expense entered offline adds up the same after it syncs.
-- ---------------------------------------------------------------------------

CREATE TABLE expenses (
  id                   UUID PRIMARY KEY,
  organisation_id      UUID NOT NULL,
  project_id           UUID NOT NULL,
  budget_line_id       UUID,
  category             TEXT NOT NULL CHECK (category IN
    ('labour', 'materials', 'equipment', 'subcontract', 'overhead', 'contingency', 'other')),
  description          TEXT NOT NULL CHECK (length(trim(description)) > 0),
  vendor               TEXT,
  incurred_on          DATE NOT NULL,
  amount_minor         BIGINT NOT NULL CHECK (amount_minor > 0),
  amount_currency      currency_code NOT NULL REFERENCES currencies (code),
  -- 1 amount_currency = fx_rate base_amount_currency.
  fx_rate              NUMERIC(24, 12) NOT NULL CHECK (fx_rate > 0),
  fx_rate_date         DATE NOT NULL,
  fx_rate_source       TEXT NOT NULL
    CHECK (fx_rate_source IN ('same_currency', 'organisation', 'global', 'manual')),
  fx_manual_reason     TEXT,
  base_amount_minor    BIGINT NOT NULL,
  base_amount_currency currency_code NOT NULL REFERENCES currencies (code),
  -- Keep in sync with EXPENSE_STATUSES in packages/shared/src/expenses.ts.
  status               TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'submitted', 'approved', 'rejected')),
  submitted_at         TIMESTAMPTZ,
  submitted_by         UUID REFERENCES users (id),
  decided_at           TIMESTAMPTZ,
  decided_by           UUID REFERENCES users (id),
  rejection_reason     TEXT,
  created_by           UUID NOT NULL REFERENCES users (id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at           TIMESTAMPTZ,
  FOREIGN KEY (organisation_id, project_id) REFERENCES projects (organisation_id, id),
  FOREIGN KEY (organisation_id, project_id, budget_line_id)
    REFERENCES budget_lines (organisation_id, project_id, id),
  CHECK (fx_rate_source <> 'manual' OR length(trim(coalesce(fx_manual_reason, ''))) > 0),
  CHECK (fx_rate_source <> 'same_currency'
         OR (amount_currency = base_amount_currency AND fx_rate = 1
             AND base_amount_minor = amount_minor)),
  CHECK (status <> 'rejected' OR length(trim(coalesce(rejection_reason, ''))) > 0)
);

CREATE INDEX expenses_project_idx ON expenses (project_id, status);
CREATE INDEX expenses_budget_line_idx ON expenses (budget_line_id);

-- Fields that are frozen once an expense leaves draft.
CREATE FUNCTION expense_content(e expenses) RETURNS JSONB LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_build_object(
    'project_id', e.project_id, 'budget_line_id', e.budget_line_id, 'category', e.category,
    'description', e.description, 'vendor', e.vendor, 'incurred_on', e.incurred_on,
    'amount_minor', e.amount_minor, 'amount_currency', e.amount_currency,
    'fx_rate', e.fx_rate, 'fx_rate_date', e.fx_rate_date, 'fx_rate_source', e.fx_rate_source,
    'fx_manual_reason', e.fx_manual_reason, 'base_amount_minor', e.base_amount_minor,
    'base_amount_currency', e.base_amount_currency)
$$;

CREATE FUNCTION expenses_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_currency currency_code;
  v_shift    INTEGER;
  v_exact    NUMERIC;
  v_actor    UUID := app_actor();
BEGIN
  SELECT currency INTO v_currency FROM projects WHERE id = NEW.project_id;
  IF NEW.base_amount_currency <> v_currency THEN
    RAISE EXCEPTION 'expense base amount must be in the project currency % (got %)',
      v_currency, NEW.base_amount_currency USING ERRCODE = 'check_violation';
  END IF;

  -- The stored base amount must be the original amount at the stored rate,
  -- rounded to the base currency's minor unit.
  SELECT b.minor_units - a.minor_units INTO v_shift
    FROM currencies a, currencies b
    WHERE a.code = NEW.amount_currency AND b.code = NEW.base_amount_currency;
  v_exact := NEW.amount_minor * NEW.fx_rate * power(10::numeric, v_shift);
  IF abs(NEW.base_amount_minor - v_exact) > 0.5 THEN
    RAISE EXCEPTION 'expense base amount % does not match % at rate %',
      NEW.base_amount_minor, NEW.amount_minor, NEW.fx_rate USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.budget_line_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.budget_line_id IS DISTINCT FROM OLD.budget_line_id)
     AND EXISTS (SELECT 1 FROM budget_lines WHERE id = NEW.budget_line_id AND deleted_at IS NOT NULL) THEN
    RAISE EXCEPTION 'budget line % is deleted', NEW.budget_line_id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' THEN
      RAISE EXCEPTION 'expenses are created as drafts' USING ERRCODE = 'check_violation';
    END IF;
    NEW.submitted_at := NULL;
    NEW.submitted_by := NULL;
    NEW.decided_at := NULL;
    NEW.decided_by := NULL;
    NEW.rejection_reason := NULL;
    RETURN NEW;
  END IF;

  IF NEW.project_id <> OLD.project_id THEN
    RAISE EXCEPTION 'an expense cannot move to another project'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- An approved expense is final.
  IF OLD.status = 'approved' AND NEW IS DISTINCT FROM OLD
     AND (expense_content(NEW) IS DISTINCT FROM expense_content(OLD)
          OR NEW.status IS DISTINCT FROM OLD.status
          OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
          OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason) THEN
    RAISE EXCEPTION 'expense % is approved and cannot be changed', OLD.id
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  -- Only drafts can be edited or deleted.
  IF OLD.status <> 'draft' AND (
       expense_content(NEW) IS DISTINCT FROM expense_content(OLD)
    OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at) THEN
    RAISE EXCEPTION 'expense % is % and can only be edited as a draft', OLD.id, OLD.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT (
         (OLD.status = 'draft'     AND NEW.status = 'submitted')
      OR (OLD.status = 'submitted' AND NEW.status IN ('approved', 'rejected', 'draft'))
      OR (OLD.status = 'rejected'  AND NEW.status = 'draft')) THEN
      RAISE EXCEPTION 'expense cannot go from % to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'submitted' THEN
      NEW.submitted_at := now();
      NEW.submitted_by := v_actor;
      NEW.decided_at := NULL;
      NEW.decided_by := NULL;
      NEW.rejection_reason := NULL;
    ELSIF NEW.status IN ('approved', 'rejected') THEN
      -- Segregation of duties: nobody approves or rejects their own claim.
      IF v_actor IS NULL OR v_actor = OLD.submitted_by THEN
        RAISE EXCEPTION 'an expense must be decided by someone other than its submitter'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      NEW.decided_at := now();
      NEW.decided_by := v_actor;
      IF NEW.status = 'approved' THEN
        NEW.rejection_reason := NULL;
      END IF;
    ELSE
      -- Back to draft: withdrawn by the submitter or reopened after rejection.
      NEW.submitted_at := NULL;
      NEW.submitted_by := NULL;
    END IF;
  ELSE
    -- Approval stamps only change with the status.
    NEW.submitted_at := OLD.submitted_at;
    NEW.submitted_by := OLD.submitted_by;
    NEW.decided_at := OLD.decided_at;
    NEW.decided_by := OLD.decided_by;
    IF OLD.status <> 'rejected' OR NEW.rejection_reason IS NULL THEN
      NEW.rejection_reason := OLD.rejection_reason;
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER a_expenses_org BEFORE INSERT ON expenses
  FOR EACH ROW EXECUTE FUNCTION inherit_project_organisation();
CREATE TRIGGER b_expenses_identity BEFORE UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION keep_row_identity();
CREATE TRIGGER c_expenses_guard BEFORE INSERT OR UPDATE ON expenses
  FOR EACH ROW EXECUTE FUNCTION expenses_guard();
CREATE TRIGGER expenses_no_delete BEFORE DELETE ON expenses
  FOR EACH ROW EXECUTE FUNCTION forbid_hard_delete();

-- ---------------------------------------------------------------------------
-- Budget against actual spend, in the project currency.
-- ---------------------------------------------------------------------------

CREATE VIEW project_budget_summary AS
SELECT
  p.organisation_id,
  p.id AS project_id,
  p.currency,
  coalesce((SELECT sum(amount_minor) FROM budget_lines b
            WHERE b.project_id = p.id AND b.deleted_at IS NULL), 0)::bigint AS budget_minor,
  coalesce((SELECT sum(base_amount_minor) FROM expenses e
            WHERE e.project_id = p.id AND e.deleted_at IS NULL AND e.status = 'approved'), 0)::bigint
    AS approved_minor,
  coalesce((SELECT sum(base_amount_minor) FROM expenses e
            WHERE e.project_id = p.id AND e.deleted_at IS NULL AND e.status = 'submitted'), 0)::bigint
    AS pending_minor
FROM projects p
WHERE p.deleted_at IS NULL;

DO $$
BEGIN
  PERFORM audit_table('budget_lines');
  PERFORM audit_table('expenses');
END $$;

-- Devices receive these through PowerSync. Organisations, memberships and
-- exchange rates are read-only on devices: they decide what a user can see
-- and let expenses be converted offline.
ALTER PUBLICATION powersync ADD TABLE budget_lines, expenses, organisations, memberships, exchange_rates;
