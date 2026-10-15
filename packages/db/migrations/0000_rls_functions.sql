-- P4-04 (ADR 0054): the RLS primitives every tenant policy calls, over the
-- transaction settings withTx() sets (ADR 0053). SQL, STABLE, PARALLEL
-- SAFE, SECURITY INVOKER, no SET clause. NULLIF on every setting: after the
-- transaction that set it, a setting reads '' for the rest of the session,
-- and ''::uuid would fail with 22P02. Unset or empty means NULL (no org, no
-- user) and has_project() false, so every policy denies.
CREATE FUNCTION app.current_org() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER
BEGIN ATOMIC
  SELECT NULLIF(current_setting('app.org_id', true), '')::uuid;
END;
--> statement-breakpoint
CREATE FUNCTION app.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER
BEGIN ATOMIC
  SELECT NULLIF(current_setting('app.user_id', true), '')::uuid;
END;
--> statement-breakpoint
CREATE FUNCTION app.has_project(project uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER
BEGIN ATOMIC
  SELECT COALESCE(
    project = ANY (NULLIF(current_setting('app.project_ids', true), '')::uuid[]),
    false
  );
END;
--> statement-breakpoint
-- The bootstrap revokes EXECUTE from PUBLIC on every function bricx_owner
-- creates; only the roles that run under RLS may call these.
GRANT EXECUTE ON FUNCTION app.current_org(), app.current_user_id(), app.has_project(uuid)
  TO bricx_app, bricx_readonly;
