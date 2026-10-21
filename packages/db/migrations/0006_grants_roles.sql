CREATE TABLE "bricx"."memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "memberships_id_v7" CHECK (uuid_extract_version("bricx"."memberships"."id") = 7),
	CONSTRAINT "memberships_removed" CHECK ("bricx"."memberships"."removed_at" >= "bricx"."memberships"."created_at")
);
--> statement-breakpoint
CREATE TABLE "bricx"."project_memberships" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "project_memberships_id_v7" CHECK (uuid_extract_version("bricx"."project_memberships"."id") = 7),
	CONSTRAINT "project_memberships_overrides" CHECK (jsonb_typeof("bricx"."project_memberships"."overrides") = 'object' AND octet_length("bricx"."project_memberships"."overrides"::text) <= 4096 AND ("bricx"."project_memberships"."overrides" - 'add' - 'remove') = '{}'::jsonb AND (NOT "bricx"."project_memberships"."overrides" ? 'add' OR jsonb_typeof("bricx"."project_memberships"."overrides" -> 'add') = 'array') AND (NOT "bricx"."project_memberships"."overrides" ? 'remove' OR jsonb_typeof("bricx"."project_memberships"."overrides" -> 'remove') = 'array')),
	CONSTRAINT "project_memberships_removed" CHECK ("bricx"."project_memberships"."removed_at" >= "bricx"."project_memberships"."created_at")
);
--> statement-breakpoint
CREATE TABLE "bricx"."role_permissions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"permission" text NOT NULL,
	"granted_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "role_permissions_id_v7" CHECK (uuid_extract_version("bricx"."role_permissions"."id") = 7),
	CONSTRAINT "role_permissions_permission" CHECK ("bricx"."role_permissions"."permission" ~ '^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*\.(org|project|site|own)$' AND char_length("bricx"."role_permissions"."permission") <= 72),
	CONSTRAINT "role_permissions_revoked" CHECK ("bricx"."role_permissions"."revoked_at" >= "bricx"."role_permissions"."granted_at")
);
--> statement-breakpoint
CREATE TABLE "bricx"."roles" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"system_key" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "roles_org_id" UNIQUE("org_id","id"),
	CONSTRAINT "roles_id_v7" CHECK (uuid_extract_version("bricx"."roles"."id") = 7),
	CONSTRAINT "roles_key" CHECK ("bricx"."roles"."key" ~ '^[a-z][a-z0-9_]{0,63}$'),
	CONSTRAINT "roles_name_length" CHECK (char_length("bricx"."roles"."name") BETWEEN 1 AND 100),
	CONSTRAINT "roles_system_key" CHECK ("bricx"."roles"."system_key" IN ('owner', 'project_owner', 'project_manager', 'quantity_surveyor', 'site_engineer', 'foreman', 'storekeeper', 'accountant', 'client', 'consultant', 'subcontractor', 'auditor')),
	CONSTRAINT "roles_updated" CHECK ("bricx"."roles"."updated_at" >= "bricx"."roles"."created_at"),
	CONSTRAINT "roles_archived" CHECK ("bricx"."roles"."archived_at" >= "bricx"."roles"."created_at")
);
--> statement-breakpoint
ALTER TABLE "bricx"."memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "bricx"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bricx"."memberships" ADD CONSTRAINT "memberships_role_fk" FOREIGN KEY ("org_id","role_id") REFERENCES "bricx"."roles"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bricx"."project_memberships" ADD CONSTRAINT "project_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "bricx"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bricx"."project_memberships" ADD CONSTRAINT "project_memberships_role_fk" FOREIGN KEY ("org_id","role_id") REFERENCES "bricx"."roles"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bricx"."role_permissions" ADD CONSTRAINT "role_permissions_role_fk" FOREIGN KEY ("org_id","role_id") REFERENCES "bricx"."roles"("org_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_open" ON "bricx"."memberships" USING btree ("org_id","user_id") WHERE "bricx"."memberships"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "project_memberships_open" ON "bricx"."project_memberships" USING btree ("org_id","project_id","user_id") WHERE "bricx"."project_memberships"."removed_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "role_permissions_open" ON "bricx"."role_permissions" USING btree ("role_id","permission") WHERE "bricx"."role_permissions"."revoked_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_open_key" ON "bricx"."roles" USING btree ("org_id","key") WHERE "bricx"."roles"."archived_at" IS NULL;
--> statement-breakpoint
-- RLS for bricx.roles: resource org.role (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."roles" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."roles" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "roles_select" ON "bricx"."roles" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "roles_insert" ON "bricx"."roles" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "roles_update" ON "bricx"."roles" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
-- Owner read policy for bricx.roles: every row, for app.mfa_state() (enableOwnerReadPolicy, ADR 0066; listed in OWNER_POLICY_TABLES)
CREATE POLICY "roles_owner_select" ON "bricx"."roles" AS PERMISSIVE FOR SELECT TO bricx_owner USING (true);
--> statement-breakpoint
-- RLS for bricx.role_permissions: resource org.role (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."role_permissions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."role_permissions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "role_permissions_select" ON "bricx"."role_permissions" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "role_permissions_insert" ON "bricx"."role_permissions" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "role_permissions_update" ON "bricx"."role_permissions" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
-- Owner read policy for bricx.role_permissions: every row, for app.mfa_state() (enableOwnerReadPolicy, ADR 0066; listed in OWNER_POLICY_TABLES)
CREATE POLICY "role_permissions_owner_select" ON "bricx"."role_permissions" AS PERMISSIVE FOR SELECT TO bricx_owner USING (true);
--> statement-breakpoint
-- RLS for bricx.memberships: resource org.member (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "memberships_select" ON "bricx"."memberships" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "memberships_insert" ON "bricx"."memberships" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "memberships_update" ON "bricx"."memberships" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
-- Own-row policies for bricx.memberships: user_id = app.current_user_id() in any org (enableOwnRowPolicies, ADR 0063)
CREATE POLICY "memberships_own_select" ON "bricx"."memberships" AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (user_id = app.current_user_id());
--> statement-breakpoint
-- Owner read policy for bricx.memberships: every row, for app.mfa_state() (enableOwnerReadPolicy, ADR 0066; listed in OWNER_POLICY_TABLES)
CREATE POLICY "memberships_owner_select" ON "bricx"."memberships" AS PERMISSIVE FOR SELECT TO bricx_owner USING (true);
--> statement-breakpoint
-- RLS for bricx.project_memberships: resource project.member (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."project_memberships" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."project_memberships" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "project_memberships_select" ON "bricx"."project_memberships" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org() AND app.has_project(project_id));
--> statement-breakpoint
CREATE POLICY "project_memberships_insert" ON "bricx"."project_memberships" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org() AND app.has_project(project_id));
--> statement-breakpoint
CREATE POLICY "project_memberships_update" ON "bricx"."project_memberships" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (org_id = app.current_org() AND app.has_project(project_id)) WITH CHECK (org_id = app.current_org() AND app.has_project(project_id));
--> statement-breakpoint
-- Own-row policies for bricx.project_memberships: user_id = app.current_user_id() in any org (enableOwnRowPolicies, ADR 0063)
CREATE POLICY "project_memberships_own_select" ON "bricx"."project_memberships" AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (user_id = app.current_user_id());
--> statement-breakpoint
-- Owner read policy for bricx.project_memberships: every row, for app.mfa_state() (enableOwnerReadPolicy, ADR 0066; listed in OWNER_POLICY_TABLES)
CREATE POLICY "project_memberships_owner_select" ON "bricx"."project_memberships" AS PERMISSIVE FOR SELECT TO bricx_owner USING (true);
--> statement-breakpoint
-- app.has_project() (P5-05, owner condition 2, ADR 0066; amends ADR 0054):
-- app.project_ids = '*' means every project of the org. withTx() sets it
-- only from its typed allProjects option, which DbGrantsSource alone
-- produces (an org-scoped grant on a project-level resource); a '*' inside
-- a list is not an array literal, so it can never read as the wildcard.
-- With '*' the project-level RLS backstop is reduced to the org: the API's
-- ability check is the only project filter for that identity (stated in
-- ADR 0054's amendment). NULL is never a project. Same signature, language,
-- volatility and grants as 0000_rls_functions.
CREATE OR REPLACE FUNCTION app.has_project(project uuid) RETURNS boolean
  LANGUAGE sql STABLE PARALLEL SAFE SECURITY INVOKER
BEGIN ATOMIC
  SELECT CASE
    WHEN project IS NULL THEN false
    WHEN current_setting('app.project_ids', true) = '*' THEN true
    ELSE COALESCE(
      project = ANY (NULLIF(current_setting('app.project_ids', true), '')::uuid[]),
      false
    )
  END;
END;
--> statement-breakpoint
-- app.mfa_state() (P5-05, phase ruling D5, owner condition 1, ADR 0066):
-- the user's Keycloak subject and whether MFA is required: any open org or
-- project membership, in any org, whose effective keys hold a finance.*
-- key. A role with system_key 'owner' is the code's ROLES.owner bundle
-- (which holds finance keys; it takes no overrides); otherwise the role's
-- open role_permissions, plus a project membership's overrides->'add'
-- minus overrides->'remove'. SECURITY DEFINER as bricx_owner, which reads
-- the four tables through the owner read policies above (OWNER_POLICY_TABLES);
-- EXECUTE for bricx_relay only (the worker's MFA consumer, withRelayTx()):
-- the API computes its own answer from org-scoped reads. No row for an
-- unknown user. Messages name no value.
CREATE FUNCTION "app"."mfa_state"(p_user uuid)
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
    ) AS required
  FROM bricx.users u
  WHERE u.id = p_user;
END;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."mfa_state"(uuid) FROM PUBLIC;
--> statement-breakpoint
-- bricx_relay reaches schema app for this one function (the bootstrap
-- grants USAGE to bricx_app and bricx_readonly only); every other app
-- function keeps its own grants, none of them to bricx_relay.
GRANT USAGE ON SCHEMA "app" TO bricx_relay;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."mfa_state"(uuid) TO bricx_relay;
