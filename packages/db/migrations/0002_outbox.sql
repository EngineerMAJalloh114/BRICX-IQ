CREATE TABLE "bricx"."outbox" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_error" text,
	"dead_at" timestamp with time zone,
	CONSTRAINT "outbox_topic" CHECK ("bricx"."outbox"."topic" ~ '^[a-z][a-z0-9_.]{0,62}$'),
	CONSTRAINT "outbox_attempts" CHECK ("bricx"."outbox"."attempts" >= 0),
	CONSTRAINT "outbox_published_or_dead" CHECK (NOT ("bricx"."outbox"."published_at" IS NOT NULL AND "bricx"."outbox"."dead_at" IS NOT NULL)),
	CONSTRAINT "outbox_last_error_code" CHECK ("bricx"."outbox"."last_error" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE INDEX "outbox_pending" ON "bricx"."outbox" USING btree ("created_at","id") WHERE "bricx"."outbox"."published_at" IS NULL AND "bricx"."outbox"."dead_at" IS NULL;
--> statement-breakpoint
-- RLS for bricx.outbox: system tenant table (enableOutboxRls, ADR 0056)
ALTER TABLE "bricx"."outbox" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."outbox" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "outbox_app_insert" ON "bricx"."outbox" AS PERMISSIVE FOR INSERT TO bricx_app WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "outbox_relay_select" ON "bricx"."outbox" AS PERMISSIVE FOR SELECT TO bricx_relay USING (true);
--> statement-breakpoint
CREATE POLICY "outbox_relay_update" ON "bricx"."outbox" AS PERMISSIVE FOR UPDATE TO bricx_relay USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE ALL ON "bricx"."outbox" FROM bricx_app, bricx_readonly;
--> statement-breakpoint
GRANT INSERT (id, org_id, topic, payload) ON "bricx"."outbox" TO bricx_app;
--> statement-breakpoint
GRANT SELECT ON "bricx"."outbox" TO bricx_relay;
--> statement-breakpoint
GRANT UPDATE (published_at, attempts, next_attempt_at, last_error, dead_at) ON "bricx"."outbox" TO bricx_relay;
