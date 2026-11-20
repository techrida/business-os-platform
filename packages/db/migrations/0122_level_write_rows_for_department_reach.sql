-- 0122_level_write_rows_for_department_reach: a manager or head who sees the department's leads or opportunities
-- through a level row also edits them where the role's switch says so (U20a2-Q9, D50).
--
-- A Settings > Access area switch writes its rows on the see permission and its paired edit permission together
-- (leads: crm.lead.read with crm.lead.write; opportunities: crm.opportunity.read with crm.opportunity.write), for each
-- role it widens. Between the first Access Settings service (d7c87129) and 21d963b6 a save wrote the see rows only and
-- marked the tenant level_rules_materialized, so 0088 (which leaves materialised tenants alone) never added the write
-- rows: there a manager lists the department's leads, Check a person says they can edit them, and every save fails.
--
-- For every tenant with stored role_permissions rows, including materialised ones, each department see row on leads
-- or opportunities gets the matching write row for the same role and level, with the see row's `seeded`, when:
--   * the role holds the write as a base grant below the department (a level row never creates access, and a role
--     already at department or all needs none);
--   * the role is not a lead intake role (finance, accountant, pmo): they hold the write only to start a lead for a
--     Sales owner and never get an edit row (the contracts' LEAD_INTAKE_ROLE_KEYS).
-- This only pairs a switch that is on (no see row, no write row), so a Founder's choice is never undone: the service
-- cannot leave a see row without its write row for such a role. An existing write row at that level is kept,
-- whatever its scope. Clean data gets nothing. The authz version moves only for a tenant whose rows changed.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction, so every write below is recorded as
-- system:migration-0122. bos.organization_id is set per tenant in the loop (both grant tables are tenant-scoped).
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0122', true),
	set_config('bos.correlation_id', 'migration-0122:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

LOCK TABLE app.role_permissions, app.role_permission_levels IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  target record;
  changed_rows integer;
  total_changed integer := 0;
BEGIN
  FOR target IN
    SELECT org.tenant_id, org.id AS organization_id
    FROM app.organizations org
    WHERE org.is_default
      AND EXISTS (SELECT 1 FROM app.role_permissions rp WHERE rp.tenant_id = org.tenant_id)
    ORDER BY org.tenant_id
  LOOP
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);

    INSERT INTO app.role_permission_levels (tenant_id, role_key, permission, min_level, scope, seeded)
    SELECT see.tenant_id, see.role_key, pair.edit_permission, see.min_level, 'department', see.seeded
    FROM app.role_permission_levels see
    JOIN (VALUES
      ('crm.lead.read', 'crm.lead.write'),
      ('crm.opportunity.read', 'crm.opportunity.write')
    ) AS pair(see_permission, edit_permission) ON pair.see_permission = see.permission
    JOIN app.role_permissions base
      ON base.tenant_id = see.tenant_id
      AND base.role_key = see.role_key
      AND base.permission = pair.edit_permission
      AND base.scope NOT IN ('department', 'all')
    WHERE see.tenant_id = target.tenant_id
      AND see.scope = 'department'
      AND see.role_key NOT IN ('finance', 'accountant', 'pmo')
    ORDER BY see.role_key, pair.edit_permission, see.min_level
    ON CONFLICT (tenant_id, role_key, permission, min_level) DO NOTHING;
    GET DIAGNOSTICS changed_rows = ROW_COUNT;

    IF changed_rows > 0 THEN
      total_changed := total_changed + changed_rows;
      INSERT INTO app.authz_versions (tenant_id, version)
      VALUES (target.tenant_id, 1)
      ON CONFLICT (tenant_id) DO UPDATE
        SET version = app.authz_versions.version + 1, updated_at = now();
    END IF;
  END LOOP;

  RAISE NOTICE 'migration-0122: department write rows added beside existing see rows=%', total_changed;
END;
$$;
