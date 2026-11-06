-- P6-01 (ADR 0071): the global directory. Hand-written (the directory has
-- no Drizzle schema), applied by migrateDirectory() as directory_owner in
-- database bricx_directory, never in a cell database.
--
-- cells: one row per region cell (deployment data, written by
-- directory_owner; runbook M-05). Cell ids have the AWS region shape.
CREATE TABLE directory.cells (
  id text PRIMARY KEY
    CONSTRAINT cells_id_shape CHECK (id ~ '^[a-z]{2}(-[a-z]+)+-[0-9]+$' AND length(id) <= 32),
  -- An origin: http(s), host[:port], no path, credentials, query or fragment.
  api_base_url text NOT NULL
    CONSTRAINT cells_api_base_url_shape CHECK (api_base_url ~ '^https?://[a-z0-9.-]+(:[0-9]{1,5})?$' AND length(api_base_url) <= 255),
  -- A Keycloak issuer URL: an origin plus a path, no credentials, query or fragment.
  keycloak_url text NOT NULL
    CONSTRAINT cells_keycloak_url_shape CHECK (keycloak_url ~ '^https?://[a-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*$' AND length(keycloak_url) <= 255),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- org_directory: an organisation's reservation of its slug and its cell
-- (registerOrganization, P6-02 calls it before the cell commits; C2).
CREATE TABLE directory.org_directory (
  org_id uuid PRIMARY KEY,
  org_slug text NOT NULL
    CONSTRAINT org_directory_org_slug_key UNIQUE
    CONSTRAINT org_directory_org_slug_shape CHECK (org_slug ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
  cell_id text NOT NULL REFERENCES directory.cells (id),
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- org_email_domains: a verified e-mail domain routes to its organisation.
-- verified_at is NOT NULL, so no unverified domain can route (C3). No
-- function writes this table in P6-01; DNS TXT verification and the
-- free-mail denylist come first (P6-02, P6-06). Lower-case ASCII labels
-- (punycode for internationalised names), at least two, at most 253
-- characters, no trailing dot.
CREATE TABLE directory.org_email_domains (
  domain text PRIMARY KEY
    CONSTRAINT org_email_domains_domain_shape CHECK (
      domain ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
      AND length(domain) <= 253),
  org_id uuid NOT NULL REFERENCES directory.org_directory (org_id),
  verified_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX org_email_domains_org_id_idx ON directory.org_email_domains (org_id);
--> statement-breakpoint
-- An organisation's region is fixed at creation (ADR 0020): its id and its
-- cell never change, for any role (a trigger binds the owner and the
-- superuser too). SQLSTATE P6001.
CREATE FUNCTION directory.org_directory_immutable() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.cell_id IS DISTINCT FROM OLD.cell_id THEN
    RAISE EXCEPTION 'an organisation''s id and cell never change'
      USING ERRCODE = 'P6001';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER org_directory_immutable
  BEFORE UPDATE ON directory.org_directory
  FOR EACH ROW EXECUTE FUNCTION directory.org_directory_immutable();
--> statement-breakpoint
-- RLS on every table, FORCE included (the owner too), with one policy per
-- role and command: a privilege granted by mistake still shows no row.
ALTER TABLE directory.cells ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE directory.cells FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE directory.org_directory ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE directory.org_directory FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE directory.org_email_domains ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE directory.org_email_domains FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
-- directory_owner: everything (cells rows, test seeds, P6-02's release).
CREATE POLICY owner_all ON directory.cells TO directory_owner
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY owner_all ON directory.org_directory TO directory_owner
  USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY owner_all ON directory.org_email_domains TO directory_owner
  USING (true) WITH CHECK (true);
--> statement-breakpoint
-- directory_reader: SELECT only, every row (the routing data is public by
-- design; ADR 0071 C5).
CREATE POLICY reader_select ON directory.cells FOR SELECT TO directory_reader
  USING (true);
--> statement-breakpoint
CREATE POLICY reader_select ON directory.org_directory FOR SELECT TO directory_reader
  USING (true);
--> statement-breakpoint
CREATE POLICY reader_select ON directory.org_email_domains FOR SELECT TO directory_reader
  USING (true);
--> statement-breakpoint
GRANT SELECT ON directory.cells, directory.org_directory, directory.org_email_domains
  TO directory_reader;
--> statement-breakpoint
-- directory_writer: INSERT on org_directory and the SELECT its conflict
-- check reads (who holds this org id or this slug); nothing else.
CREATE POLICY writer_insert ON directory.org_directory FOR INSERT TO directory_writer
  WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY writer_select ON directory.org_directory FOR SELECT TO directory_writer
  USING (true);
--> statement-breakpoint
GRANT SELECT, INSERT ON directory.org_directory TO directory_writer;
