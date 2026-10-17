CREATE TABLE "bricx"."idempotency_keys" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"route" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" "bytea" NOT NULL,
	"status" smallint NOT NULL,
	"response" text,
	"headers" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + make_interval(secs => 86400) NOT NULL,
	CONSTRAINT "idempotency_keys_scope" UNIQUE("org_id","user_id","route","key"),
	CONSTRAINT "idempotency_keys_key" CHECK ("bricx"."idempotency_keys"."key" ~ '^[A-Za-z0-9._~-]{1,255}$'),
	CONSTRAINT "idempotency_keys_route" CHECK ("bricx"."idempotency_keys"."route" ~ '^[A-Z]{3,10} /[!"$->@-~]*$' AND octet_length("bricx"."idempotency_keys"."route") <= 2059),
	CONSTRAINT "idempotency_keys_hash_length" CHECK (octet_length("bricx"."idempotency_keys"."request_hash") = 32),
	CONSTRAINT "idempotency_keys_status" CHECK ("bricx"."idempotency_keys"."status" BETWEEN 100 AND 599),
	CONSTRAINT "idempotency_keys_response_size" CHECK (octet_length("bricx"."idempotency_keys"."response") <= 262144),
	CONSTRAINT "idempotency_keys_complete" CHECK (("bricx"."idempotency_keys"."response" IS NULL) = ("bricx"."idempotency_keys"."headers" IS NULL)),
	CONSTRAINT "idempotency_keys_headers_object" CHECK (jsonb_typeof("bricx"."idempotency_keys"."headers") = 'object'),
	CONSTRAINT "idempotency_keys_expiry" CHECK ("bricx"."idempotency_keys"."expires_at" > "bricx"."idempotency_keys"."created_at")
);

--> statement-breakpoint
-- RLS for bricx.idempotency_keys: system tenant table (enableIdempotencyRls, ADR 0057)
ALTER TABLE "bricx"."idempotency_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."idempotency_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "idempotency_keys_app_select" ON "bricx"."idempotency_keys" AS PERMISSIVE FOR SELECT TO bricx_app USING (org_id = app.current_org() AND user_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "idempotency_keys_app_insert" ON "bricx"."idempotency_keys" AS PERMISSIVE FOR INSERT TO bricx_app WITH CHECK (org_id = app.current_org() AND user_id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "idempotency_keys_app_update" ON "bricx"."idempotency_keys" AS PERMISSIVE FOR UPDATE TO bricx_app USING (org_id = app.current_org() AND user_id = app.current_user_id()) WITH CHECK (org_id = app.current_org() AND user_id = app.current_user_id());
--> statement-breakpoint
REVOKE ALL ON "bricx"."idempotency_keys" FROM bricx_app, bricx_readonly;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "bricx"."idempotency_keys" TO bricx_app;
