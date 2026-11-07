CREATE TABLE "bricx"."region_configs" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"project_id" uuid,
	"currency" text,
	"reporting_currency" text,
	"language" text,
	"timezone" text,
	"format_locale" text,
	"units" text,
	"tax_profile_id" text,
	"payment_adapters" text[],
	"accounting_adapter" text,
	"rate_library" text,
	"session_idle_seconds" integer,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "region_configs_layer" UNIQUE NULLS NOT DISTINCT("org_id","project_id"),
	CONSTRAINT "region_configs_id_v7" CHECK (uuid_extract_version("bricx"."region_configs"."id") = 7),
	CONSTRAINT "region_configs_org_columns" CHECK ("bricx"."region_configs"."project_id" IS NOT NULL OR ("bricx"."region_configs"."currency" IS NULL AND "bricx"."region_configs"."language" IS NULL AND "bricx"."region_configs"."timezone" IS NULL AND "bricx"."region_configs"."units" IS NULL)),
	CONSTRAINT "region_configs_project_idle" CHECK ("bricx"."region_configs"."project_id" IS NULL OR "bricx"."region_configs"."session_idle_seconds" IS NULL),
	CONSTRAINT "region_configs_currency" CHECK ("bricx"."region_configs"."currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "region_configs_reporting_currency" CHECK ("bricx"."region_configs"."reporting_currency" ~ '^[A-Z]{3}$'),
	CONSTRAINT "region_configs_language" CHECK ("bricx"."region_configs"."language" ~ '^[a-z]{2,3}(-[A-Z][a-z]{3})?(-[A-Z]{2})?$'),
	CONSTRAINT "region_configs_timezone" CHECK ("bricx"."region_configs"."timezone" ~ '^[A-Za-z0-9_+/-]{1,64}$'),
	CONSTRAINT "region_configs_format_locale" CHECK ("bricx"."region_configs"."format_locale" ~ '^[A-Za-z0-9]{1,8}(-[A-Za-z0-9]{1,8})*$' AND char_length("bricx"."region_configs"."format_locale") <= 35),
	CONSTRAINT "region_configs_units" CHECK ("bricx"."region_configs"."units" IN ('metric', 'us_customary')),
	CONSTRAINT "region_configs_tax_profile_id" CHECK ("bricx"."region_configs"."tax_profile_id" ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "region_configs_payment_adapters" CHECK (cardinality("bricx"."region_configs"."payment_adapters") <= 16 AND (cardinality("bricx"."region_configs"."payment_adapters") = 0 OR array_ndims("bricx"."region_configs"."payment_adapters") = 1) AND array_position("bricx"."region_configs"."payment_adapters", NULL) IS NULL AND array_to_string("bricx"."region_configs"."payment_adapters", ',') ~ '^([a-z][a-z0-9_]{1,62}(,[a-z][a-z0-9_]{1,62})*)?$'),
	CONSTRAINT "region_configs_accounting_adapter" CHECK ("bricx"."region_configs"."accounting_adapter" ~ '^[a-z][a-z0-9_]{1,62}$'),
	CONSTRAINT "region_configs_rate_library" CHECK ("bricx"."region_configs"."rate_library" ~ '^[a-z0-9][a-z0-9_.-]{0,63}$'),
	CONSTRAINT "region_configs_session_idle_seconds" CHECK ("bricx"."region_configs"."session_idle_seconds" BETWEEN 60 AND 43200),
	CONSTRAINT "region_configs_updated" CHECK ("bricx"."region_configs"."updated_at" >= "bricx"."region_configs"."created_at")
);
--> statement-breakpoint
ALTER TABLE "bricx"."region_configs" ADD CONSTRAINT "region_configs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "bricx"."organizations"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- RLS for bricx.region_configs: resource org.region_config (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."region_configs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."region_configs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "region_configs_select" ON "bricx"."region_configs" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "region_configs_insert" ON "bricx"."region_configs" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "region_configs_update" ON "bricx"."region_configs" AS PERMISSIVE FOR UPDATE TO bricx_owner, bricx_app USING (org_id = app.current_org()) WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
-- bricx_app may UPDATE only the listed columns of bricx.region_configs (restrictTenantUpdate, ADR 0067)
REVOKE UPDATE ON "bricx"."region_configs" FROM bricx_app;
--> statement-breakpoint
GRANT UPDATE (currency, reporting_currency, language, timezone, format_locale, units, tax_profile_id, payment_adapters, accounting_adapter, rate_library, session_idle_seconds, updated_at) ON "bricx"."region_configs" TO bricx_app;
