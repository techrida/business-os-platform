-- 0178_accountant_record_acceptance: `quotation.record_acceptance` at `all` for the Accountant role (S4-Q2, Kuu
-- 2026-11-21), as DEFAULT_ROLE_PERMISSIONS in packages/contracts now holds it. The Accountant gets the pending-evidence
-- notice of a portal acceptance, and confirming that evidence needs this permission on the quotation. `all`, because
-- the Accountant works across the acting entity and owns no quotation, so `own` would reach nothing.
--
-- Only tenants that already hold role_permissions rows get it: a tenant with none still runs on the code defaults
-- (which now hold the grant), and the grant loader leaves the defaults as soon as one row exists, so a row written
-- there would strip every other role (the 0083 and 0088 rule). The row is `seeded`. An Accountant that already holds
-- the permission keeps its row. The authz version moves once, and only for a tenant that gained the row, so the API's
-- grant cache reloads.
--
-- Runs as bos_owner, in the migrator's one transaction, split at the breakpoint comments (same rule as 0000).

-- set_config(..., true) lasts to the end of the migrator's transaction, so every write below is recorded as
-- system:migration-0178. bos.organization_id is set per tenant in the loop (the grant table is tenant-scoped).
SELECT
	set_config('bos.actor_kind', 'system', true),
	set_config('bos.actor_id', 'system:migration-0178', true),
	set_config('bos.correlation_id', 'migration-0178:' || gen_random_uuid()::text, true),
	set_config('bos.ip', '', true),
	set_config('bos.user_agent', '', true);
--> statement-breakpoint

LOCK TABLE app.role_permissions IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  target record;
  inserted_rows integer;
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
    VALUES (target.tenant_id, 'accountant', 'quotation.record_acceptance', 'all', true)
    ON CONFLICT (tenant_id, role_key, permission) DO NOTHING;
    GET DIAGNOSTICS inserted_rows = ROW_COUNT;

    IF inserted_rows > 0 THEN
      INSERT INTO app.authz_versions (tenant_id, version)
      VALUES (target.tenant_id, 1)
      ON CONFLICT (tenant_id) DO UPDATE
        SET version = app.authz_versions.version + 1, updated_at = now();
    END IF;
  END LOOP;
END;
$$;
