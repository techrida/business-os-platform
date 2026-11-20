-- 0123_finance_accountant_read_all_crm: Finance and Accountant read every lead and opportunity again (U20a2-Q4).
--
-- Kuu's answer: Finance and Accountant see everything. 0088 (D50) had narrowed their seeded crm.lead.read and
-- crm.opportunity.read rows from `all` to `own` and seeded department level rows for their managers and heads.
-- This partly reverses D50 for those two roles; PMO keeps its `own` read and its managers and heads keep the
-- department (D51). Every other read the two roles hold is already `all` in the defaults.
--
-- Grants, per tenant, and only for tenants that already hold role_permissions rows (the 0088 rule: a tenant
-- without rows runs on the code defaults, and a row written here would strip every other role):
--   * A seeded Finance or Accountant row on those two reads that is still `own` (what 0088 or the seed wrote)
--     becomes `all`. A row a Founder changed (seeded false), or set to any other scope, is kept.
--   * Their seeded department level rows on those two reads go, but only where the role now reads the department
--     or further, so the row widens nothing (Settings > Access materialises no row there either). A row a Founder
--     made (seeded false) is kept, also on a tenant whose level rules are materialised: there every seeded row
--     matches a default switch, and no row is ever written.
--   * The authz version moves only for a tenant whose rows changed. Running it again changes nothing.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction, so every write below is recorded as
-- system:migration-0123. bos.organization_id is set per tenant in the loop (both grant tables are tenant-scoped).
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0123', true),
	set_config('bos.correlation_id', 'migration-0123:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

LOCK TABLE app.role_permissions, app.role_permission_levels IN SHARE ROW EXCLUSIVE MODE;
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

    UPDATE app.role_permissions existing
    SET scope = read_all_grant.scope
    FROM jsonb_to_recordset('[
      {"role": "finance", "permission": "crm.lead.read", "scope": "all"},
      {"role": "finance", "permission": "crm.opportunity.read", "scope": "all"},
      {"role": "accountant", "permission": "crm.lead.read", "scope": "all"},
      {"role": "accountant", "permission": "crm.opportunity.read", "scope": "all"}
    ]'::jsonb) AS read_all_grant(role text, permission text, scope text)
    WHERE existing.tenant_id = target.tenant_id
      AND existing.seeded
      AND existing.role_key = read_all_grant.role
      AND existing.permission = read_all_grant.permission
      AND existing.scope = 'own';
    GET DIAGNOSTICS changed_rows = ROW_COUNT;
    total_rows := changed_rows;

    -- After the update above, so the base test sees this tenant's grants as they now stand.
    DELETE FROM app.role_permission_levels existing
    USING jsonb_to_recordset('[
      {"role": "finance", "permission": "crm.lead.read", "min_level": "manager", "scope": "department"},
      {"role": "finance", "permission": "crm.lead.read", "min_level": "head", "scope": "department"},
      {"role": "finance", "permission": "crm.opportunity.read", "min_level": "manager", "scope": "department"},
      {"role": "finance", "permission": "crm.opportunity.read", "min_level": "head", "scope": "department"},
      {"role": "accountant", "permission": "crm.lead.read", "min_level": "manager", "scope": "department"},
      {"role": "accountant", "permission": "crm.lead.read", "min_level": "head", "scope": "department"},
      {"role": "accountant", "permission": "crm.opportunity.read", "min_level": "manager", "scope": "department"},
      {"role": "accountant", "permission": "crm.opportunity.read", "min_level": "head", "scope": "department"}
    ]'::jsonb) AS removed_level(role text, permission text, min_level text, scope text)
    WHERE existing.tenant_id = target.tenant_id
      AND existing.seeded
      AND existing.role_key = removed_level.role
      AND existing.permission = removed_level.permission
      AND existing.min_level = removed_level.min_level
      AND existing.scope = removed_level.scope
      AND EXISTS (
        SELECT 1
        FROM app.role_permissions base
        WHERE base.tenant_id = target.tenant_id
          AND base.role_key = removed_level.role
          AND base.permission = removed_level.permission
          AND base.scope IN ('department', 'all')
      );
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
