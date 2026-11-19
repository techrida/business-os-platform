-- 0083_marketing_role: the Marketing role's default grants (D50).
--
-- Marketing creates, reads (own), qualifies and hands off leads, and has no quotation, customer or opportunity
-- grant. Same grants as `DEFAULT_ROLE_PERMISSIONS.marketing` in packages/contracts: the kernel staff base (own
-- memos, documents and request reads) plus own crm.lead.read and crm.lead.write. Rows are `seeded`. A tenant
-- that already holds a marketing row for a permission keeps it. The authz version moves only for tenants that
-- gained a row. Only tenants that already have role_permissions rows get them: a tenant with none is still on
-- the code defaults (which hold marketing), and the grant loader leaves them as soon as one row exists, so
-- inserting here would strip every other role of its grants. The role key itself is a contracts and dev-identity matter; nothing here touches an identity
-- provider.

DO $$
DECLARE
  target record;
  inserted_rows integer;
BEGIN
  PERFORM set_config('bos.actor_kind', 'system', true);
  PERFORM set_config('bos.actor_id', 'system:migration-0083', true);
  PERFORM set_config('bos.correlation_id', 'migration-0083:' || gen_random_uuid()::text, true);
  PERFORM set_config('bos.ip', '', true);
  PERFORM set_config('bos.user_agent', '', true);

  FOR target IN
    SELECT org.tenant_id, org.id AS organization_id
    FROM app.organizations org
    WHERE org.is_default
      AND EXISTS (SELECT 1 FROM app.role_permissions rp WHERE rp.tenant_id = org.tenant_id)
    ORDER BY org.tenant_id
  LOOP
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);

    INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
    SELECT target.tenant_id, 'marketing', grants.permission, grants.scope, true
    FROM (VALUES
      ('memo.create', 'own'),
      ('memo.update', 'own'),
      ('memo.read', 'own'),
      ('documents.upload', 'own'),
      ('documents.read', 'own'),
      ('approvals.requests.read', 'own'),
      ('crm.lead.read', 'own'),
      ('crm.lead.write', 'own')
    ) AS grants(permission, scope)
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
