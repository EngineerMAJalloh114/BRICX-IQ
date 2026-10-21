CREATE TABLE "bricx"."devices" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"user_id" uuid NOT NULL,
	"platform" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"trusted" boolean DEFAULT false NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "devices_id_v7" CHECK (uuid_extract_version("bricx"."devices"."id") = 7),
	CONSTRAINT "devices_platform" CHECK ("bricx"."devices"."platform" IN ('ios', 'android', 'web')),
	CONSTRAINT "devices_name_length" CHECK (char_length("bricx"."devices"."name") BETWEEN 1 AND 100),
	CONSTRAINT "devices_last_seen" CHECK ("bricx"."devices"."last_seen_at" >= "bricx"."devices"."created_at"),
	CONSTRAINT "devices_revoked" CHECK ("bricx"."devices"."revoked_at" >= "bricx"."devices"."created_at")
);
--> statement-breakpoint
CREATE TABLE "bricx"."sessions" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"device_id" uuid,
	"keycloak_sid" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "sessions_org_sid" UNIQUE("org_id","keycloak_sid"),
	CONSTRAINT "sessions_id_v7" CHECK (uuid_extract_version("bricx"."sessions"."id") = 7),
	CONSTRAINT "sessions_keycloak_sid_length" CHECK (char_length("bricx"."sessions"."keycloak_sid") BETWEEN 1 AND 255),
	CONSTRAINT "sessions_last_seen" CHECK ("bricx"."sessions"."last_seen_at" >= "bricx"."sessions"."created_at"),
	CONSTRAINT "sessions_revoked" CHECK ("bricx"."sessions"."revoked_at" >= "bricx"."sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "bricx"."devices" ADD CONSTRAINT "devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "bricx"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bricx"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "bricx"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bricx"."sessions" ADD CONSTRAINT "sessions_device_id_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "bricx"."devices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "devices_user" ON "bricx"."devices" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "bricx"."sessions" USING btree ("user_id");
--> statement-breakpoint
-- RLS for bricx.devices: user table, own rows (enableOwnedRls, ADR 0063)
ALTER TABLE "bricx"."devices" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."devices" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "devices_self_select" ON "bricx"."devices" AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (user_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "devices_self_insert" ON "bricx"."devices" AS PERMISSIVE FOR INSERT TO bricx_app WITH CHECK (user_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "devices_self_update" ON "bricx"."devices" AS PERMISSIVE FOR UPDATE TO bricx_app USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());
--> statement-breakpoint
REVOKE ALL ON "bricx"."devices" FROM bricx_app, bricx_readonly;
--> statement-breakpoint
GRANT SELECT ON "bricx"."devices" TO bricx_app, bricx_readonly;
--> statement-breakpoint
GRANT INSERT ON "bricx"."devices" TO bricx_app;
--> statement-breakpoint
GRANT UPDATE (name, last_seen_at, revoked_at) ON "bricx"."devices" TO bricx_app;
--> statement-breakpoint
-- RLS for bricx.sessions: resource org.session (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "sessions_select" ON "bricx"."sessions" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "sessions_insert" ON "bricx"."sessions" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "sessions_update" ON "bricx"."sessions" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
-- Own-row policies for bricx.sessions: user_id = app.current_user_id() in any org (enableOwnRowPolicies, ADR 0063)
CREATE POLICY "sessions_own_select" ON "bricx"."sessions" AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (user_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "sessions_own_update" ON "bricx"."sessions" AS PERMISSIVE FOR UPDATE TO bricx_app USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());
--> statement-breakpoint
-- A revocation is final (P5-03, owner condition 1, ADR 0063): once
-- revoked_at is set, no UPDATE clears or moves it, the owner included.
-- Row-level and only on revoked_at: the tenant and own-row policies
-- already decide which rows a role may update at all.
CREATE FUNCTION "bricx"."forbid_unrevoke"() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'revocation is final: revoked_at cannot change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "devices_forbid_unrevoke" BEFORE UPDATE OF revoked_at ON "bricx"."devices" FOR EACH ROW EXECUTE FUNCTION "bricx"."forbid_unrevoke"();
--> statement-breakpoint
CREATE TRIGGER "sessions_forbid_unrevoke" BEFORE UPDATE OF revoked_at ON "bricx"."sessions" FOR EACH ROW EXECUTE FUNCTION "bricx"."forbid_unrevoke"();
--> statement-breakpoint
-- A session's identity never changes (ADR 0063): bricx_app holds a
-- table-level UPDATE (the tenant grant), so the trigger pins id, org_id,
-- user_id, keycloak_sid and created_at; devices pin theirs with a
-- column-level grant instead.
CREATE FUNCTION "bricx"."sessions_immutable"() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.org_id <> OLD.org_id OR NEW.user_id <> OLD.user_id
     OR NEW.keycloak_sid <> OLD.keycloak_sid OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'session identity cannot change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "sessions_immutable" BEFORE UPDATE OF id, org_id, user_id, keycloak_sid, created_at ON "bricx"."sessions" FOR EACH ROW EXECUTE FUNCTION "bricx"."sessions_immutable"();
