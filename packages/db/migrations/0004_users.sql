CREATE TABLE "bricx"."users" (
	"id" uuid PRIMARY KEY DEFAULT uuidv7() NOT NULL,
	"keycloak_sub" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	CONSTRAINT "users_keycloak_sub" UNIQUE("keycloak_sub"),
	CONSTRAINT "users_id_v7" CHECK (uuid_extract_version("bricx"."users"."id") = 7),
	CONSTRAINT "users_keycloak_sub_length" CHECK (char_length("bricx"."users"."keycloak_sub") BETWEEN 1 AND 255),
	CONSTRAINT "users_last_seen" CHECK ("bricx"."users"."last_seen_at" >= "bricx"."users"."created_at")
);

--> statement-breakpoint
-- RLS for bricx.users: user table, own-row reads (enableUsersRls, ADR 0062)
ALTER TABLE "bricx"."users" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "bricx"."users" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "users_self_select" ON "bricx"."users" AS PERMISSIVE FOR SELECT TO bricx_app, bricx_readonly USING (id = app.current_user_id());
--> statement-breakpoint
CREATE POLICY "users_owner_select" ON "bricx"."users" AS PERMISSIVE FOR SELECT TO bricx_owner USING (true);
--> statement-breakpoint
CREATE POLICY "users_owner_insert" ON "bricx"."users" AS PERMISSIVE FOR INSERT TO bricx_owner WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY "users_owner_update" ON "bricx"."users" AS PERMISSIVE FOR UPDATE TO bricx_owner USING (true) WITH CHECK (true);
--> statement-breakpoint
REVOKE ALL ON "bricx"."users" FROM bricx_app, bricx_readonly;
--> statement-breakpoint
GRANT SELECT ON "bricx"."users" TO bricx_app, bricx_readonly;
--> statement-breakpoint
-- app.provision_user() (P5-02, phase ruling D8, owner conditions 2 and 3, ADR 0062):
-- the only writer of bricx.users. Called by bricx_app inside withTx(), whose
-- context carries the request's org hint and a fresh UUIDv7 candidate as
-- app.user_id. A new sub inserts that candidate; a known sub keeps its id and
-- created_at, and only last_seen_at moves forward, at most once per
-- p_throttle_seconds. Returns the user's id either way. Messages name no value.
CREATE FUNCTION "app"."provision_user"(p_sub text, p_now timestamptz, p_throttle_seconds integer)
RETURNS uuid
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_candidate uuid := app.current_user_id();
  v_id uuid;
BEGIN
  IF v_candidate IS NULL THEN
    RAISE EXCEPTION 'provision_user: no user in the context' USING ERRCODE = '22023';
  END IF;
  IF p_sub IS NULL OR char_length(p_sub) NOT BETWEEN 1 AND 255 THEN
    RAISE EXCEPTION 'provision_user: invalid sub' USING ERRCODE = '22023';
  END IF;
  IF p_now IS NULL OR p_throttle_seconds IS NULL OR p_throttle_seconds NOT BETWEEN 0 AND 86400 THEN
    RAISE EXCEPTION 'provision_user: invalid time or throttle' USING ERRCODE = '22023';
  END IF;
  INSERT INTO bricx.users AS u (id, keycloak_sub, created_at, last_seen_at)
  VALUES (v_candidate, p_sub, p_now, p_now)
  ON CONFLICT (keycloak_sub) DO UPDATE
    SET last_seen_at = excluded.last_seen_at
    WHERE u.last_seen_at <= excluded.last_seen_at - make_interval(secs => p_throttle_seconds)
  RETURNING u.id INTO v_id;
  IF v_id IS NULL THEN
    SELECT u.id INTO v_id FROM bricx.users AS u WHERE u.keycloak_sub = p_sub;
  END IF;
  RETURN v_id;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."provision_user"(text, timestamptz, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION "app"."provision_user"(text, timestamptz, integer) TO bricx_app;
