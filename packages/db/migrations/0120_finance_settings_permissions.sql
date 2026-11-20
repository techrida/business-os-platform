-- 0120_finance_settings_permissions: the finance settings permissions (K3).
--
-- Two permissions take finance settings out of admin.settings.write, which stays Founder-only for everything else:
--   * settings.fx_rate.write: Finance writes exchange rates.
--   * settings.finance.write: Finance and Accountant write the tax.* and numbering.* settings, the number series and
--     the Terms page (term presets and default term sets).
-- Both are granted at scope all, seeded, per tenant, and only for tenants that already hold role_permissions rows: a
-- tenant without rows runs on the code defaults, and the grant loader leaves those as soon as one row exists, so a
-- row written here would strip every other role (the rule of 0083 and 0088). A role that already holds either
-- permission keeps its row, whatever its scope. No level row is written, so a tenant whose Settings > Access level
-- rules are materialised is left as its Founder saved it. The authz version moves only for a tenant whose rows
-- changed, so running this again changes nothing.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction, so every write below is recorded as
-- system:migration-0120. bos.organization_id is set per tenant in the loop (role_permissions is tenant-scoped).
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0120', true),
	set_config('bos.correlation_id', 'migration-0120:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
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
    SELECT target.tenant_id, finance_grant.role, finance_grant.permission, finance_grant.scope, true
    FROM jsonb_to_recordset('[
      {"role": "finance", "permission": "settings.fx_rate.write", "scope": "all"},
      {"role": "finance", "permission": "settings.finance.write", "scope": "all"},
      {"role": "accountant", "permission": "settings.finance.write", "scope": "all"}
    ]'::jsonb) AS finance_grant(role text, permission text, scope text)
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.role_permissions existing
      WHERE existing.tenant_id = target.tenant_id
        AND existing.role_key = finance_grant.role
        AND existing.permission = finance_grant.permission
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
