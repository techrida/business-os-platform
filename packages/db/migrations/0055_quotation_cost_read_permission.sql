-- D29a: the internal cost and margin of a quotation are shown only to a role holding `quotation.cost.read`.
-- Give it, at scope all, to every role that today drafts or approves quotations (`quotation.draft` or
-- `approvals.requests.act`), which is the same rule the code defaults follow. A role an admin has already
-- customised to hold neither gains nothing, and a role that already holds it is left alone.
LOCK TABLE app.role_permissions IN SHARE ROW EXCLUSIVE MODE;
--> statement-breakpoint
DO $$
DECLARE
  target record;
  inserted_rows integer;
BEGIN
  PERFORM set_config('bos.actor_kind', 'system', true);
  PERFORM set_config('bos.actor_id', 'system:migration-0055', true);
  PERFORM set_config('bos.correlation_id', 'migration-0055:' || gen_random_uuid()::text, true);
  PERFORM set_config('bos.ip', '', true);
  PERFORM set_config('bos.user_agent', '', true);

  FOR target IN
    SELECT org.tenant_id, org.id AS organization_id
    FROM app.organizations org
    WHERE org.is_default
    ORDER BY org.tenant_id
  LOOP
    PERFORM set_config('bos.organization_id', target.organization_id::text, true);

    INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope)
    SELECT DISTINCT grant_row.tenant_id, grant_row.role_key, 'quotation.cost.read'::text, 'all'::text
    FROM app.role_permissions grant_row
    WHERE grant_row.tenant_id = target.tenant_id
      AND grant_row.permission IN ('quotation.draft', 'approvals.requests.act')
      AND NOT EXISTS (
        SELECT 1
        FROM app.role_permissions existing
        WHERE existing.tenant_id = grant_row.tenant_id
          AND existing.role_key = grant_row.role_key
          AND existing.permission = 'quotation.cost.read'
      );
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
