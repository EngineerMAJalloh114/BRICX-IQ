CREATE TABLE "bricx"."audit_events" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"org_id" uuid NOT NULL,
	"seq" bigint NOT NULL,
	"hash_version" smallint NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"device_id" uuid,
	"ip" "inet",
	"geo" jsonb,
	"correlation_id" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"before" jsonb,
	"after" jsonb,
	"prev_hash" "bytea" NOT NULL,
	"hash" "bytea" NOT NULL,
	CONSTRAINT "audit_events_org_seq" UNIQUE("org_id","seq"),
	CONSTRAINT "audit_events_seq" CHECK ("bricx"."audit_events"."seq" >= 1),
	CONSTRAINT "audit_events_hash_version" CHECK ("bricx"."audit_events"."hash_version" >= 1),
	CONSTRAINT "audit_events_occurred_at_ms" CHECK ("bricx"."audit_events"."occurred_at" = date_trunc('milliseconds', "bricx"."audit_events"."occurred_at")),
	CONSTRAINT "audit_events_actor" CHECK ("bricx"."audit_events"."actor_type" IN ('user', 'system') AND ("bricx"."audit_events"."actor_type" <> 'user' OR "bricx"."audit_events"."actor_id" IS NOT NULL)),
	CONSTRAINT "audit_events_ip_host" CHECK (masklen("bricx"."audit_events"."ip") = CASE family("bricx"."audit_events"."ip") WHEN 4 THEN 32 ELSE 128 END),
	CONSTRAINT "audit_events_hash_length" CHECK (octet_length("bricx"."audit_events"."prev_hash") = 32 AND octet_length("bricx"."audit_events"."hash") = 32)
);

--> statement-breakpoint
-- RLS for bricx.audit_events: resource org.audit (pnpm db:rls, ADR 0054)
ALTER TABLE "bricx"."audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_events_select" ON "bricx"."audit_events" AS PERMISSIVE FOR SELECT TO bricx_owner, bricx_app, bricx_readonly USING (org_id = app.current_org());
--> statement-breakpoint
CREATE POLICY "audit_events_insert" ON "bricx"."audit_events" AS PERMISSIVE FOR INSERT TO bricx_owner, bricx_app WITH CHECK (org_id = app.current_org());
--> statement-breakpoint
REVOKE UPDATE, DELETE ON "bricx"."audit_events" FROM bricx_app;
--> statement-breakpoint
-- Append-only for every role, the owner included (P4-05, ADR 0055, D13).
-- Statement-level: under FORCE RLS bricx_owner sees no rows without a
-- context, so a row-level trigger would never fire for its UPDATE or
-- DELETE. A statement trigger fires even when no row matches.
CREATE FUNCTION "bricx"."append_only"() RETURNS trigger
  LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  RAISE EXCEPTION 'append-only table: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER "audit_events_no_update_delete" BEFORE UPDATE OR DELETE ON "bricx"."audit_events" FOR EACH STATEMENT EXECUTE FUNCTION "bricx"."append_only"();
--> statement-breakpoint
CREATE TRIGGER "audit_events_no_truncate" BEFORE TRUNCATE ON "bricx"."audit_events" FOR EACH STATEMENT EXECUTE FUNCTION "bricx"."append_only"();
