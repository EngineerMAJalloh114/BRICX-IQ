CREATE TABLE projects (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  code text,
  currency char(3) NOT NULL,
  budget_minor bigint NOT NULL DEFAULT 0 CHECK (budget_minor >= 0),
  status text NOT NULL DEFAULT 'planning'
    CHECK (status IN ('planning', 'active', 'on_hold', 'completed')),
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Rows are never hard-deleted so history stays auditable.
  deleted_at timestamptz
);

-- Append-only record of every change made through the API.
CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  table_name text NOT NULL,
  row_id uuid NOT NULL,
  before jsonb,
  after jsonb
);

CREATE INDEX audit_log_row_idx ON audit_log (table_name, row_id);

CREATE FUNCTION audit_log_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$;

CREATE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_is_append_only();

-- PowerSync streams changes to devices through logical replication.
CREATE PUBLICATION powersync FOR TABLE projects;
