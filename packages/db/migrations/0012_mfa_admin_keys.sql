-- P6-05e (ADR 0081; owner conditions C2, C3): MFA for organisation
-- owners and administrators. Hand-written, forward-only.
--
-- app.mfa_admin_keys(): the org-admin catalogue keys, the SQL copy of
-- @bricx/permissions MFA_ADMIN_KEYS (mfa-backfill.int.test.ts compares
-- them live). Plain SQL, IMMUTABLE, owned by bricx_owner, EXECUTE for no
-- one else (mfa_state, SECURITY DEFINER as bricx_owner, calls it).
CREATE FUNCTION "app"."mfa_admin_keys"()
RETURNS text[]
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, pg_temp
RETURN ARRAY[
  'org.access_grant.grant.org',
  'org.access_grant.revoke.org',
  'org.audit.export.org',
  'org.member.invite.org',
  'org.member.remove.org',
  'org.member.update.org',
  'org.organization.archive.org',
  'org.organization.update.org',
  'org.region_config.update.org',
  'org.role.manage.org',
  'org.session.revoke.org',
  'project.member.assign.org',
  'project.member.assign.project',
  'report.dashboard.export.org',
  'report.dashboard.export.project'
]::text[];
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."mfa_admin_keys"() FROM PUBLIC;
--> statement-breakpoint
-- app.mfa_finance_held(p_user): the v2 rule of 0007, unchanged (an open
-- owner membership, a finance.* key in an open org or project membership
-- after overrides, or an open finance.* elevation, in any org).
CREATE FUNCTION "app"."mfa_finance_held"(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT EXISTS (
      SELECT 1
      FROM bricx.memberships m
      JOIN bricx.roles r ON r.org_id = m.org_id AND r.id = m.role_id
      WHERE m.user_id = p_user AND m.removed_at IS NULL
        AND (r.system_key = 'owner'
             OR EXISTS (SELECT 1 FROM bricx.role_permissions rp
                        WHERE rp.role_id = r.id AND rp.revoked_at IS NULL
                          AND rp.permission LIKE 'finance.%'))
    ) OR EXISTS (
      SELECT 1
      FROM bricx.project_memberships pm
      JOIN bricx.roles r ON r.org_id = pm.org_id AND r.id = pm.role_id
      WHERE pm.user_id = p_user AND pm.removed_at IS NULL
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
      WHERE g.user_id = p_user AND g.revoked_at IS NULL AND g.expired_at IS NULL
        AND g.permission LIKE 'finance.%'
    );
END;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."mfa_finance_held"(uuid) FROM PUBLIC;
--> statement-breakpoint
-- app.mfa_admin_held(p_user): the same three places, for an org-admin key
-- (app.mfa_admin_keys()). The owner role holds every one through its
-- system key, which mfa_finance_held already counts.
CREATE FUNCTION "app"."mfa_admin_held"(p_user uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT EXISTS (
      SELECT 1
      FROM bricx.memberships m
      JOIN bricx.role_permissions rp ON rp.org_id = m.org_id AND rp.role_id = m.role_id
      WHERE m.user_id = p_user AND m.removed_at IS NULL AND rp.revoked_at IS NULL
        AND rp.permission = ANY (app.mfa_admin_keys())
    ) OR EXISTS (
      SELECT 1
      FROM bricx.project_memberships pm
      CROSS JOIN LATERAL (
        SELECT rp.permission FROM bricx.role_permissions rp
        WHERE rp.org_id = pm.org_id AND rp.role_id = pm.role_id AND rp.revoked_at IS NULL
        UNION
        SELECT jsonb_array_elements_text(COALESCE(pm.overrides -> 'add', '[]'::jsonb))) AS k(permission)
      WHERE pm.user_id = p_user AND pm.removed_at IS NULL
        AND k.permission = ANY (app.mfa_admin_keys())
        AND NOT (k.permission = ANY (ARRAY(
          SELECT jsonb_array_elements_text(COALESCE(pm.overrides -> 'remove', '[]'::jsonb)))))
    ) OR EXISTS (
      SELECT 1
      FROM bricx.access_grants g
      WHERE g.user_id = p_user AND g.revoked_at IS NULL AND g.expired_at IS NULL
        AND g.permission = ANY (app.mfa_admin_keys())
    );
END;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "app"."mfa_admin_held"(uuid) FROM PUBLIC;
--> statement-breakpoint
-- backfill:begin (C3). One users.mfa_check row per user whose v3 answer is
-- true and v2 answer false: an org-admin key and no finance key or owner
-- role. The selection reads only the two helpers, so a rerun selects the
-- same users; the id is a UUIDv7 derived from the user id (fixed 48-bit
-- time 2026-11-09T00:00:00Z, version 7, variant 10, md5 bits), the relay's
-- BullMQ jobId, and ON CONFLICT (id) DO NOTHING keeps a rerun from adding
-- a row. The org is the user's first open membership, project
-- membership or elevation org (the consumer reads no org).
--
-- Under FORCE RLS bricx_owner has no INSERT policy on bricx.outbox (only
-- bricx_app does, for its own org). This transaction adds two narrow owner
-- policies, both limited to topic users.mfa_check: INSERT, and SELECT
-- (PostgreSQL 18 checks SELECT policies for ON CONFLICT DO NOTHING's
-- arbiter). It inserts and drops both again before COMMIT: no other
-- session ever sees them (CREATE POLICY locks the table until COMMIT),
-- FORCE stays on, no BYPASSRLS role is used. The owner reads the
-- membership tables through its existing SELECT policies (rls-guard
-- OWNER_POLICY_TABLES).
CREATE POLICY "outbox_owner_mfa_backfill" ON "bricx"."outbox" AS PERMISSIVE FOR INSERT TO bricx_owner WITH CHECK (topic = 'users.mfa_check');
--> statement-breakpoint
CREATE POLICY "outbox_owner_mfa_backfill_read" ON "bricx"."outbox" AS PERMISSIVE FOR SELECT TO bricx_owner USING (topic = 'users.mfa_check');
--> statement-breakpoint
INSERT INTO "bricx"."outbox" (id, org_id, topic, payload)
SELECT
  (lpad(to_hex(1794182400000), 12, '0')
     || '7' || substr(h, 2, 3)
     || to_hex(8 + (('x' || substr(h, 5, 1))::bit(4)::int % 4)) || substr(h, 6, 3)
     || substr(h, 9, 12))::uuid,
  o.org_id,
  'users.mfa_check',
  jsonb_build_object('userId', u.id)
FROM bricx.users u
CROSS JOIN LATERAL (SELECT md5('bricx:p6-05e:mfa_check:' || u.id::text) AS h) AS d
CROSS JOIN LATERAL (
  SELECT COALESCE(
    (SELECT m.org_id FROM bricx.memberships m
     WHERE m.user_id = u.id AND m.removed_at IS NULL ORDER BY m.org_id LIMIT 1),
    (SELECT pm.org_id FROM bricx.project_memberships pm
     WHERE pm.user_id = u.id AND pm.removed_at IS NULL ORDER BY pm.org_id LIMIT 1),
    (SELECT g.org_id FROM bricx.access_grants g
     WHERE g.user_id = u.id AND g.revoked_at IS NULL AND g.expired_at IS NULL
     ORDER BY g.org_id LIMIT 1)) AS org_id
) AS o
WHERE app.mfa_admin_held(u.id) AND NOT app.mfa_finance_held(u.id)
ON CONFLICT (id) DO NOTHING;
--> statement-breakpoint
DROP POLICY "outbox_owner_mfa_backfill_read" ON "bricx"."outbox";
--> statement-breakpoint
-- backfill:end
DROP POLICY "outbox_owner_mfa_backfill" ON "bricx"."outbox";
--> statement-breakpoint
-- app.mfa_state() v3 (ADR 0081; amends ADR 0066 and 0067): the v2 rule
-- (now app.mfa_finance_held) or an org-admin key (app.mfa_admin_held).
-- Same signature, owner, volatility, search_path and grants as 0006/0007
-- (EXECUTE bricx_relay only); CREATE OR REPLACE keeps them.
CREATE OR REPLACE FUNCTION "app"."mfa_state"(p_user uuid)
RETURNS TABLE (keycloak_sub text, required boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
BEGIN ATOMIC
  SELECT u.keycloak_sub,
    app.mfa_finance_held(u.id) OR app.mfa_admin_held(u.id) AS required
  FROM bricx.users u
  WHERE u.id = p_user;
END;
