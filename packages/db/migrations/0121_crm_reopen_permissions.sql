-- 0121_crm_reopen_permissions: the lead and opportunity reopen permissions (K2).
--
-- crm.lead.reopen and crm.opportunity.reopen are seeded per tenant, and only for tenants that already hold
-- role_permissions rows: a tenant without rows runs on the code defaults, and the grant loader leaves those as soon as
-- one row exists, so a row written here would strip every other role (the rule of 0083 and 0088).
--   * The Founder gets both at scope all on every such tenant.
--   * Every other role that holds crm.lead.write gets crm.lead.reopen, and every other role that holds
--     crm.opportunity.write gets crm.opportunity.reopen, at scope department, whatever the scope of its write. The
--     code still lets only the Founder and that role's managers and heads reopen.
-- A role that already holds a reopen permission keeps its row, whatever its scope. No level row is written, so a
-- tenant whose Settings > Access level rules are materialised is left as its Founder saved it. The authz version
-- moves only for a tenant whose rows changed, so running this again changes nothing.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction, so every write below is recorded as
-- system:migration-0121. bos.organization_id is set per tenant in the loop (role_permissions is tenant-scoped).
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0121', true),
	set_config('bos.correlation_id', 'migration-0121:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

LOCK TABLE app.role_permissions IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  target record;
  changed_rows integer;
  total_rows integer;
BEGIN
  FOR target IN
    SELECT org.tenant_id, org.id AS organization_id
    FROM app.organizations org
    WHERE org.is_default
      AND EXISTS (SELECT 1 FROM app.role_permissions rp WHERE rp.tenant_id = org.tenant_id)
    ORDER BY org.tenant_id
  LOOP
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);

    -- The Founder first, so the department rows below never reach it, even where it holds the write permissions.
    INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
    SELECT target.tenant_id, 'founder', reopen.permission, 'all', true
    FROM (VALUES ('crm.lead.reopen'), ('crm.opportunity.reopen')) AS reopen(permission)
    WHERE NOT EXISTS (
      SELECT 1
      FROM app.role_permissions existing
      WHERE existing.tenant_id = target.tenant_id
        AND existing.role_key = 'founder'
        AND existing.permission = reopen.permission
    )
    ON CONFLICT (tenant_id, role_key, permission) DO NOTHING;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    total_rows := changed_rows;

    INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
    SELECT target.tenant_id, writer.role_key, reopen.permission, 'department', true
    FROM app.role_permissions writer
    JOIN (VALUES
      ('crm.lead.write', 'crm.lead.reopen'),
      ('crm.opportunity.write', 'crm.opportunity.reopen')
    ) AS reopen(write_permission, permission) ON reopen.write_permission = writer.permission
    WHERE writer.tenant_id = target.tenant_id
      AND writer.role_key <> 'founder'
      AND NOT EXISTS (
        SELECT 1
        FROM app.role_permissions existing
        WHERE existing.tenant_id = target.tenant_id
          AND existing.role_key = writer.role_key
          AND existing.permission = reopen.permission
      )
    ON CONFLICT (tenant_id, role_key, permission) DO NOTHING;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    total_rows := total_rows + changed_rows;

    IF total_rows > 0 THEN
      INSERT INTO app.authz_versions (tenant_id, version)
      VALUES (target.tenant_id, 1)
      ON CONFLICT (tenant_id) DO UPDATE
        SET version = app.authz_versions.version + 1, updated_at = now();
    END IF;
  END LOOP;
END;
$$;
