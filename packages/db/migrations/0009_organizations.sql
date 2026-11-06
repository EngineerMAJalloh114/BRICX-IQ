CREATE TABLE "bricx"."org_create_attempts" (
	"user_id" uuid NOT NULL,
	"key_hash" "bytea" NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"settled_at" timestamp with time zone,
	CONSTRAINT "org_create_attempts_pkey" PRIMARY KEY("user_id","key_hash"),
	CONSTRAINT "org_create_attempts_org_id" UNIQUE("org_id"),
	CONSTRAINT "org_create_attempts_org_id_v7" CHECK (uuid_extract_version("bricx"."org_create_attempts"."org_id") = 7),
	CONSTRAINT "org_create_attempts_hash_length" CHECK (octet_length("bricx"."org_create_attempts"."key_hash") = 32 AND octet_length("bricx"."org_create_attempts"."request_hash") = 32),
	CONSTRAINT "org_create_attempts_slug_shape" CHECK ("bricx"."org_create_attempts"."slug" ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
	CONSTRAINT "org_create_attempts_state" CHECK ("bricx"."org_create_attempts"."state" IN ('pending', 'committed', 'refused')),
	CONSTRAINT "org_create_attempts_settled" CHECK (("bricx"."org_create_attempts"."state" = 'pending') = ("bricx"."org_create_attempts"."settled_at" IS NULL) AND "bricx"."org_create_attempts"."settled_at" >= "bricx"."org_create_attempts"."created_at")
);
--> statement-breakpoint
CREATE TABLE "bricx"."organizations" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"slug" text NOT NULL,
	"legal_name" text NOT NULL,
	"country" text NOT NULL,
	"default_currency" text NOT NULL,
	"default_language" text NOT NULL,
	"timezone" text NOT NULL,
	"units" text NOT NULL,
	"data_region" text NOT NULL,
	"brand_color" text,
	"logo_object_key" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	CONSTRAINT "organizations_slug" UNIQUE("slug"),
	CONSTRAINT "organizations_id_v7" CHECK (uuid_extract_version("bricx"."organizations"."id") = 7),
	CONSTRAINT "organizations_slug_shape" CHECK ("bricx"."organizations"."slug" ~ '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$'),
	CONSTRAINT "organizations_legal_name_length" CHECK (char_length("bricx"."organizations"."legal_name") BETWEEN 1 AND 200),
	CONSTRAINT "organizations_country" CHECK ("bricx"."organizations"."country" ~ '^[A-Z]{2}$'),
	CONSTRAINT "organizations_default_currency" CHECK ("bricx"."organizations"."default_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "organizations_default_language" CHECK ("bricx"."organizations"."default_language" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'),
	CONSTRAINT "organizations_timezone" CHECK ("bricx"."organizations"."timezone" ~ '^[A-Za-z0-9_+/-]{1,64}$'),
	CONSTRAINT "organizations_units" CHECK ("bricx"."organizations"."units" IN ('metric', 'us_customary')),
	CONSTRAINT "organizations_data_region" CHECK ("bricx"."organizations"."data_region" ~ '^[a-z]{2}(-[a-z]+)+-[0-9]+$' AND char_length("bricx"."organizations"."data_region") <= 32),
	CONSTRAINT "organizations_brand_color" CHECK ("bricx"."organizations"."brand_color" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "organizations_logo_object_key" CHECK (char_length("bricx"."organizations"."logo_object_key") BETWEEN 1 AND 1024),
	CONSTRAINT "organizations_updated" CHECK ("bricx"."organizations"."updated_at" >= "bricx"."organizations"."created_at"),
	CONSTRAINT "organizations_archived" CHECK ("bricx"."organizations"."archived_at" >= "bricx"."organizations"."created_at")
);
--> statement-breakpoint
ALTER TABLE "bricx"."org_create_attempts" ADD CONSTRAINT "org_create_attempts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "bricx"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bricx"."memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "bricx"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bricx"."roles" ADD CONSTRAINT "roles_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "bricx"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- RLS for bricx.organizations: resource org.organization (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."organizations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."organizations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organizations_select" ON "bricx"."organizations" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (id = app.current_org());
--> statement-breakpoint
CREATE POLICY "organizations_insert" ON "bricx"."organizations" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (id = app.current_org());
--> statement-breakpoint
CREATE POLICY "organizations_update" ON "bricx"."organizations" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (id = app.current_org()) WITH CHECK (id = app.current_org());
--> statement-breakpoint
-- bricx_app may UPDATE only the listed columns of bricx.organizations (restrictTenantUpdate, ADR 0067)
REVOKE UPDATE ON "bricx"."organizations" FROM bricx_app;
--> statement-breakpoint
GRANT UPDATE (legal_name, country, default_currency, default_language, timezone, units, brand_color, logo_object_key, updated_at, archived_at) ON "bricx"."organizations" TO bricx_app;
--> statement-breakpoint
-- RLS for bricx.org_create_attempts: user table, own rows (enableOwnedRls, ADR 0063)
ALTER TABLE "bricx"."org_create_attempts" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."org_create_attempts" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "org_create_attempts_self_select" ON "bricx"."org_create_attempts" AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (user_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "org_create_attempts_self_insert" ON "bricx"."org_create_attempts" AS PERMISSIVE FOR INSERT TO bricx_app WITH CHECK (user_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "org_create_attempts_self_update" ON "bricx"."org_create_attempts" AS PERMISSIVE FOR UPDATE TO bricx_app USING (user_id = app.current_user_id()) WITH CHECK (user_id = app.current_user_id());
--> statement-breakpoint
REVOKE ALL ON "bricx"."org_create_attempts" FROM bricx_app, bricx_readonly;
--> statement-breakpoint
GRANT SELECT ON "bricx"."org_create_attempts" TO bricx_app, bricx_readonly;
--> statement-breakpoint
GRANT INSERT ON "bricx"."org_create_attempts" TO bricx_app;
--> statement-breakpoint
GRANT UPDATE (state, settled_at) ON "bricx"."org_create_attempts" TO bricx_app;
--> statement-breakpoint
-- An organisation's identity and region never change, for any role (P6-02,
-- ADR 0072; the owner and the superuser included): id, slug, data_region and
-- created_at are fixed at insert; archived_at is set once and never
-- cleared. SQLSTATE P6002. Messages name no value.
CREATE FUNCTION "bricx"."organizations_immutable"() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.data_region IS DISTINCT FROM OLD.data_region
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'an organisation''s id, slug, region and creation time never change'
      USING ERRCODE = 'P6002';
  END IF;
  IF OLD.archived_at IS NOT NULL
     AND NEW.archived_at IS DISTINCT FROM OLD.archived_at THEN
    RAISE EXCEPTION 'an archived organisation stays archived'
      USING ERRCODE = 'P6002';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "organizations_immutable" BEFORE UPDATE ON "bricx"."organizations" FOR EACH ROW EXECUTE FUNCTION "bricx"."organizations_immutable"();
--> statement-breakpoint
-- A create attempt settles once (P6-02, ADR 0072, owner ruling R4): state
-- moves from pending to committed or refused with settled_at, and nothing
-- else ever changes, for any role. SQLSTATE P6003.
CREATE FUNCTION "bricx"."org_create_attempts_transition"() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.key_hash IS DISTINCT FROM OLD.key_hash
     OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
     OR NEW.org_id IS DISTINCT FROM OLD.org_id
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.state <> 'pending'
     OR NEW.state NOT IN ('committed', 'refused') THEN
    RAISE EXCEPTION 'a create attempt settles once, from pending'
      USING ERRCODE = 'P6003';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER "org_create_attempts_transition" BEFORE UPDATE ON "bricx"."org_create_attempts" FOR EACH ROW EXECUTE FUNCTION "bricx"."org_create_attempts_transition"();
