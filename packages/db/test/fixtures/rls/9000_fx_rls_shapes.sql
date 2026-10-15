CREATE TABLE "bricx"."fx_organization" ("id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, "note" text NOT NULL);
--> statement-breakpoint
-- RLS for bricx.fx_organization: resource org.organization (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."fx_organization" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."fx_organization" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fx_organization_select" ON "bricx"."fx_organization" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (id = app.current_org());
--> statement-breakpoint
CREATE POLICY "fx_organization_insert" ON "bricx"."fx_organization" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (id = app.current_org());
--> statement-breakpoint
CREATE POLICY "fx_organization_update" ON "bricx"."fx_organization" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (id = app.current_org()) WITH CHECK (id = app.current_org());
--> statement-breakpoint
CREATE TABLE "bricx"."fx_org_member" ("id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, "org_id" uuid NOT NULL, "note" text NOT NULL);
--> statement-breakpoint
-- RLS for bricx.fx_org_member: resource org.member (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."fx_org_member" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."fx_org_member" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fx_org_member_select" ON "bricx"."fx_org_member" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "fx_org_member_insert" ON "bricx"."fx_org_member" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "fx_org_member_update" ON "bricx"."fx_org_member" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
CREATE TABLE "bricx"."fx_org_audit" ("id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, "org_id" uuid NOT NULL, "note" text NOT NULL);
--> statement-breakpoint
-- RLS for bricx.fx_org_audit: resource org.audit (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."fx_org_audit" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."fx_org_audit" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fx_org_audit_select" ON "bricx"."fx_org_audit" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "fx_org_audit_insert" ON "bricx"."fx_org_audit" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "bricx"."fx_org_audit" FROM bricx_app;
--> statement-breakpoint
CREATE TABLE "bricx"."fx_project_member" ("id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, "org_id" uuid NOT NULL, "project_id" uuid NOT NULL, "note" text NOT NULL);
--> statement-breakpoint
-- RLS for bricx.fx_project_member: resource project.member (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."fx_project_member" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."fx_project_member" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fx_project_member_select" ON "bricx"."fx_project_member" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org() AND app.has_project(project_id));
--> statement-breakpoint
CREATE POLICY "fx_project_member_insert" ON "bricx"."fx_project_member" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org() AND app.has_project(project_id));
--> statement-breakpoint
CREATE POLICY "fx_project_member_update" ON "bricx"."fx_project_member" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (org_id = app.current_org() AND app.has_project(project_id)) WITH CHECK (org_id = app.current_org() AND app.has_project(project_id));
--> statement-breakpoint
CREATE TABLE "bricx"."fx_project_task" ("id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, "org_id" uuid NOT NULL, "project_id" uuid NOT NULL, "site_id" uuid NOT NULL, "created_by" uuid NOT NULL, "note" text NOT NULL);
--> statement-breakpoint
-- RLS for bricx.fx_project_task: resource project.task (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."fx_project_task" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."fx_project_task" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fx_project_task_select" ON "bricx"."fx_project_task" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org() AND app.has_project(project_id));
--> statement-breakpoint
CREATE POLICY "fx_project_task_insert" ON "bricx"."fx_project_task" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org() AND app.has_project(project_id) AND created_by = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "fx_project_task_update" ON "bricx"."fx_project_task" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (org_id = app.current_org() AND app.has_project(project_id)) WITH CHECK (org_id = app.current_org() AND app.has_project(project_id));
--> statement-breakpoint
CREATE TABLE "bricx"."fx_project" ("id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL, "org_id" uuid NOT NULL, "created_by" uuid NOT NULL, "note" text NOT NULL);
--> statement-breakpoint
-- RLS for bricx.fx_project: resource project.project (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."fx_project" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."fx_project" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "fx_project_select" ON "bricx"."fx_project" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org() AND app.has_project(id));
--> statement-breakpoint
CREATE POLICY "fx_project_insert" ON "bricx"."fx_project" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org() AND created_by = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "fx_project_update" ON "bricx"."fx_project" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (org_id = app.current_org() AND app.has_project(id)) WITH CHECK (org_id = app.current_org() AND app.has_project(id));
