-- Give the new grant only to a Sales role that still has the exact previous defaults.
-- A missing, extra or modified grant is treated as a tenant policy and is left alone.
LOCK TABLE app.role_permissions IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  target record;
  legacy_sales constant jsonb := '{
    "memo.create": "own",
    "memo.update": "own",
    "memo.read": "own",
    "documents.upload": "own",
    "documents.read": "own",
    "approvals.requests.read": "own",
    "crm.lead.read": "own",
    "crm.lead.write": "own",
    "crm.opportunity.read": "own",
    "crm.opportunity.write": "own",
    "customer.read": "all",
    "customer.write": "all",
    "quotation.read": "own",
    "quotation.draft": "own",
    "quotation.submit": "own",
    "quotation.send": "own",
    "quotation.record_acceptance": "own",
    "quotation.revise": "own",
    "verification.read": "own"
  }';
BEGIN
  PERFORM set_config('bos.actor_kind', 'system', true);
  PERFORM set_config('bos.actor_id', 'system:migration-0044', true);
  PERFORM set_config('bos.correlation_id', 'migration-0044:' || gen_random_uuid()::text, true);
  PERFORM set_config('bos.ip', '', true);
  PERFORM set_config('bos.user_agent', '', true);

  FOR target IN
    SELECT org.tenant_id, org.id AS organization_id
    FROM app.organizations org
    JOIN app.role_permissions grant_row ON grant_row.tenant_id = org.tenant_id
    WHERE org.is_default AND grant_row.role_key = 'sales'
    GROUP BY org.tenant_id, org.id
    HAVING jsonb_object_agg(grant_row.permission, grant_row.scope) = legacy_sales
    ORDER BY org.tenant_id
  LOOP
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);

    INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope)
    VALUES (target.tenant_id, 'sales', 'sales_order.read', 'own');

    INSERT INTO app.authz_versions (tenant_id, version)
    VALUES (target.tenant_id, 1)
    ON CONFLICT (tenant_id) DO UPDATE
      SET version = app.authz_versions.version + 1, updated_at = now();
  END LOOP;
END;
$$;
