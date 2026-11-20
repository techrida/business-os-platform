-- 0128_email_delivery_resend: resend a failed email from the delivery log (F1-Q15).
--
-- Two changes:
--   * app.outbox.resend_count: how many times someone resent the row. The drainer adds it to the dead-letter
--     notice's dedupe key, so a resent email that fails again tells the Founder again instead of being dropped
--     by the first notice's unique key. Existing rows start at 0, which keeps their current dedupe keys.
--   * email_delivery.read and email_delivery.resend for the Founder, at scope all, seeded, per tenant, and only for
--     tenants that already hold role_permissions rows: a tenant without rows runs on the code defaults (the rule of
--     0083, 0088 and 0120). A Founder row that already exists keeps its scope. No level row is written. The authz
--     version moves only for a tenant whose rows changed, so running this again changes nothing.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction, so every write below is recorded as
-- system:migration-0128. bos.organization_id is set per tenant in the loop (role_permissions is tenant-scoped).
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0128', true),
	set_config('bos.correlation_id', 'migration-0128:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

ALTER TABLE "app"."outbox" ADD COLUMN IF NOT EXISTS "resend_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint

LOCK TABLE app.role_permissions IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  target record;
  changed_rows integer;
BEGIN
  FOR target IN
    SELECT org.tenant_id, org.id AS organization_id
    FROM app.organizations org
    WHERE org.is_default
      AND EXISTS (SELECT 1 FROM app.role_permissions rp WHERE rp.tenant_id = org.tenant_id)
    ORDER BY org.tenant_id
  LOOP
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);

    INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
    SELECT target.tenant_id, 'founder', delivery_grant.permission, 'all', true
    FROM unnest(ARRAY['email_delivery.read', 'email_delivery.resend']) AS delivery_grant(permission)
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.role_permissions existing
      WHERE existing.tenant_id = target.tenant_id
        AND existing.role_key = 'founder'
        AND existing.permission = delivery_grant.permission
    )
    ON CONFLICT (tenant_id, role_key, permission) DO NOTHING;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;

    IF changed_rows > 0 THEN
      INSERT INTO app.authz_versions (tenant_id, version)
      VALUES (target.tenant_id, 1)
      ON CONFLICT (tenant_id) DO UPDATE
        SET version = app.authz_versions.version + 1, updated_at = now();
    END IF;
  END LOOP;
END;
$$;
