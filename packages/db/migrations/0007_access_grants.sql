CREATE TABLE "bricx"."access_grants" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"scope_id" uuid,
	"reason" text NOT NULL,
	"granted_by" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoked_by" uuid,
	"expired_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "access_grants_id_v7" CHECK (uuid_extract_version("bricx"."access_grants"."id") = 7),
	CONSTRAINT "access_grants_permission" CHECK ("bricx"."access_grants"."permission" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.(org|project|site|own)$' AND char_length("bricx"."access_grants"."permission") <= 72),
	CONSTRAINT "access_grants_reason_length" CHECK (char_length("bricx"."access_grants"."reason") BETWEEN 1 AND 500),
	CONSTRAINT "access_grants_not_self" CHECK ("bricx"."access_grants"."granted_by" <> "bricx"."access_grants"."user_id"),
	CONSTRAINT "access_grants_window" CHECK ("bricx"."access_grants"."starts_at" < "bricx"."access_grants"."expires_at" AND "bricx"."access_grants"."expires_at" - "bricx"."access_grants"."starts_at" BETWEEN interval '60 seconds' AND interval '30 days'),
	CONSTRAINT "access_grants_revoked" CHECK (("bricx"."access_grants"."revoked_at" IS NULL) = ("bricx"."access_grants"."revoked_by" IS NULL) AND "bricx"."access_grants"."revoked_at" >= "bricx"."access_grants"."created_at"),
	CONSTRAINT "access_grants_expired" CHECK ("bricx"."access_grants"."expired_at" >= "bricx"."access_grants"."expires_at"),
	CONSTRAINT "access_grants_one_end" CHECK ("bricx"."access_grants"."revoked_at" IS NULL OR "bricx"."access_grants"."expired_at" IS NULL)
);
--> statement-breakpoint
ALTER TABLE "bricx"."outbox" ADD COLUMN "not_before" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bricx"."access_grants" ADD CONSTRAINT "access_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "bricx"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bricx"."access_grants" ADD CONSTRAINT "access_grants_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "bricx"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bricx"."access_grants" ADD CONSTRAINT "access_grants_revoked_by_users_id_fk" FOREIGN KEY ("revoked_by") REFERENCES "bricx"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_grants_user_open" ON "bricx"."access_grants" USING btree ("org_id","user_id") WHERE "bricx"."access_grants"."revoked_at" IS NULL AND "bricx"."access_grants"."expired_at" IS NULL;--> statement-breakpoint
CREATE INDEX "access_grants_due" ON "bricx"."access_grants" USING btree ("expires_at") WHERE "bricx"."access_grants"."revoked_at" IS NULL AND "bricx"."access_grants"."expired_at" IS NULL;--> statement-breakpoint
-- RLS for bricx.access_grants: resource org.access_grant (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."access_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."access_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "access_grants_select" ON "bricx"."access_grants" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "access_grants_insert" ON "bricx"."access_grants" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "access_grants_update" ON "bricx"."access_grants" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
-- Own-row policies for bricx.access_grants: user_id = app.current_user_id() in any org (enableOwnRowPolicies, ADR 0063)
CREATE POLICY "access_grants_own_select" ON "bricx"."access_grants" AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (user_id = app.current_user_id());
--> statement-breakpoint
-- Owner read policy for bricx.access_grants: every row, for app.mfa_state() (enableOwnerReadPolicy, ADR 0066; listed in OWNER_POLICY_TABLES)
CREATE POLICY "access_grants_owner_select" ON "bricx"."access_grants" AS PERMISSIVE FOR SELECT TO bricx_owner USING (true);
--> statement-breakpoint
-- The outbox's not_before (P5-06, D-G, ADR 0067; amends ADR 0056): bricx_app
-- may set it on INSERT, with the four columns of 0002; the relay reads it
-- through its SELECT on the whole row and publishes the row at once as a
-- delayed job. Nobody updates it.
GRANT INSERT (not_before) ON "bricx"."outbox" TO bricx_app;
--> statement-breakpoint
-- app.mfa_state() v2 (P5-06, D-F, owner condition 2, ADR 0067; amends ADR
-- 0066): the 0006 body, plus a finance.* elevation that is not revoked and
-- not expired (expired_at NULL), a future starts_at included: the realm
-- role is mapped before the window opens, so the first elevated request
-- already needs MFA; the expiry job's users.mfa_check clears it. Same
-- signature, owner, volatility, search_path and grants as 0006 (EXECUTE
-- bricx_relay only); CREATE OR REPLACE keeps them.
CREATE OR REPLACE FUNCTION "app"."mfa_state"(p_user uuid)
RETURNS TABLE (keycloak_sub text, required boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT u.keycloak_sub,
    EXISTS (
      SELECT 1
      FROM bricx.memberships m
      JOIN bricx.roles r ON r.org_id = m.org_id AND r.id = m.role_id
      WHERE m.user_id = u.id AND m.removed_at IS NULL
        AND (r.system_key = 'owner'
             OR EXISTS (SELECT 1 FROM bricx.role_permissions rp
                        WHERE rp.role_id = r.id AND rp.revoked_at IS NULL
                          AND rp.permission LIKE 'finance.%'))
    ) OR EXISTS (
      SELECT 1
      FROM bricx.project_memberships pm
      JOIN bricx.roles r ON r.org_id = pm.org_id AND r.id = pm.role_id
      WHERE pm.user_id = u.id AND pm.removed_at IS NULL
        AND (r.system_key = 'owner'
             OR EXISTS (
               SELECT 1
               FROM (SELECT rp.permission FROM bricx.role_permissions rp
                     WHERE rp.role_id = r.id AND rp.revoked_at IS NULL
                     UNION
                     SELECT jsonb_array_elements_text(COALESCE(pm.overrides -> 'add', '[]'::jsonb))) AS k(permission)
               WHERE k.permission LIKE 'finance.%'
                 AND NOT (k.permission = ANY (ARRAY(
                   SELECT jsonb_array_elements_text(COALESCE(pm.overrides -> 'remove', '[]'::jsonb)))))))
    ) OR EXISTS (
      SELECT 1
      FROM bricx.access_grants g
      WHERE g.user_id = u.id AND g.revoked_at IS NULL AND g.expired_at IS NULL
        AND g.permission LIKE 'finance.%'
    ) AS required
  FROM bricx.users u
  WHERE u.id = p_user;
END;
--> statement-breakpoint
-- app.access_grants_due() (P5-06, D-G, owner condition 4, ADR 0067): the
-- 5-minute sweep's cross-org read of open elevations past expires_at
-- (oldest first, at most p_limit, 1000 at most), for the worker's expiry
-- consumer, which then expires each one as bricx_app in the grant's org
-- (the audit event through the shared recorder, the users.mfa_check row).
-- The function writes nothing. SECURITY DEFINER as bricx_owner, reading
-- through the owner read policy above; EXECUTE for bricx_relay only, as
-- app.mfa_state(). Messages name no value.
CREATE FUNCTION "app"."access_grants_due"(p_limit integer)
RETURNS TABLE (id uuid, org_id uuid, user_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT g.id, g.org_id, g.user_id
  FROM bricx.access_grants g
  WHERE g.revoked_at IS NULL AND g.expired_at IS NULL AND g.expires_at <= now()
  ORDER BY g.expires_at, g.id
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 0), 0), 1000);
END;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."access_grants_due"(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."access_grants_due"(integer) TO bricx_relay;
--> statement-breakpoint
-- bricx_app may UPDATE only the listed columns of bricx.access_grants (restrictTenantUpdate, ADR 0067)
REVOKE UPDATE ON "bricx"."access_grants" FROM bricx_app;
--> statement-breakpoint
GRANT UPDATE (revoked_at, revoked_by, expired_at) ON "bricx"."access_grants" TO bricx_app;
--> statement-breakpoint
-- An elevation's row is a record (PR #71 review, amendment 1, ADR 0067;
-- the pattern of 0005's sessions_immutable and forbid_unrevoke): every
-- column but the three end columns is fixed for every role, the
-- superuser included; revoked_at/revoked_by and expired_at are set once,
-- on an open row only (no un-revoke, no un-expire, no second end, never
-- both). A column UPDATE that keeps a value passes. Messages name no
-- value. SECURITY INVOKER: the trigger reads only OLD and NEW.
CREATE FUNCTION "bricx"."access_grants_immutable"() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.permission IS DISTINCT FROM OLD.permission
     OR NEW.scope_id IS DISTINCT FROM OLD.scope_id
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.granted_by IS DISTINCT FROM OLD.granted_by
     OR NEW.starts_at IS DISTINCT FROM OLD.starts_at
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an access grant is immutable but for its end'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
      OR NEW.revoked_by IS DISTINCT FROM OLD.revoked_by
      OR NEW.expired_at IS DISTINCT FROM OLD.expired_at)
     AND (OLD.revoked_at IS NOT NULL OR OLD.revoked_by IS NOT NULL
          OR OLD.expired_at IS NOT NULL
          OR (NEW.revoked_at IS NOT NULL AND NEW.expired_at IS NOT NULL)) THEN
    RAISE EXCEPTION 'an access grant ends once'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "access_grants_immutable" BEFORE UPDATE ON "bricx"."access_grants" FOR EACH ROW EXECUTE FUNCTION "bricx"."access_grants_immutable"();
