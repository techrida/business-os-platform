-- 0081_role_permissions_seeded: mark the grants the seed owns (ADR 0018:42).
--
-- `seeded` is true on a row the seed wrote from the code defaults and false on a row a Founder created or
-- changed in Settings. Reseeding may refresh and remove seeded rows and must never touch the others. Every row
-- that exists today came from the seed (no screen or API has written this table), so all of them become seeded.
-- New rows default to false: the seed sets it explicitly, a Founder edit leaves it false.
-- Additive; the per-tenant loop sets the audit entity the way 0055 does.

ALTER TABLE "app"."role_permissions" ADD COLUMN "seeded" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
DO $$
DECLARE
  target record;
BEGIN
  PERFORM set_config('bos.actor_kind', 'system', true);
  PERFORM set_config('bos.actor_id', 'system:migration-0081', true);
  PERFORM set_config('bos.correlation_id', 'migration-0081:' || gen_random_uuid()::text, true);
  PERFORM set_config('bos.ip', '', true);
  PERFORM set_config('bos.user_agent', '', true);

  FOR target IN
    SELECT org.tenant_id, org.id AS organization_id
    FROM app.organizations org
    WHERE org.is_default
    ORDER BY org.tenant_id
  LOOP
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);
    UPDATE app.role_permissions SET seeded = true
    WHERE tenant_id = target.tenant_id AND NOT seeded;
  END LOOP;
END;
$$;
